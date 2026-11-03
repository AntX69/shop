# StorePOS handwriting digit model

`handwriting-digits.onnx`: recognises one handwritten digit (0–9) for the StorePOS camera OCR. It runs locally (onnxruntime-web, WASM); no network.

| | |
|---|---|
| Input | `input` float32 [n, 1, 28, 28], 0 = paper … 1 = ink, MNIST-style normalisation by `src/main/ocr/normalize.ts` (digit's own ink, stroke thickened to MNIST width, longer side 20 px, centre of mass at the centre) |
| Output | `logits` float32 [n, 10], already divided by the calibration temperature: softmax gives calibrated probabilities |
| Architecture | CNN: 3×3 conv 32 → max pool → 48-48 → max pool → 96 → max pool → dense 128 → 10; batch norm, dropout (about 190 000 parameters, 9 million multiply-adds per digit) |
| Training code | `scripts/ocr/train/train_digits.py` (PyTorch, CPU), data from `scripts/ocr/make-training-set.ts` |
| Model card (data counts, settings, history) | [`model-card.json`](model-card.json) |

## Training data and licences

The model was trained on images made from these datasets. They are **not** included in the app or the repository.

- **MNIST** (Y. LeCun, C. Cortes, C. J. C. Burges): training images 0–57 999. Licence: Creative Commons Attribution-Share Alike 3.0 (CC BY-SA 3.0).
- **Pen-Based Recognition of Handwritten Digits**, original version (E. Alpaydin, F. Alimoglu, Bogazici University, 1998), UCI Machine Learning Repository, doi:10.24432/C5MG6K: writers 0–23 of the training file. Licence: Creative Commons Attribution 4.0 (CC BY 4.0).

Because MNIST is CC BY-SA 3.0, this model file is distributed under **CC BY-SA 3.0** with the attributions above.

Each training digit went through StorePOS's own pipeline: a simulated camera picture (paper, pen width, slant, rotation, light, blur, noise), the app's ink mask and normalisation. Digits were also taken as the app's segmenter cuts them out of whole simulated codes (touching digits, pieces of neighbours).

## Evaluation protocol

- **Validation** (model selection, temperature): pendigits writers 24–29 and MNIST training images 58 000–59 999. Never trained on.
- **Final test** (reported once, never used for any decision): the 14 pendigits test writers (`pendigits-orig.tes`, people absent from the training data) and the MNIST test set.
- These are simulated camera pictures of real handwriting. **Real webcam photos of the shop's handwriting are a separate, still pending test** (`docs/hardware/OCR_FIELD_TEST_KA.md`).

## Results (correctly segmented digits, `scripts/ocr/eval-model.ts`)

| | previous `mnist-8.onnx` | `handwriting-digits.onnx` |
|---|---|---|
| validation, pen digits (writers 24–29, 1 494) | 94.58% | 99.87% |
| validation, MNIST (2 000) | 98.75% | 99.50% |
| **test, pen digits (14 unseen writers, 3 498)** | **91.60%** | **98.60%** |
| **test, MNIST test (2 000)** | **98.85%** | **99.30%** |
| test, wrong with confidence ≥ 85% | 3.36% | 0.56% |

The whole OCR pipeline (finding and cutting the digits included) on the same independent test: `docs/release/RELEASE_READINESS.md` §3.4.
