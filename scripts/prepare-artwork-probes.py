"""Local first-line OCR + independent portrait probes; weak labels are separate.

Requires ignored snapshots, screenshot fixtures, ONNX model and local Python OCR
dependencies. No inputs/outputs are uploaded. OpenCV differs from browser canvas.
"""
import base64
import io
import json
import unicodedata
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

characters = json.loads(Path('public/scanner/paddle-characters.json').read_text(encoding='utf-8'))
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.log_severity_level = 3
session = ort.InferenceSession('work/paddle/inference.onnx', options, providers=['CPUExecutionProvider'])


def recognize(rgb):
    width = int(np.ceil(48 * rgb.shape[1] / rgb.shape[0]))
    resized = cv2.resize(rgb[:, :, ::-1], (width, 48)).astype(np.float32) / 127.5 - 1
    tensor = np.zeros((1, 3, 48, max(320, width)), np.float32)
    tensor[0, :, :, :width] = resized.transpose(2, 0, 1)
    probabilities = session.run(None, {session.get_inputs()[0].name: tensor})[0][0]
    previous, text, confidence = -1, [], []
    for step, index in enumerate(probabilities.argmax(1)):
        if index and index != previous:
            text.append(characters[index])
            confidence.append(float(probabilities[step, index]))
        previous = index
    return unicodedata.normalize('NFKC', ''.join(text)), float(np.mean(confidence)) if confidence else 0


results = []


def append(image, name, group, manual=False):
    rgb = cv2.resize(np.asarray(image.convert('RGB')), (140, 210), interpolation=cv2.INTER_AREA)
    text, confidence = recognize(rgb[14:32, 6:134])
    small = cv2.resize(rgb, (24, 32), interpolation=cv2.INTER_AREA)
    rgba = np.concatenate([small, np.full((32, 24, 1), 255, np.uint8)], axis=2)
    results.append(dict(name=name, group=group, manual=manual, text=text, confidence=confidence, rgba=rgba.ravel().tolist()))


for card in json.loads(Path('tests/fixtures/manual-screenshot-cards.json').read_text(encoding='utf-8')):
    image = Image.open(f"fixtures/local/screenshots-1/{card['page']:02}.png")
    x, y = round(138 + 157.5 * card['column']), 392 + 243 * card['row']
    append(image.crop((x, y, x + 140, y + 210)), card['name'], 'manual', True)
for group in ['video1', 'video2']:
    rows = json.loads(Path(f'work/name-complete-{group}.json').read_text(encoding='utf-8'))['rows']
    for row in rows:
        image = Image.open(io.BytesIO(base64.b64decode(row['image'].split(',')[1])))
        append(image, row['values'][0], group)
    print(f'{group}: {len(rows)} weak references prepared', flush=True)
Path('work/artwork-probes.json').write_text(json.dumps(results, ensure_ascii=False), encoding='utf-8')
