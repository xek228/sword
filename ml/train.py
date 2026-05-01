"""Train a sliding-window swing classifier from controller recordings.

Pipeline:
  1. Load all .json recordings from ``--data-dir``.
  2. Resample each to 60 Hz uniform grid.
  3. Assign labels:
        - label "right" / "left" / "down": peak in rotation magnitude is that class
        - label "combo_<a>-<b>-<c>": auto-segment by peaks; assign labels in order
        - label "bg": entire recording is the "none" class
        - other labels: ignored (back-compat with old recordings)
  4. Extract fixed-length windows around each labeled peak (positive class)
     and from background recordings (negative class).
  5. Train a small 1D CNN on (window, 6 channels) → 4 classes.
  6. Export weights as JSON for the JS gestureDetector.

Run:
    python ml/train.py --data-dir recordings --out public/model.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

# ----------------------------------------------------------------------------
# Constants

CLASSES = ["none", "right", "left", "down"]
NUM_CLASSES = len(CLASSES)
CLASS_TO_IDX = {c: i for i, c in enumerate(CLASSES)}

INPUT_HZ = 60
WINDOW_S = 0.7
WINDOW_LEN = int(WINDOW_S * INPUT_HZ)  # 42 samples
NUM_CHANNELS = 6                       # rot αβγ + accel xyz

# Normalisation: divide each channel by its expected scale so input is O(1).
NORM_ROT = 1000.0   # deg/s; typical swing peaks ~600-1000
NORM_ACC = 30.0     # m/s²;   typical swing peaks ~25-50

# Peak detection used for labeling combos and isolated swings.
PEAK_MIN_MAG = 500    # deg/s — minimum rotation magnitude to count as a peak
PEAK_REFRACTORY_MS = 350  # min gap between peaks


# ----------------------------------------------------------------------------
# Data loading & resampling

@dataclass
class Recording:
    label: str
    samples: list  # list of dicts


def load_recordings(data_dir: Path) -> list[Recording]:
    out = []
    for path in sorted(data_dir.glob("*.json")):
        try:
            d = json.loads(path.read_text())
        except Exception as e:
            print(f"  skip {path.name}: {e}", file=sys.stderr)
            continue
        label = (d.get("label") or "").strip()
        # Back-compat: old recordings may have arbitrary or empty labels.
        # Try to recover from filename for "chop_1_..." → "down".
        if not label or not label.replace("_", "").replace("-", "").isalnum():
            stem = path.stem
            head = stem.split("_")[0]
            if head in ("chop",):
                label = "down"
            elif head in ("right", "left", "down", "bg"):
                label = head
        out.append(Recording(label=label, samples=d.get("samples") or []))
    return out


def resample_60hz(samples: list[dict]) -> np.ndarray | None:
    """Return (T, 6) array on a 60Hz grid, channels = (α, β, γ, ax, ay, az)."""
    if len(samples) < 4:
        return None
    t0 = samples[0]["t"]
    ts = np.array([s["t"] - t0 for s in samples], dtype=np.float64)  # ms
    duration_ms = ts[-1] - ts[0]
    if duration_ms < 100:
        return None
    n_out = int(duration_ms / 1000.0 * INPUT_HZ)
    if n_out < 4:
        return None
    grid_ms = np.linspace(0, duration_ms, n_out)

    chans = []
    for key in [("rotationRate", "alpha"), ("rotationRate", "beta"),
                ("rotationRate", "gamma"),
                ("acceleration", "x"), ("acceleration", "y"),
                ("acceleration", "z")]:
        vals = np.array([(s.get(key[0]) or {}).get(key[1]) or 0.0 for s in samples],
                        dtype=np.float64)
        chans.append(np.interp(grid_ms, ts, vals))
    arr = np.stack(chans, axis=1).astype(np.float32)  # (T, 6)
    return arr


def normalise(window: np.ndarray) -> np.ndarray:
    """Channel-wise scaling so values are roughly in [-1, 1]."""
    out = window.copy()
    out[:, 0:3] /= NORM_ROT
    out[:, 3:6] /= NORM_ACC
    return out


# ----------------------------------------------------------------------------
# Peak detection (for combo segmentation and isolated swings)

def find_peaks(grid: np.ndarray) -> list[int]:
    """Return indices of local maxima of rotation-magnitude exceeding the floor."""
    rot_mag = np.linalg.norm(grid[:, 0:3], axis=1)
    peaks = []
    refractory_frames = int(PEAK_REFRACTORY_MS / 1000.0 * INPUT_HZ)
    for i in range(2, len(rot_mag) - 2):
        if rot_mag[i] < PEAK_MIN_MAG:
            continue
        window = rot_mag[max(0, i - 4): i + 5]
        if rot_mag[i] != window.max():
            continue
        if peaks and i - peaks[-1] < refractory_frames:
            # keep the larger of the two
            if rot_mag[i] > rot_mag[peaks[-1]]:
                peaks[-1] = i
            continue
        peaks.append(i)
    return peaks


# ----------------------------------------------------------------------------
# Window extraction & labeling

def extract_labeled_windows(grids: list[tuple[str, np.ndarray]],
                             skip_unknown: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """Produce (X, y) arrays where X is (N, WINDOW_LEN, 6) and y is (N,)."""
    X = []
    y = []
    half = WINDOW_LEN // 2
    # Live inference centers windows on detected rotation-magnitude peaks,
    # so the model only ever sees windows where the peak is in the middle.
    # Small jitter helps tolerate ±1-2 samples of peak-detection error and
    # natural variation in where the peak falls during a swing.
    OFFSETS = [-4, -2, 0, 2, 4]
    for label, g in grids:
        T = g.shape[0]
        if label in ("right", "left", "down"):
            peaks = find_peaks(g)
            if not peaks:
                continue
            # Use the LARGEST peak as THE peak for an isolated recording.
            rot_mag = np.linalg.norm(g[:, 0:3], axis=1)
            best = max(peaks, key=lambda i: rot_mag[i])
            for off in OFFSETS:
                s = best - half + off
                e = s + WINDOW_LEN
                if s < 0 or e > T:
                    continue
                X.append(g[s:e])
                y.append(CLASS_TO_IDX[label])

        elif label.startswith("combo_"):
            seq = label[len("combo_"):].split("-")
            seq = [c for c in seq if c in CLASS_TO_IDX]
            peaks = find_peaks(g)
            n = min(len(peaks), len(seq))
            for k in range(n):
                p = peaks[k]
                cls_label = seq[k]
                for off in OFFSETS:
                    s = p - half + off
                    e = s + WINDOW_LEN
                    if s < 0 or e > T:
                        continue
                    X.append(g[s:e])
                    y.append(CLASS_TO_IDX[cls_label])

        elif label == "bg":
            # Sliding 0.7s windows, every ~0.2s. Skip any window whose
            # rotation magnitude approaches a swing (defensive: if user
            # accidentally swung during bg, skip that bit).
            stride = int(0.2 * INPUT_HZ)
            for s in range(0, T - WINDOW_LEN + 1, stride):
                w = g[s:s + WINDOW_LEN]
                if np.linalg.norm(w[:, 0:3], axis=1).max() > 400:
                    continue
                X.append(w)
                y.append(CLASS_TO_IDX["none"])

        elif skip_unknown:
            continue

    # Add synthetic "approach" windows around each labeled peak: the
    # rest period BEFORE the swing starts. These also map to "none" and
    # teach the model that pre-burst quiet does NOT predict a swing.
    for label, g in grids:
        if label not in ("right", "left", "down") and not label.startswith("combo_"):
            continue
        peaks = find_peaks(g)
        if not peaks:
            continue
        rot_mag = np.linalg.norm(g[:, 0:3], axis=1)
        # Quiet period: window ends >= 25 frames before the first peak.
        first_peak = min(peaks)
        for s in range(0, first_peak - WINDOW_LEN - 5, int(0.15 * INPUT_HZ)):
            w = g[s:s + WINDOW_LEN]
            if np.linalg.norm(w[:, 0:3], axis=1).max() > 300:
                continue
            X.append(w)
            y.append(CLASS_TO_IDX["none"])

    if not X:
        return np.zeros((0, WINDOW_LEN, NUM_CHANNELS), dtype=np.float32), np.zeros((0,), dtype=np.int64)
    X = np.stack(X, axis=0).astype(np.float32)
    y = np.asarray(y, dtype=np.int64)
    return X, y


# ----------------------------------------------------------------------------
# Augmentations (applied online during training)

def augment_window(w: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Apply random time-warp, amplitude scale, gaussian noise."""
    out = w.copy()

    # Time warp: stretch/compress by ±15%
    factor = float(rng.uniform(0.85, 1.15))
    new_len = max(8, int(WINDOW_LEN * factor))
    src = np.linspace(0, WINDOW_LEN - 1, new_len)
    warped = np.empty((new_len, NUM_CHANNELS), dtype=np.float32)
    for c in range(NUM_CHANNELS):
        warped[:, c] = np.interp(src, np.arange(WINDOW_LEN), out[:, c])
    # crop or pad back to WINDOW_LEN, centered
    if new_len >= WINDOW_LEN:
        start = (new_len - WINDOW_LEN) // 2
        out = warped[start:start + WINDOW_LEN]
    else:
        pad_l = (WINDOW_LEN - new_len) // 2
        pad_r = WINDOW_LEN - new_len - pad_l
        out = np.pad(warped, ((pad_l, pad_r), (0, 0)), mode="edge")

    # Amplitude scale: rotation channels and acceleration channels independently
    rot_scale = float(rng.uniform(0.75, 1.25))
    acc_scale = float(rng.uniform(0.75, 1.25))
    out[:, 0:3] *= rot_scale
    out[:, 3:6] *= acc_scale

    # Gaussian noise on normalized values (will be applied after normalise)
    noise = rng.normal(0, 0.02, size=out.shape).astype(np.float32)
    out = out + noise

    return out.astype(np.float32)


class SwingDataset(Dataset):
    def __init__(self, X, y, train: bool = False, seed: int = 0):
        self.X = X
        self.y = y
        self.train = train
        self.rng = np.random.default_rng(seed)

    def __len__(self):
        return len(self.X)

    def __getitem__(self, i):
        w = self.X[i]
        if self.train:
            w = augment_window(w, self.rng)
        w = normalise(w)
        # PyTorch conv1d expects (C, T)
        return torch.from_numpy(w.T.copy()), int(self.y[i])


# ----------------------------------------------------------------------------
# Model

class SwingCNN(nn.Module):
    def __init__(self, num_classes: int = NUM_CLASSES):
        super().__init__()
        self.conv1 = nn.Conv1d(NUM_CHANNELS, 16, kernel_size=5, padding=2)
        self.conv2 = nn.Conv1d(16, 24, kernel_size=5, padding=2)
        self.conv3 = nn.Conv1d(24, 24, kernel_size=3, padding=1)
        self.fc1 = nn.Linear(24, 16)
        self.fc2 = nn.Linear(16, num_classes)

    def forward(self, x):
        # x: (B, 6, T)
        x = F.relu(self.conv1(x))
        x = F.max_pool1d(x, 2)
        x = F.relu(self.conv2(x))
        x = F.max_pool1d(x, 2)
        x = F.relu(self.conv3(x))
        x = x.mean(dim=2)  # global avg pool over time
        x = F.relu(self.fc1(x))
        return self.fc2(x)  # logits


# ----------------------------------------------------------------------------
# Export to JSON for JS inference

def export_model_json(model: SwingCNN, out_path: Path) -> None:
    sd = model.state_dict()
    blob = {
        "version": 1,
        "input": {
            "channels": NUM_CHANNELS,
            "window_len": WINDOW_LEN,
            "norm_rot": NORM_ROT,
            "norm_acc": NORM_ACC,
            "channel_order": ["alpha", "beta", "gamma", "ax", "ay", "az"],
        },
        "classes": CLASSES,
        "layers": [
            {"type": "conv1d", "name": "conv1",
             "weight": sd["conv1.weight"].cpu().numpy().tolist(),
             "bias":   sd["conv1.bias"].cpu().numpy().tolist(),
             "kernel": 5, "padding": 2, "in": NUM_CHANNELS, "out": 16},
            {"type": "relu"},
            {"type": "maxpool1d", "kernel": 2},
            {"type": "conv1d", "name": "conv2",
             "weight": sd["conv2.weight"].cpu().numpy().tolist(),
             "bias":   sd["conv2.bias"].cpu().numpy().tolist(),
             "kernel": 5, "padding": 2, "in": 16, "out": 24},
            {"type": "relu"},
            {"type": "maxpool1d", "kernel": 2},
            {"type": "conv1d", "name": "conv3",
             "weight": sd["conv3.weight"].cpu().numpy().tolist(),
             "bias":   sd["conv3.bias"].cpu().numpy().tolist(),
             "kernel": 3, "padding": 1, "in": 24, "out": 24},
            {"type": "relu"},
            {"type": "globalavgpool"},
            {"type": "dense", "name": "fc1",
             "weight": sd["fc1.weight"].cpu().numpy().tolist(),
             "bias":   sd["fc1.bias"].cpu().numpy().tolist(),
             "in": 24, "out": 16},
            {"type": "relu"},
            {"type": "dense", "name": "fc2",
             "weight": sd["fc2.weight"].cpu().numpy().tolist(),
             "bias":   sd["fc2.bias"].cpu().numpy().tolist(),
             "in": 16, "out": NUM_CLASSES},
            {"type": "softmax"},
        ],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(blob))
    size_kb = out_path.stat().st_size / 1024
    print(f"  wrote {out_path}  ({size_kb:.1f} KB)")


# ----------------------------------------------------------------------------
# Training driver

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data-dir", type=Path, default=Path("recordings"))
    p.add_argument("--out", type=Path, default=Path("public/model.json"))
    p.add_argument("--epochs", type=int, default=80)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=2e-3)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)

    print(f"Loading recordings from {args.data_dir} …")
    recs = load_recordings(args.data_dir)
    print(f"  {len(recs)} files loaded")

    grids = []
    label_counts = {}
    for r in recs:
        g = resample_60hz(r.samples)
        if g is None:
            continue
        grids.append((r.label, g))
        label_counts[r.label] = label_counts.get(r.label, 0) + 1
    print(f"  resampled grids: {len(grids)}")
    print(f"  label counts:")
    for k, v in sorted(label_counts.items()):
        print(f"    {k}: {v}")

    print("Extracting labeled windows…")
    X, y = extract_labeled_windows(grids)
    print(f"  X shape: {X.shape}  y shape: {y.shape}")
    print(f"  per-class:")
    for c, idx in CLASS_TO_IDX.items():
        n = int((y == idx).sum())
        print(f"    {c}: {n}")

    if len(X) < 8 or len(np.unique(y)) < 2:
        print("Not enough labeled data to train. Exiting.")
        return

    # Stratified train/val split.
    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(X))
    n_val = max(2, len(X) // 8)
    val_idx = perm[:n_val]; train_idx = perm[n_val:]

    train_ds = SwingDataset(X[train_idx], y[train_idx], train=True, seed=args.seed)
    val_ds   = SwingDataset(X[val_idx],   y[val_idx],   train=False)
    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True)
    val_dl   = DataLoader(val_ds,   batch_size=args.batch_size, shuffle=False)

    model = SwingCNN()
    n_params = sum(p.numel() for p in model.parameters())
    print(f"Model: SwingCNN, {n_params} params")

    opt = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=1e-4)
    cls_counts = np.bincount(y, minlength=NUM_CLASSES).astype(np.float32)
    weights = (cls_counts.max() / np.maximum(cls_counts, 1.0))
    weights = torch.tensor(weights, dtype=torch.float32)
    loss_fn = nn.CrossEntropyLoss(weight=weights)

    best_val = 0.0
    best_state = None
    for ep in range(args.epochs):
        model.train()
        train_loss, train_correct, train_total = 0.0, 0, 0
        for xb, yb in train_dl:
            opt.zero_grad()
            logits = model(xb)
            loss = loss_fn(logits, yb)
            loss.backward()
            opt.step()
            train_loss += float(loss) * len(xb)
            train_correct += (logits.argmax(1) == yb).sum().item()
            train_total += len(xb)

        model.eval()
        val_correct, val_total = 0, 0
        with torch.no_grad():
            for xb, yb in val_dl:
                logits = model(xb)
                val_correct += (logits.argmax(1) == yb).sum().item()
                val_total += len(xb)
        train_acc = train_correct / max(1, train_total)
        val_acc = val_correct / max(1, val_total)
        if val_acc > best_val:
            best_val = val_acc
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        if ep % 5 == 0 or ep == args.epochs - 1:
            print(f"  ep {ep:3d}  train loss {train_loss/max(1,train_total):.3f}  "
                  f"train acc {train_acc:.3f}  val acc {val_acc:.3f}  (best {best_val:.3f})")

    if best_state is not None:
        model.load_state_dict(best_state)
    print(f"Best val acc: {best_val:.3f}")

    # Confusion matrix on val set
    model.eval()
    cm = np.zeros((NUM_CLASSES, NUM_CLASSES), dtype=int)
    with torch.no_grad():
        for xb, yb in val_dl:
            preds = model(xb).argmax(1).numpy()
            for p_, t_ in zip(preds, yb.numpy()):
                cm[t_, p_] += 1
    print("Confusion (rows=true, cols=pred):")
    print("       " + " ".join(f"{c:>6}" for c in CLASSES))
    for i, c in enumerate(CLASSES):
        print(f"  {c:<5} " + " ".join(f"{cm[i,j]:>6}" for j in range(NUM_CLASSES)))

    print("Exporting model…")
    export_model_json(model, args.out)
    print("Done.")


if __name__ == "__main__":
    main()
