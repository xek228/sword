// Tiny pure-JS forward pass for the swing classifier.
//
// The model is a 1D CNN trained in PyTorch (see ml/train.py) and exported
// as JSON. We re-implement just enough Conv1d / MaxPool1d / Dense /
// Softmax to evaluate it against a 60Hz window of IMU data.
//
// All inputs/outputs are plain Float32Array. No tensor library required.

import fs from "node:fs";
import path from "node:path";

let cached = null;

export function loadModel(jsonPath) {
  const txt = fs.readFileSync(jsonPath, "utf8");
  const m = JSON.parse(txt);
  m.layers.forEach((l) => {
    if (l.weight) l.weight = floatTensor(l.weight);
    if (l.bias)   l.bias   = Float32Array.from(l.bias);
  });
  cached = m;
  return m;
}

export function getModel() { return cached; }

export function tryLoadDefault() {
  if (cached) return cached;
  const candidates = [
    path.resolve(process.cwd(), "public/model.json"),
    path.resolve(process.cwd(), "model.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { return loadModel(c); }
      catch (e) { console.warn("[swingModel] failed to load", c, e.message); }
    }
  }
  return null;
}

function floatTensor(arr) {
  // Recursive: leaves become Float32Array, branches stay arrays.
  if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "number") {
    return Float32Array.from(arr);
  }
  return arr.map(floatTensor);
}

// ---------------------------------------------------------------------------
// Layers. All operate on (channels, time) shape, stored as a flat
// Float32Array of length channels*time, row-major (channel-major).

function conv1d(x, T, layer) {
  const { weight, bias, kernel, padding } = layer;
  const inC  = layer.in;
  const outC = layer.out;
  const padded = new Float32Array(inC * (T + 2 * padding));
  // copy x into the padded buffer (offset=padding within each channel)
  for (let c = 0; c < inC; c++) {
    padded.set(x.subarray(c * T, (c + 1) * T), c * (T + 2 * padding) + padding);
  }
  const Tp = T + 2 * padding;
  const Tout = T;  // padding=k//2 so output length matches input
  const out = new Float32Array(outC * Tout);
  // weight shape (PyTorch): (outC, inC, kernel)
  for (let oc = 0; oc < outC; oc++) {
    const wOC = weight[oc]; // shape (inC, kernel)
    const b = bias[oc];
    for (let t = 0; t < Tout; t++) {
      let acc = b;
      for (let ic = 0; ic < inC; ic++) {
        const wic = wOC[ic]; // Float32Array of length kernel
        const padCh = padded.subarray(ic * Tp, (ic + 1) * Tp);
        for (let k = 0; k < kernel; k++) {
          acc += wic[k] * padCh[t + k];
        }
      }
      out[oc * Tout + t] = acc;
    }
  }
  return out;
}

function relu(x) {
  for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0;
  return x;
}

function maxpool1d(x, C, T, kernel) {
  const Tout = Math.floor(T / kernel);
  const out = new Float32Array(C * Tout);
  for (let c = 0; c < C; c++) {
    for (let t = 0; t < Tout; t++) {
      let m = -Infinity;
      for (let k = 0; k < kernel; k++) {
        const v = x[c * T + t * kernel + k];
        if (v > m) m = v;
      }
      out[c * Tout + t] = m;
    }
  }
  return out;
}

function globalAvgPool(x, C, T) {
  const out = new Float32Array(C);
  for (let c = 0; c < C; c++) {
    let s = 0;
    for (let t = 0; t < T; t++) s += x[c * T + t];
    out[c] = s / T;
  }
  return out;
}

function dense(x, layer) {
  const { weight, bias } = layer;
  const inN = layer.in, outN = layer.out;
  const out = new Float32Array(outN);
  for (let o = 0; o < outN; o++) {
    let acc = bias[o];
    const w = weight[o];
    for (let i = 0; i < inN; i++) acc += w[i] * x[i];
    out[o] = acc;
  }
  return out;
}

function softmax(x) {
  let m = -Infinity;
  for (let i = 0; i < x.length; i++) if (x[i] > m) m = x[i];
  let s = 0;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { out[i] = Math.exp(x[i] - m); s += out[i]; }
  for (let i = 0; i < x.length; i++) out[i] /= s;
  return out;
}

// ---------------------------------------------------------------------------
// Run model on a (T, 6) window. Returns probabilities array.

export function runModel(model, window) {
  // window shape: (T, 6), order matches model.input.channel_order
  const T = window.length;
  const C = model.input.channels;
  const normRot = model.input.norm_rot;
  const normAcc = model.input.norm_acc;
  // Transpose to (C, T) and normalize.
  let x = new Float32Array(C * T);
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < C; c++) {
      const norm = c < 3 ? normRot : normAcc;
      x[c * T + t] = window[t][c] / norm;
    }
  }
  let curT = T;
  let curC = C;
  for (const L of model.layers) {
    if (L.type === "conv1d") {
      x = conv1d(x, curT, L);
      curC = L.out;
    } else if (L.type === "relu") {
      x = relu(x);
    } else if (L.type === "maxpool1d") {
      x = maxpool1d(x, curC, curT, L.kernel);
      curT = Math.floor(curT / L.kernel);
    } else if (L.type === "globalavgpool") {
      x = globalAvgPool(x, curC, curT);
      curT = 1;
    } else if (L.type === "dense") {
      x = dense(x, L);
      curC = L.out;
    } else if (L.type === "softmax") {
      x = softmax(x);
    }
  }
  return Array.from(x);
}
