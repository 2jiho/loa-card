"""Build a small, versioned growth master from locally extracted read-only tables.

Input databases stay in ignored work/client-assets/db. No database, archive,
image or localization bundle is copied into the application.
"""
import hashlib
import json
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / 'work/client-assets/db'


def rows(table):
    with sqlite3.connect((DB / f'{table}.db').as_uri() + '?mode=ro', uri=True) as con:
        con.row_factory = sqlite3.Row
        return [dict(row) for row in con.execute(f'SELECT * FROM {table}')]


messages = sqlite3.connect((DB / 'GameMsg.db').as_uri() + '?mode=ro', uri=True)


def label(key):
    row = messages.execute('SELECT MSG FROM GameMsg WHERE KEY=?', (key,)).fetchone()
    assert row, key
    return row[0].strip()


catalog = json.loads((ROOT / 'public/scanner/cards.json').read_text(encoding='utf-8'))['cards']
source_cards = rows('SeasonCard')
by_key = {(r['PrimaryKey'], r['SecondaryKey']): r for r in source_cards}
aliases = {3201111: 'catalog:zakra-sarta', 3201112: 'catalog:four-elders', 3201113: 'catalog:illusion-moon'}
id_map = {int(c['id']): c['id'] for c in catalog if c['id'].isdigit()} | aliases
cards = []
for card in catalog:
    key = next(k for k, v in id_map.items() if v == card['id'])
    base = by_key[key, 0]
    assert label(base['Name']).removesuffix(' 카드') == card['name'].strip()
    assert base['Grade'] - 1 == card['rarity']
    maximum = card.get('maxAwakening', 5)
    assert maximum == base['MaxWakeUp']
    steps = []
    for level in range(maximum):
        row = by_key[key, level]
        assert row['WakeUpNeedCardCount'] == level + 1
        xp = row['WakeUpNeedExp']
        # Growth costs 1.5 silver/XP. GrowthMoney is NOT the full growth cost.
        steps.append({'copies': level + 1, 'xp': xp, 'silver': xp * 3 // 2 + row['WakeUpMoney']})
    cards.append({'id': card['id'], 'name': card['name'], 'rarity': card['rarity'], 'steps': steps})

# Stat enum values cross-checked against lost-ark-dev/meter-core enums.ts.
names = ['인간', '악마', '물질', '불사', '식물', '곤충', '정령', '야수', '기계', '고대', '신', '대악마']
targets = [{'id': str(125 + i), 'name': name} for i, name in enumerate(names)]
stats = [{'id': str(i), 'name': name} for i, name in [(3, '힘'), (4, '민첩'), (5, '지능'), (6, '체력'),
         (15, '치명'), (16, '특화'), (17, '제압'), (18, '신속'), (19, '인내'), (20, '숙련'), (55, '물리 방어력'), (56, '마법 방어력')]]
effects = {r['PrimaryKey']: r for r in rows('SeasonCardEffect')}
books = {}
for row in rows('SeasonCardBook'):
    if row['BookType'] != 1:
        continue  # Equipped sets are a different system.
    key = str(row['PrimaryKey'])
    members = [id_map[row[f'MemberCardId{i}']] for i in range(10) if row[f'MemberCardId{i}']]
    assert 0 < row['CardCount'] <= len(members) and len(set(members)) == len(members)
    book = books.setdefault(key, {'id': key, 'name': label(row['Name']), 'cardIds': members, 'effects': [], 'collectionEffects': []})
    assert book['cardIds'] == members
    collected_stats = []
    for i in range(3):
        if not row[f'EffectId{i}']:
            continue
        effect = effects[row[f'EffectId{i}']]
        for slot in range(3):
            stat = effect[f'AddonStat{slot}']
            if not stat:
                continue
            if not 125 <= stat <= 136:
                assert not row['AwakeningLevelSum'], (key, effect)
                assert str(stat) in {s['id'] for s in stats}
                collected_stats.append({'stat': str(stat), 'value': effect[f'AddonValue{slot}']})
                continue  # Displayed as collection effects, not optimization objectives.
            assert effect[f'AddonType{slot}'] == 2
            book['effects'].append({'threshold': row['AwakeningLevelSum'], 'requiredCount': row['CardCount'], 'target': str(stat), 'value': effect[f'AddonValue{slot}']})
    if collected_stats:
        book['collectionEffects'].append({'requiredCount': row['CardCount'], 'stats': collected_stats})

data = {
    'version': 'kr-2026-10-07',
    'sources': {
        'tables': {t: hashlib.sha256((DB / f'{t}.db').read_bytes()).hexdigest() for t in ['SeasonCard', 'SeasonCardBook', 'SeasonCardEffect']},
        'statEnum': 'https://github.com/lost-ark-dev/meter-core/blob/main/src/packets/generated/enums.ts',
        'silverRule': 'https://www.inven.co.kr/board/lostark/4821/85241',
        'effectUnit': '1 = 0.01 percentage point; thresholds add cumulatively',
    },
    'targets': targets, 'stats': stats, 'cards': cards, 'books': list(books.values()),
}
dest = ROOT / 'public/growth/master.json'
dest.parent.mkdir(exist_ok=True)
dest.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
print(json.dumps({'cards': len(cards), 'books': len(books), 'damageBooks': sum(bool(b['effects']) for b in books.values())}))
