#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Read the map's coordinate readout with a real OCR package (RapidOCR), not a pile of digit templates.

  python scripts/ocr-readout.py <frame.jpg> <x> <y> <width> <height>

Install once:  python -m venv <venv> && <venv>/Scripts/pip install rapidocr-onnxruntime
Run from the World with WVD_OCR_PYTHON=<venv>/Scripts/python.exe and WVD_OCR_SCRIPT=scripts/ocr-readout.py;
without both, the World's own digit reader stays the only one.

The band is cut from the frame and upscaled 4x, because a 12 px numeral is below what any OCR model
wants; the model then reads the line. Measured 2026-11-07 on the four committed readouts:
X: 16 / Y: 4, X: 13 / Y: 25, X: 19 / Y: 2, X: 20 / Y: 14 — all four correct, including a frame whose
boxes came back out of label order. This is an **escalation**: the loop's own reader handles the
digits it can classify, and only a readout it refuses is handed here (operator, 2026-11-07: any number
has to be readable, so use a package or a model — not one committed glyph per digit).
"""
import json
import sys

def main() -> int:
    if len(sys.argv) < 6:
        print(json.dumps({'ok': False, 'error': 'usage: ocr-readout.py frame x y width height'}))
        return 2
    frame = sys.argv[1]
    x, y, width, height = (int(value) for value in sys.argv[2:6])
    try:
        import numpy as np
        from PIL import Image
        from rapidocr_onnxruntime import RapidOCR
    except Exception as error:  # noqa: BLE001 - a missing package is an answer, not a crash
        print(json.dumps({'ok': False, 'error': 'ocr-unavailable: ' + str(error)}))
        return 3
    image = Image.open(frame).convert('RGB').crop((x, y, x + width, y + height))
    scale = 4
    image = image.resize((image.width * scale, image.height * scale), Image.LANCZOS)
    engine = RapidOCR()
    result, _ = engine(np.array(image))
    texts = [item[1] for item in result] if result else []
    print(json.dumps({'ok': True, 'texts': texts}))
    return 0

if __name__ == '__main__':
    sys.exit(main())
