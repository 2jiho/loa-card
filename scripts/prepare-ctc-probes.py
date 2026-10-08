"""Create bounded local OCR probes for the actual TS lexicon decoder.

Requires NumPy/OpenCV/Pillow/onnxruntime and local video snapshot/PNG fixtures.
Manual labels and weak previous-scanner references are reported separately.
This isolates name decoding; it is not a complete scanner accuracy benchmark.
"""
import base64
import io
import json
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

out = Path('work/ctc-probes')
out.mkdir(exist_ok=True)
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.log_severity_level = 3
session = ort.InferenceSession('work/paddle/inference.onnx', options, providers=['CPUExecutionProvider'])
samples = []
manual = json.loads(Path('tests/fixtures/manual-screenshot-cards.json').read_text(encoding='utf-8'))
for card in manual:
    image = Image.open(f"fixtures/local/screenshots-1/{card['page']:02}.png").convert('RGB')
    x, y = round(138+157.5*card['column']), 392+243*card['row']
    samples.append((card['name'], True, image.crop((x,y,x+140,y+210))))
rows = json.loads(Path('work/name-complete-video1.json').read_text(encoding='utf-8'))['rows']
for row in rows[::24]:
    image = Image.open(io.BytesIO(base64.b64decode(row['image'].split(',')[1]))).convert('RGB')
    samples.append((row['values'][0], False, image.resize((140,210))))
manifest = []
for name, labelled, image in samples:
    for height, top in [(18,14),(36,14),(18,32)]:
        rgb = np.asarray(image)[top:top+height,6:134]
        width = int(np.ceil(48*128/height))
        resized = cv2.resize(rgb[:,:,::-1], (width,48)).astype(np.float32)/127.5-1
        tensor = np.zeros((1,3,48,max(320,width)), np.float32)
        tensor[0,:,:,:width] = resized.transpose(2,0,1)
        probabilities = session.run(None, {session.get_inputs()[0].name:tensor})[0][0]
        path = out/f'{len(manifest):03}.f32'
        probabilities.astype('<f4').tofile(path)
        manifest.append({'name':name,'manual':labelled,'height':height,'top':top,'steps':len(probabilities),'path':str(path)})
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8')
print(f'Prepared {len(manifest)} name-strip probes (5 manual card labels plus 16 weak snapshot references, first/second lines and full bands).')
