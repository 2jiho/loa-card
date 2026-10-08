"""Fixed +1..+15 font masks with their dark outline; training input is video 1 only.

Manual counter labels were visually read independently of the recognizer output.
Full recordings and card images stay in ignored work/. Only glyph masks are emitted.
"""
import base64
import json
from pathlib import Path
import cv2
import numpy as np

rows = json.loads(Path('work/name-complete-video1.json').read_text(encoding='utf8'))['rows']
manual = {c['name']: c['extraCopies'] for c in json.loads(Path('tests/fixtures/manual-counters.json').read_text(encoding='utf8'))}
pools = {}
samples = []
for row in rows:
    text = row['values'][2]
    value = manual.get(row['values'][0])
    if value is None:
        if not text.isdigit() or int(text) == 0 or row['source'] == 'artwork' or '장수' in row['review']:
            continue
        value = int(text)
    full = cv2.resize(cv2.imdecode(np.frombuffer(base64.b64decode(row['image'].split(',')[1]), np.uint8), 1), (140, 210))
    strip = full[144:164, 90:138]
    mask = ((strip.min(2) > 180) & (strip.max(2) - strip.min(2) < 60)).astype(np.uint8)
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    boxes = [s for s in stats[1:] if s[3] >= 8 and 3 <= s[2] <= 12 and s[4] > 8]
    if len(boxes) == len(str(value)) + 1:
        clean = np.zeros_like(mask)
        for x, y, w, h, _ in boxes:
            clean[y:y+h, x:x+w] = mask[y:y+h, x:x+w]
        pools.setdefault(value, []).append(clean)
    if row['values'][0] in manual:
        rgba = cv2.cvtColor(full[141:166, 54:140], cv2.COLOR_BGR2RGBA)
        samples.append(dict(name=row['values'][0], value=value, rgba=base64.b64encode(rgba.tobytes()).decode()))
patterns = []
for value, masks in pools.items():
    for mask in masks[:8]:
        patterns.append(dict(value=value, bits=base64.b64encode(np.packbits(mask.flatten(), bitorder='little').tobytes()).decode(), pixels=int(mask.sum())))
if set(pools) != set(range(1, 16)):
    raise ValueError(f'Missing count references: {set(range(1, 16)) - set(pools)}')
Path('public/scanner/counter-patterns.json').write_text(json.dumps(dict(version=1, source='video-1-font-shapes-and-manual-counter-labels', patterns=patterns), separators=(',', ':')), encoding='utf8')
Path('tests/fixtures/counter-samples.json').write_text(json.dumps(samples, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
print(f'{len(patterns)} templates, all 15 values; {len(samples)} manually read counter strips.')
