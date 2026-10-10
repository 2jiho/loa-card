"""Generate card references and display thumbnails exclusively from client atlases.

Requires Pillow, OpenCV and NumPy. Original atlases/DBs remain local; build/dev
use the committed output, never require a game installation or external artwork.
The reviewed crop map preserves its historical label provenance.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sqlite3

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--assets', type=Path, default=ROOT / 'work/client-assets',
                    help='Local directory containing db/ and card-atlases/.')
LOCAL = parser.parse_args().assets.resolve()
OUT = ROOT / 'public/scanner'
mapping = json.loads((ROOT / 'scripts/client-artwork-map.json').read_text(encoding='utf-8'))
catalog = json.loads((OUT / 'cards.json').read_text(encoding='utf-8'))
aliases = {'catalog:zakra-sarta': 3201111, 'catalog:four-elders': 3201112, 'catalog:illusion-moon': 3201113}
db = sqlite3.connect((LOCAL / 'db/SeasonCard.db').as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
messages = sqlite3.connect((LOCAL / 'db/GameMsg.db').as_uri() + '?mode=ro', uri=True)
approved = {c['id']: c for c in mapping['cards']}
assert len(approved) == len(mapping['cards'])
assert set(approved) <= {c['id'] for c in catalog['cards']}
atlas = {}
images = {}
provenance = []
for card in catalog['cards']:
    key = aliases.get(card['id']) or int(card['id'])
    row = db.execute('SELECT * FROM SeasonCard WHERE PrimaryKey=? AND SecondaryKey=0', (key,)).fetchone()
    assert row is not None, card['id']
    name = messages.execute('SELECT MSG FROM GameMsg WHERE KEY=?', (row['Name'],)).fetchone()[0].strip().removesuffix(' 카드')
    assert name == card['name'] and row['Grade'] - 1 == card['rarity'], card['id']
    assert row['MaxWakeUp'] == card.get('maxAwakening', 5), card['id']
    for field in ['feature', 'artSource', 'artwork', 'nameSource', 'growthSource', 'growthClientEvidence']:
        card.pop(field, None)
    card['nameSource'] = 'local-client:SeasonCard/GameMsg'
    card['clientId'] = key
    if row['MaxWakeUp'] == 0:
        card['growthSource'] = 'local-client:SeasonCard(SecondaryKey=0)'
        card['growthClientEvidence'] = {'primaryKeys': [key], 'grade': row['Grade'], 'maxWakeUp': 0}
    ref = approved.get(card['id'])
    if not ref:
        continue  # Never retain a previous external reference as a fallback.
    assert ref['name'] == name
    assert ref.get('usage', 'recognition-and-display') in ('recognition-and-display', 'display-only')
    source = LOCAL / 'card-atlases/EFUI_ICONATLAS_C/Texture2D' / ref['sourceAtlas']
    assert source.parent.resolve() == (LOCAL / 'card-atlases/EFUI_ICONATLAS_C/Texture2D').resolve()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == ref['sourceSha256'], source
    raw = cv2.imread(str(source), cv2.IMREAD_COLOR)
    x, y, w, h = ref['box']
    assert min(x, y) >= 0 and w > 0 and h > 0 and x + w <= raw.shape[1] and y + h <= raw.shape[0]
    crop = raw[y:y+h, x:x+w]
    reference_hashes = {}
    # A display association is not necessarily a unique card identity. Keep
    # shared portraits and manually identified display additions out of matching.
    if ref.get('usage') != 'display-only':
        small = cv2.resize(crop, (24, 32), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        vector = np.concatenate([rgb[6:13, 2:22].flatten(), rgb[19:24, 2:22].flatten()])
        card['feature'] = base64.b64encode(vector.tobytes()).decode()
        card['artSource'] = 'local-client-atlas'
        gray = .114 * small[:, :, 0] + .587 * small[:, :, 1] + .299 * small[:, :, 2]
        atlas[card['id']] = base64.b64encode(np.round(gray[9:19, 2:22]).astype(np.uint8).tobytes()).decode()
        reference_hashes = {'featureSha256': hashlib.sha256(vector.tobytes()).hexdigest(),
                            'portraitSha256': hashlib.sha256(base64.b64decode(atlas[card['id']])).hexdigest()}
    filename = f"{key}.webp"
    card['artwork'] = filename
    images[filename] = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)).resize((160, 234), Image.Resampling.LANCZOS)
    provenance.append({**ref, 'file': filename, **reference_hashes})

# Validate all input before writing any output.
art_dir = OUT / 'artwork'
art_dir.mkdir(exist_ok=True)
for ref in provenance:
    image_path = art_dir / ref['file']
    images[ref['file']].save(image_path, 'WEBP', quality=82, method=6)
    ref['thumbnailSha256'] = hashlib.sha256(image_path.read_bytes()).hexdigest()
catalog['version'] = 'client-2026-10-08'
catalog['source'] = 'local-client:SeasonCard/GameMsg'
catalog['sources'] = {'tables': {name: hashlib.sha256((LOCAL / f'db/{name}.db').read_bytes()).hexdigest() for name in ['SeasonCard', 'GameMsg']}, 'artwork': 'artwork-provenance.json', 'idCompatibility': 'Existing application IDs are preserved; clientId is the verified SeasonCard primary key.'}
(OUT / 'cards.json').write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
(OUT / 'artwork-details.json').write_text(json.dumps(atlas, separators=(',', ':')) + '\n', encoding='utf-8')
(OUT / 'artwork-provenance.json').write_text(json.dumps({'version': mapping['version'], 'pixelSource': mapping['pixelSource'], 'labelMethod': mapping['labelMethod'], 'thumbnail': {'width': 160, 'height': 234, 'format': 'webp'}, 'cards': provenance}, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
print(json.dumps({'catalog': len(catalog['cards']), 'recognitionReferences': len(atlas),
                  'displayArt': len(provenance), 'withoutDisplayArt': len(catalog['cards'])-len(provenance)}))
