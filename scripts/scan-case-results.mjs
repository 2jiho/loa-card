const CARD_FIELDS = ['name', 'awakening', 'extraCopies', 'review'];
const HEADER_FIELDS = ['expected', 'read', 'unidentified', 'experience'];

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${path}: expected an object`);
  return value;
}

function required(value, key, path) {
  if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key}: missing field`);
  return value[key];
}

function integer(value, path, maximum = Number.MAX_SAFE_INTEGER, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new TypeError(`${path}: expected ${nullable ? 'null or ' : ''}an integer from 0 to ${maximum}`);
  return value;
}

function text(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${path}: expected a nonempty string`);
  return value;
}

/** Validate a reproduction result or a diagnostic's .result. Never infer a
 * missing field, replace null with zero, or mutate the supplied document.
 * Headers are independently observed values: card-count disagreement is data
 * to compare, not a reason to silently repair or discard a partial result. */
export function parseScanResult(input) {
  let value = typeof input === 'string' ? JSON.parse(input) : input;
  value = object(value, 'result');
  if (!Object.hasOwn(value, 'cards') && Object.hasOwn(value, 'result')) value = object(value.result, 'result');
  const rows = required(value, 'cards', 'result');
  if (!Array.isArray(rows) || rows.length > 1000) throw new TypeError('result.cards: expected at most 1000 cards');
  const ids = new Set();
  const cards = Array.from(rows, (row, index) => {
    const path = `result.cards[${index}]`;
    const card = object(row, path);
    const id = text(required(card, 'id', path), `${path}.id`);
    if (ids.has(id)) throw new TypeError(`${path}.id: duplicate card ID ${id}`);
    ids.add(id);
    const name = text(required(card, 'name', path), `${path}.name`);
    const awakening = integer(required(card, 'awakening', path), `${path}.awakening`, 5, true);
    const extraCopies = integer(required(card, 'extraCopies', path), `${path}.extraCopies`, 15, true);
    if (awakening !== null && extraCopies !== null && extraCopies > 15 - awakening * (awakening + 1) / 2)
      throw new TypeError(`${path}: impossible awakening and extraCopies combination`);
    const reasons = required(card, 'review', path);
    if (!Array.isArray(reasons)) throw new TypeError(`${path}.review: expected an array`);
    const review = [...new Set(Array.from(reasons, (reason, i) => text(reason, `${path}.review[${i}]`)))].sort();
    return { id, name, awakening, extraCopies, review };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    expected: integer(required(value, 'expected', 'result'), 'result.expected', Number.MAX_SAFE_INTEGER, true),
    read: integer(required(value, 'read', 'result'), 'result.read'),
    unidentified: integer(required(value, 'unidentified', 'result'), 'result.unidentified'),
    experience: integer(required(value, 'experience', 'result'), 'result.experience', Number.MAX_SAFE_INTEGER, true),
    cards,
  };
}

function sameValue(before, after) {
  return Array.isArray(before) && Array.isArray(after)
    ? before.length === after.length && before.every((value, index) => value === after[index])
    : before === after;
}

/** Equality against a reference, never a claim that an unverified baseline is
 * correct. Partial scope checks only the cards present in the reference. Other
 * cards and header differences remain visible but do not affect scoped `same`.
 * `exactSame` always includes every card and header in the comparison. */
export function compareScanResults(reference, actual, { scope = 'full' } = {}) {
  if (scope !== 'full' && scope !== 'partial') throw new TypeError('scope: expected full or partial');
  const before = parseScanResult(reference), after = parseScanResult(actual);
  const oldCards = new Map(before.cards.map(card => [card.id, card]));
  const newCards = new Map(after.cards.map(card => [card.id, card]));
  const missing = before.cards.filter(card => !newCards.has(card.id));
  const added = after.cards.filter(card => !oldCards.has(card.id));
  const changed = before.cards.flatMap(card => {
    const next = newCards.get(card.id);
    if (!next) return [];
    const changes = CARD_FIELDS.filter(field => !sameValue(card[field], next[field]))
      .map(field => ({ field, before: card[field], after: next[field] }));
    return changes.length ? [{ id: card.id, changes }] : [];
  });
  const headers = HEADER_FIELDS.filter(field => before[field] !== after[field])
    .map(field => ({ field, before: before[field], after: after[field] }));
  const exactSame = !missing.length && !added.length && !changed.length && !headers.length;
  return {
    scope,
    checked: { cards: scope === 'full' ? 'all' : 'reference', headers: scope === 'full', extraIds: scope === 'full' },
    same: scope === 'full' ? exactSame : !missing.length && !changed.length,
    exactSame,
    missing, added, changed, headers,
  };
}
