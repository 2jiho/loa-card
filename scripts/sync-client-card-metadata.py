"""Audit local extracted DB metadata; --apply adds unambiguous no-growth facts.

Never derives artwork UV coordinates or overwrites existing sourced metadata.
Run from repository root. Input stays in ignored work/client-assets.
"""
import argparse
import json
import unicodedata
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
catalog_path = Path('public/scanner/cards.json')
catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
records = json.loads(Path('work/client-assets/db/card-image-mapping.json').read_text(encoding='utf-8'))

def normalize(text):
    return ''.join(unicodedata.normalize('NFKC', text).split())

lookup = {}
for record in records:
    lookup.setdefault(normalize(record['KoreanName']), []).append(record)
audit = {'matched': [], 'missing': [], 'ambiguous': [], 'conflicts': [], 'added': []}
for card in catalog['cards']:
    options = lookup.get(normalize(card['name']), [])
    facts = {(r['Grade']-1, r['MaxWakeUp']) for r in options}
    if not options:
        audit['missing'].append(card['name'])
        continue
    if len(facts) != 1:
        audit['ambiguous'].append({'name': card['name'], 'facts': sorted(facts)})
        continue
    grade, maximum = next(iter(facts))
    if grade != card['rarity'] or card.get('maxAwakening', maximum) != maximum:
        audit['conflicts'].append(card['name'])
        continue
    audit['matched'].append({'name': card['name'], 'maxAwakening': maximum})
    # Regular cards already use the default five-slot model. Only no-growth
    # cards benefit from new metadata, avoiding a forced guess on legacy rows.
    if maximum == 0 and 'maxAwakening' not in card:
        audit['added'].append(card['name'])
        if args.apply:
            card['maxAwakening'] = 0
            card['growthSource'] = 'local-client:SeasonCard(SecondaryKey=0)'
            card['growthClientEvidence'] = {
                'primaryKeys': sorted({r['PrimaryKey'] for r in options}),
                'grade': grade+1,
                'maxWakeUp': maximum,
            }
if args.apply:
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
Path('work/client-assets/db/catalog-audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k: v if k == 'added' else len(v) for k, v in audit.items()}, ensure_ascii=True))
