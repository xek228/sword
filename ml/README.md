# ML training pipeline

This directory holds the Python training pipeline for the swing classifier.

## Overview

```
recordings/*.json          ← what the iPhone controller saves
        │
        ▼
ml/train.py
  ├─ load + resample to 60 Hz
  ├─ label assignment
  │     "right" / "left" / "down" → peak in the file is that class
  │     "combo_<a>-<b>-<c>"       → split the recording by peaks; assign
  │                                  labels in announced order
  │     "bg"                      → all sliding windows = "none"
  ├─ extract 0.7s windows
  ├─ augment (time-warp ±15%, amplitude scale ±25%, noise σ=0.02)
  ├─ train SwingCNN (1D CNN, ~5K params)
  └─ export → public/model.json   ← what the live server reads
```

The server (`server/index.js`) auto-loads `public/model.json` if it exists
and the live `GestureDetector` switches into ML mode (sliding-window CNN
inference). When no model is present it falls back to the rule-based
detector.

## Usage

```bash
# 1. Have the user record data via the controller. Files end up in
#    ./recordings/*.json
ls recordings | wc -l   # expect ~120-150 files

# 2. Train.
python ml/train.py --data-dir recordings --out public/model.json

# 3. Restart the server.
npm start
# Should log:  [gesture] ML mode: loaded model with classes none,right,left,down
```

## Architecture

`SwingCNN` (defined in `train.py`):

```
Input: (B, 6, 42)    ← 6 channels × 42 timesteps (= 0.7s @ 60 Hz)
  channels: [α, β, γ, ax, ay, az]
  rotation channels normalized by /1000 (deg/s)
  acceleration channels normalized by /30 (m/s²)

Conv1d(6→16, k=5, pad=2)      [480 params]
ReLU
MaxPool1d(2)                  → (B, 16, 21)
Conv1d(16→24, k=5, pad=2)     [1920 params]
ReLU
MaxPool1d(2)                  → (B, 24, 10)
Conv1d(24→24, k=3, pad=1)     [1728 params]
ReLU
GlobalAvgPool                 → (B, 24)
Dense(24→16)                  [400 params]
ReLU
Dense(16→4)                   [68 params]
Softmax → 4 classes: [none, right, left, down]
```

≈4.6K parameters total. Exports to ~100 KB JSON, runs in ~0.5ms per
window in plain JS on Node.

## Inference

The trained model is consumed by `server/swingModel.js` (a tiny pure-JS
forward pass: Conv1d, MaxPool1d, GlobalAvgPool, Dense, ReLU, Softmax).
The live `GestureDetector` keeps a rolling 0.7s buffer of incoming
motion samples, evaluates the model every ~50ms (= 20Hz), EMA-smooths
the probabilities, and fires when a non-`none` class exceeds the firing
threshold (with a refractory period to prevent rapid double-fire).

## Verifying JS↔PyTorch parity

The JS forward pass matches PyTorch to ~1e-5. To verify after retraining:

```bash
node /tmp/parity-test.mjs   # if you've kept the parity-test script
```
