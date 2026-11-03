# SPDX-License-Identifier: Apache-2.0
"""
Trains the StorePOS handwritten digit model and exports it to ONNX.

Data (built by scripts/ocr/make-training-set.ts from the app's own preprocessing):
  iso-*.u8  training digits photographed on their own (pendigits writers 0-23, MNIST train 0-57999)
  seg-*.u8  training digits as the app's segmenter cuts them out of whole codes (same sources)
  val-*.u8  validation: pendigits writers 24-29 and MNIST train 58000-59999, never trained on
The held-out test writers (pendigits-orig.tes) and MNIST test are not used here.

  python scripts/ocr/train/train_digits.py --data <trainset dir> --out <model dir> [--epochs 14]

Output: handwriting-digits.onnx (input "input" [n,1,28,28] 0..1, output "logits" [n,10], already
divided by the calibration temperature) and model-card.json (data, settings, validation metrics).
"""

import argparse
import glob
import json
import math
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


def load(pattern):
    xs, ys = [], []
    for fx in sorted(glob.glob(pattern + '-x.u8')):
        fy = fx[:-5] + '-y.u8'
        x = np.fromfile(fx, dtype=np.uint8)
        y = np.fromfile(fy, dtype=np.uint8)
        xs.append(x.reshape(-1, 1, 28, 28))
        ys.append(y)
    if not xs:
        return None, None
    return np.concatenate(xs), np.concatenate(ys)


class DigitNet(nn.Module):
    def __init__(self):
        super().__init__()
        def block(cin, cout):
            return [nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True)]
        self.features = nn.Sequential(
            *block(1, 32), nn.MaxPool2d(2),                                       # 14x14
            *block(32, 48), *block(48, 48), nn.MaxPool2d(2), nn.Dropout(0.1),     # 7x7
            *block(48, 96), nn.MaxPool2d(2), nn.Dropout(0.15),                    # 3x3
        )
        self.head = nn.Sequential(nn.Flatten(), nn.Linear(96 * 3 * 3, 128), nn.ReLU(inplace=True), nn.Dropout(0.3), nn.Linear(128, 10))

    def forward(self, x):
        return self.head(self.features(x))


class Calibrated(nn.Module):
    """The trained network with its logits divided by the fitted temperature."""
    def __init__(self, net, temperature):
        super().__init__()
        self.net = net
        self.register_buffer('inv_t', torch.tensor(1.0 / temperature))

    def forward(self, x):
        return self.net(x) * self.inv_t


def augment(x, gen):
    """Random affine (rotation, scale, slant, shift), stroke thickness, small gaps, noise, and
    occasionally a piece of a neighbouring digit at the left or right edge."""
    n = x.shape[0]
    dev = x.device
    ang = (torch.rand(n, generator=gen) * 2 - 1) * math.radians(10)
    scale = 1 + (torch.rand(n, generator=gen) * 2 - 1) * 0.12
    shear = (torch.rand(n, generator=gen) * 2 - 1) * 0.25
    tx = (torch.rand(n, generator=gen) * 2 - 1) * (2.0 / 14)
    ty = (torch.rand(n, generator=gen) * 2 - 1) * (2.0 / 14)
    cos, sin = torch.cos(ang) / scale, torch.sin(ang) / scale
    theta = torch.zeros(n, 2, 3)
    theta[:, 0, 0] = cos
    theta[:, 0, 1] = -sin + shear
    theta[:, 1, 0] = sin
    theta[:, 1, 1] = cos
    theta[:, 0, 2] = tx
    theta[:, 1, 2] = ty
    grid = F.affine_grid(theta.to(dev), list(x.shape), align_corners=False)
    out = F.grid_sample(x, grid, align_corners=False, padding_mode='zeros')

    r = torch.rand(n, generator=gen)
    thick = (r < 0.15).view(-1, 1, 1, 1).to(dev)
    thin = ((r >= 0.15) & (r < 0.25)).view(-1, 1, 1, 1).to(dev)
    dil = F.max_pool2d(out, 3, 1, 1)
    ero = -F.max_pool2d(-out, 3, 1, 1)
    out = torch.where(thick, 0.5 * (out + dil), out)
    out = torch.where(thin, torch.maximum(ero, 0.6 * out), out)

    # A piece of another digit at one edge (as a cut or a close neighbour leaves it).
    k = torch.rand(n, generator=gen) < 0.1
    if k.any():
        idx = torch.nonzero(k).flatten()
        other = out[torch.randperm(n, generator=gen)[: idx.numel()]]
        shift = int(torch.randint(17, 23, (1,), generator=gen))
        side = 1 if torch.rand(1, generator=gen) < 0.5 else -1
        other = torch.roll(other, shifts=side * shift, dims=3)
        if side > 0:
            other[..., :shift] = 0
        else:
            other[..., -shift:] = 0
        out[idx] = torch.maximum(out[idx], 0.85 * other)

    # Small gaps in strokes: a 3x3 hole at a random point in 12% of the digits.
    g = (torch.rand(n, generator=gen) < 0.12).view(-1, 1, 1, 1)
    points = torch.zeros_like(out)
    flat = torch.randint(0, 28 * 28, (n,), generator=gen)
    points.view(n, -1)[torch.arange(n), flat] = 1
    holes = F.max_pool2d(points, 3, 1, 1) * g.to(out.dtype)
    out = out * (1 - holes)
    out = out + torch.randn(out.shape, generator=gen).to(dev) * 0.03
    return out.clamp(0, 1)


def evaluate(model, x, y, batch=2048):
    model.eval()
    logits = []
    with torch.no_grad():
        for i in range(0, len(x), batch):
            logits.append(model(x[i:i + batch]))
    logits = torch.cat(logits)
    acc = (logits.argmax(1) == y).float().mean().item()
    return acc, logits


def fit_temperature(logits, y):
    """Temperature minimising the validation negative log-likelihood (grid + refinement)."""
    best_t, best_nll = 1.0, float('inf')
    for t in np.arange(0.3, 4.01, 0.05):
        nll = F.cross_entropy(logits / t, y).item()
        if nll < best_nll:
            best_t, best_nll = float(t), nll
    return best_t, best_nll


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--epochs', type=int, default=14)
    ap.add_argument('--batch', type=int, default=256)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--seed', type=int, default=20261103)
    args = ap.parse_args()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    gen = torch.Generator().manual_seed(args.seed)
    os.makedirs(args.out, exist_ok=True)

    parts = {}
    for kind in ('iso', 'seg'):
        x, y = load(os.path.join(args.data, kind + '-*'))
        if x is not None:
            parts[kind] = (x, y)
    xv, yv = load(os.path.join(args.data, 'val-*'))
    xt = torch.from_numpy(np.concatenate([p[0] for p in parts.values()])).float() / 255
    yt = torch.from_numpy(np.concatenate([p[1] for p in parts.values()])).long()
    xv = torch.from_numpy(xv).float() / 255
    yv = torch.from_numpy(yv).long()
    # Validation order from make-training-set.ts: pendigits writers 24-29 first, then MNIST.
    with open(os.path.join(args.data, 'val-0-meta.json'), encoding='utf-8') as f:
        n_val_pen = int(json.load(f)['pen'])
    print(f'train {len(xt)} ({", ".join(f"{k} {len(v[1])}" for k, v in parts.items())}), validation {len(xv)} (pen {n_val_pen}, mnist 2000)')

    model = DigitNet()
    params = sum(p.numel() for p in model.parameters())
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = args.epochs * math.ceil(len(xt) / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.15)
    best = (-1.0, None, -1)
    history = []
    for epoch in range(args.epochs):
        model.train()
        t0 = time.time()
        perm = torch.randperm(len(xt), generator=gen)
        total = 0.0
        for i in range(0, len(xt), args.batch):
            idx = perm[i:i + args.batch]
            xb = augment(xt[idx], gen)
            loss = F.cross_entropy(model(xb), yt[idx], label_smoothing=0.05)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item() * len(idx)
        acc, _ = evaluate(model, xv, yv)
        acc_pen, _ = evaluate(model, xv[:n_val_pen], yv[:n_val_pen])
        acc_mnist, _ = evaluate(model, xv[n_val_pen:], yv[n_val_pen:])
        history.append({'epoch': epoch + 1, 'loss': total / len(xt), 'val': acc, 'val_pen': acc_pen, 'val_mnist': acc_mnist})
        print(f'epoch {epoch + 1}/{args.epochs} loss {total / len(xt):.4f} val {acc * 100:.2f}% (pen {acc_pen * 100:.2f}%, mnist {acc_mnist * 100:.2f}%) {time.time() - t0:.0f}s', flush=True)
        if acc > best[0]:
            best = (acc, {k: v.clone() for k, v in model.state_dict().items()}, epoch + 1)

    model.load_state_dict(best[1])
    acc, logits = evaluate(model, xv, yv)
    temperature, nll = fit_temperature(logits, yv)
    probs = F.softmax(logits / temperature, 1)
    conf, pred = probs.max(1)
    wrong = pred != yv
    calib = []
    for lo in (0.0, 0.5, 0.7, 0.85, 0.95, 0.99):
        sel = conf >= lo
        calib.append({'min_confidence': lo, 'share': sel.float().mean().item(), 'accuracy': (~wrong[sel]).float().mean().item() if sel.any() else None})
    print(f'best epoch {best[2]}: val {acc * 100:.2f}%, temperature {temperature:.2f} (nll {nll:.4f})')
    for c in calib:
        acc_text = '-' if c['accuracy'] is None else f"{c['accuracy'] * 100:.2f}%"
        print(f"  confidence >= {c['min_confidence']:.2f}: {c['share'] * 100:.1f}% of digits, accuracy {acc_text}")

    export = Calibrated(model, temperature).eval()
    dummy = torch.zeros(1, 1, 28, 28)
    onnx_path = os.path.join(args.out, 'handwriting-digits.onnx')
    try:
        torch.onnx.export(export, (dummy,), onnx_path, input_names=['input'], output_names=['logits'],
                          dynamic_axes={'input': {0: 'n'}, 'logits': {0: 'n'}}, opset_version=17, dynamo=False)
    except Exception as err:  # the TorchScript exporter is deprecated in newer PyTorch
        print('TorchScript ONNX export unavailable, using torch.export:', err)
        torch.onnx.export(export, (dummy,), onnx_path, input_names=['input'], output_names=['logits'],
                          dynamic_shapes=({0: torch.export.Dim('n', min=1, max=256)},), opset_version=18, external_data=False)
    card = {
        'model': 'handwriting-digits.onnx',
        'architecture': 'CNN 32 | 48-48 | 96 (3x3 conv, batch norm, max pool) + 128 dense, dropout; %d parameters' % params,
        'input': 'input [n,1,28,28] float 0 (paper) .. 1 (ink), MNIST-style normalisation by src/main/ocr/normalize.ts',
        'output': 'logits [n,10], divided by the calibration temperature (softmax gives calibrated probabilities)',
        'temperature': temperature,
        'training': {k: int(len(v[1])) for k, v in parts.items()},
        'validation': {'pendigits_writers_24_29': n_val_pen, 'mnist_train_58000_59999': 2000},
        'best_epoch': best[2],
        'epochs': args.epochs,
        'seed': args.seed,
        'validation_accuracy': acc,
        'calibration': calib,
        'history': history,
        'data_sources': [
            'MNIST (Y. LeCun, C. Cortes, C. J. C. Burges), CC BY-SA 3.0',
            'Pen-Based Recognition of Handwritten Digits (E. Alpaydin, F. Alimoglu, 1998), UCI ML Repository, doi:10.24432/C5MG6K, CC BY 4.0',
        ],
        'torch': torch.__version__,
    }
    with open(os.path.join(args.out, 'model-card.json'), 'w', encoding='utf-8') as f:
        json.dump(card, f, indent=2)
    print('exported', onnx_path, os.path.getsize(onnx_path), 'bytes')


if __name__ == '__main__':
    main()
