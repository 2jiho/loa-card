"""Export equipped raid sets from the same local read-only tables as growth data."""
import hashlib
import json
import re
import sqlite3
from pathlib import Path

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


# Explicit presentation scope; memberships, thresholds and values come from the client.
selected = {
    1015: ('세구빛', 'dealer', 'holy'), 1004: ('남바절', 'support', 'holy'),
    1023: ('암구빛', 'dealer', 'dark'), 1058: ('암바절', 'support', 'dark'),
    1020: ('창의 달인', 'support', 'dark'),
    1048: ('화구빛', 'dealer', 'fire'), 1052: ('화바절', 'support', 'fire'),
    1049: ('수구빛', 'dealer', 'water'), 1053: ('수바절', 'support', 'water'),
    1050: ('토구빛', 'dealer', 'earth'), 1054: ('토바절', 'support', 'earth'),
    1051: ('뇌구빛', 'dealer', 'lightning'), 1055: ('뇌바절', 'support', 'lightning'),
    1043: ('알고 보면', 'dealer', 'general'), 1044: ('너계다', 'support', 'general'),
    1005: ('대사부 시험', 'support', 'earth'), 1006: ('루테란의 시련', 'support', 'water'),
    1016: ('에어가이츠 계획', 'support', 'lightning'), 1026: ('하늘을 비추는 사막', 'support', 'fire'),
}
elements = {1: '화', 2: '수', 3: '뇌', 5: '토', 6: '암', 7: '성'}
stats = {39: '비전투 중 마나 회복량', 40: '전투 중 마나 회복량', 49: '공격력',
         50: '추가 피해', 54: '무력화 피해', 57: '물리 방어력', 58: '마법 방어력',
         74: '치명타 적중률', 78: '공격속도', 80: '이동속도',
         87: '화속성 피해', 88: '수속성 피해', 89: '뇌속성 피해', 91: '토속성 피해',
         92: '암속성 피해', 93: '성속성 피해', 95: '화속성 피해 감소', 96: '수속성 피해 감소',
         97: '뇌속성 피해 감소', 99: '토속성 피해 감소', 100: '암속성 피해 감소',
         101: '성속성 피해 감소', 102: '모든 속성 피해 감소'}
effects = {r['PrimaryKey']: r for r in rows('SeasonCardEffect')}
sets = {}
for row in rows('SeasonCardBook'):
    key = row['PrimaryKey']
    if row['BookType'] != 2 or key not in selected:
        continue
    alias, role, element = selected[key]
    name = label(row['Name'])
    if alias != name and (role == 'dealer' or alias.endswith(('구빛', '바절'))):
        alias = f'{alias}({name})'
    members = [str(row[f'MemberCardId{i}']) for i in range(10) if row[f'MemberCardId{i}']]
    book = sets.setdefault(key, dict(id=str(key), name=name, alias=alias,
                                    role=role, element=element, cardIds=members, stages=[]))
    assert book['cardIds'] == members
    values = []
    if row['DamAttr']:
        values.append(dict(key='conversion', label=f'공격 속성을 {elements[row["DamAttr"]]}속성으로 변환', value=0))
    for i in range(3):
        if not row[f'EffectId{i}']:
            continue
        effect = effects[row[f'EffectId{i}']]
        for slot in range(3):
            kind, stat, index, value = [effect[f'{field}{slot}'] for field in ['AddonType', 'AddonStat', 'AddonIndex', 'AddonValue']]
            if kind == 2:
                assert stat in stats, stat
                values.append(dict(key=f'stat:{stat}', label=stats[stat], value=value))
            elif kind == 4:
                description = label(f'tip.desc.combateffect_{index}')
                match = re.fullmatch(r'공격 적중 시 대상이 자신 및 파티원에게 받는 (.+?)이 ([\d.]+)% 증가', description)
                assert match, description
                values.append(dict(key='party-damage', label=f'공격 적중 시 자신·파티원 {match[1]} 증가', value=round(float(match[2]) * 100)))
            else:
                assert not kind, (key, kind)
        assert not effect['EngraveId'], key
    assert values, row
    assert len(members) == len(set(members)), key
    assert 0 < row['CardCount'] <= len(members), key
    assert 0 <= row['AwakeningLevelSum'] <= row['CardCount'] * 5, key
    book['stages'].append(dict(count=row['CardCount'], awakening=row['AwakeningLevelSum'], effects=values))

assert set(sets) == set(selected), 'Missing selected raid sets'
messages.close()
growth = json.loads((ROOT / 'public/growth/master.json').read_text(encoding='utf-8'))
member_ids = {cid for book in sets.values() for cid in book['cardIds']}
cards = [c for c in growth['cards'] if c['id'] in member_ids]
assert len(cards) == len(member_ids)
for book in sets.values():
    book['stages'].sort(key=lambda stage: (stage['awakening'], stage['count']))
    book['slots'] = max(s['count'] for s in book['stages'])
    assert book['slots'] == 6, book['id']
    assert len({(s['count'], s['awakening']) for s in book['stages']}) == len(book['stages']), book['id']
data = dict(version=growth['version'], sources=dict(
    tables={t: hashlib.sha256((DB / f'{t}.db').read_bytes()).hexdigest()
            for t in ['SeasonCardBook', 'SeasonCardEffect', 'GameMsg']},
    statEnum='https://github.com/lost-ark-dev/meter-core/blob/main/src/packets/generated/enums.ts'),
    cards=cards, sets=[sets[k] for k in selected])
out = ROOT / 'public/raid/master.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
print(f'{len(data["sets"])} sets, {len(cards)} cards -> {out}')
