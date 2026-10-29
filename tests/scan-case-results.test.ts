import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScanResult, compareScanResults } from '../scripts/scan-case-results.mjs';

const card = (id = 'a') => ({ id, name: `카드 ${id}`, awakening: 0 as number | null, extraCopies: 0 as number | null, review: [] as string[] });
const result = () => ({ expected: 1 as number | null, read: 1, unidentified: 0, experience: null as number | null, cards: [card()] });

test('parses JSON results and diagnostic wrappers into independent canonical values', () => {
  const input = { status: 'partial', result: { ...result(), cards: [card('b'), { ...card('a'), review: ['장수 확인', '각성 확인', '장수 확인'] }] } };
  const snapshot = structuredClone(input);
  const parsed = parseScanResult(input);
  assert.deepEqual(parsed.cards.map(card => card.id), ['a', 'b']);
  assert.deepEqual(parsed.cards[0].review, ['각성 확인', '장수 확인']);
  assert.deepEqual(parseScanResult(JSON.stringify(input)), parsed);
  assert.deepEqual(parseScanResult(JSON.stringify(parsed)), parsed);
  parsed.cards[0].review.push('changed');
  parsed.cards[1].name = 'changed';
  assert.deepEqual(input, snapshot);
});

test('comparison ignores card and reason ordering without altering either input', () => {
  const before = { ...result(), cards: [{ ...card('b'), review: ['장수 확인', '각성 확인'] }, card('a')] };
  const after = { ...before, cards: [card('a'), { ...card('b'), review: ['각성 확인', '장수 확인'] }] };
  const copies = structuredClone([before, after]);
  assert.deepEqual(compareScanResults(before, after), {
    scope: 'full', checked: { cards: 'all', headers: true, extraIds: true }, same: true, exactSame: true,
    missing: [], added: [], changed: [], headers: [],
  });
  assert.deepEqual([before, after], copies);
});

test('null and observed zero remain distinct in fields and headers', () => {
  const before = { ...result(), expected: null, cards: [{ ...card(), awakening: null, extraCopies: null }] };
  const after = { ...result(), expected: 0, experience: 0 };
  const difference = compareScanResults(before, after);
  assert.equal(difference.same, false);
  assert.deepEqual(difference.changed, [{ id: 'a', changes: [
    { field: 'awakening', before: null, after: 0 }, { field: 'extraCopies', before: null, after: 0 },
  ] }]);
  assert.deepEqual(difference.headers, [
    { field: 'expected', before: null, after: 0 }, { field: 'experience', before: null, after: 0 },
  ]);
});

test('missing, extra and changed cards are reported by stable ID and exact field', () => {
  const before = { ...result(), cards: [card('missing'), card('changed')] };
  const after = { ...result(), read: 2, unidentified: 1, cards: [card('added'), { ...card('changed'), name: '새 이름', extraCopies: 1, review: ['확인 필요'] }] };
  const difference = compareScanResults(before, after);
  assert.deepEqual(difference.missing, [card('missing')]);
  assert.deepEqual(difference.added, [card('added')]);
  assert.deepEqual(difference.changed, [{ id: 'changed', changes: [
    { field: 'name', before: '카드 changed', after: '새 이름' },
    { field: 'extraCopies', before: 0, after: 1 },
    { field: 'review', before: [], after: ['확인 필요'] },
  ] }]);
  assert.deepEqual(difference.headers, [{ field: 'read', before: 1, after: 2 }, { field: 'unidentified', before: 0, after: 1 }]);
  difference.missing[0].name = 'output changed';
  assert.equal(before.cards[0].name, '카드 missing');
});

test('partial reference comparison does not certify unlabelled cards or headers', () => {
  const reference = result();
  const actual = { ...result(), expected: 2, read: 2, experience: 0, cards: [card(), card('b')] };
  const partial = compareScanResults(reference, actual, { scope: 'partial' });
  assert.equal(partial.same, true);
  assert.equal(partial.exactSame, false);
  assert.deepEqual(partial.checked, { cards: 'reference', headers: false, extraIds: false });
  assert.deepEqual(partial.added, [card('b')]);
  assert.equal(partial.headers.length, 3);
  assert.equal(compareScanResults(reference, actual).same, false);
  assert.equal(compareScanResults(reference, { ...actual, cards: [card('b')] }, { scope: 'partial' }).same, false);
  assert.equal(compareScanResults(reference, { ...actual, cards: [{ ...card(), extraCopies: null }] }, { scope: 'partial' }).same, false);
});

test('every awakening cap is enforced while unread fields and growthless zero-awakening cards are preserved', () => {
  for (let awakening = 0; awakening <= 5; awakening++) {
    const maximum = 15 - awakening * (awakening + 1) / 2;
    const valid = { ...result(), cards: [{ ...card(), awakening, extraCopies: maximum }] };
    assert.equal(parseScanResult(valid).cards[0].extraCopies, maximum);
    assert.throws(() => parseScanResult({ ...valid, cards: [{ ...valid.cards[0], extraCopies: maximum + 1 }] }));
  }
  assert.equal(parseScanResult({ ...result(), cards: [{ ...card(), awakening: 0, extraCopies: 15 }] }).cards[0].extraCopies, 15);
  assert.equal(parseScanResult({ ...result(), cards: [{ ...card(), awakening: null, extraCopies: 15 }] }).cards[0].awakening, null);
  assert.equal(parseScanResult({ ...result(), cards: [{ ...card(), awakening: 5, extraCopies: null }] }).cards[0].extraCopies, null);
});

test('malformed documents, missing values, duplicate IDs and noninteger counters are rejected without coercion', () => {
  const invalid: unknown[] = [null, [], {}, '{bad json', { result: null }, { result: {} },
    { ...result(), cards: null }, { ...result(), cards: [card(), card()] }, { ...result(), cards: new Array(1) },
    { ...result(), cards: Array.from({ length: 1001 }, (_, i) => card(String(i))) },
    { ...result(), cards: [{ ...card(), id: '' }] }, { ...result(), cards: [{ ...card(), name: '  ' }] },
    { ...result(), cards: [{ ...card(), awakening: undefined }] }, { ...result(), cards: [{ ...card(), extraCopies: undefined }] },
    { ...result(), cards: [{ ...card(), review: null }] }, { ...result(), cards: [{ ...card(), review: [null] }] },
    { ...result(), cards: [{ ...card(), review: [''] }] }, { ...result(), cards: [{ ...card(), review: new Array(1) }] },
  ];
  for (const key of ['expected', 'read', 'unidentified', 'experience']) {
    for (const value of [-1, 1.5, '0', false, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      invalid.push({ ...result(), [key]: value });
    const missing = { ...result() } as Record<string, unknown>;
    delete missing[key]; invalid.push(missing);
  }
  for (const key of ['id', 'name', 'awakening', 'extraCopies', 'review']) {
    const missing = { ...card() } as Record<string, unknown>;
    delete missing[key]; invalid.push({ ...result(), cards: [missing] });
  }
  for (const key of ['awakening', 'extraCopies']) for (const value of [-1, 0.5, '0', false, NaN, Infinity, 16])
    invalid.push({ ...result(), cards: [{ ...card(), [key]: value }] });
  invalid.push({ ...result(), cards: [{ ...card(), awakening: 6 }] }, { ...result(), read: null }, { ...result(), unidentified: null });
  for (const value of invalid) assert.throws(() => parseScanResult(value));
  assert.throws(() => compareScanResults(result(), result(), { scope: 'typo' }));
  assert.throws(() => compareScanResults(result(), { ...result(), cards: [card(), card()] }));
});
