import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// These features may only rule out ambiguous artwork: they are not identity references.
export function auditPortraitCompetitors(payload, pins, catalog, atlas, screen) {
  if (!object(payload) || Object.keys(payload).sort().join(',') !== 'cards,kind,version' ||
      payload.version !== 1 || payload.kind !== 'client-atlas-competitor-only' || !object(payload.cards))
    throw new Error('Invalid portrait competitor schema');
  if (!object(pins) || !Object.keys(pins).length || !Array.isArray(catalog.cards) ||
      !object(atlas) || !object(screen.cards)) throw new Error('Invalid portrait competitor audit inputs');
  const expected = Object.keys(pins).sort(), actual = Object.keys(payload.cards).sort();
  if (expected.join(',') !== actual.join(',')) throw new Error('Unexpected portrait competitor IDs');
  for (const id of expected) {
    if (!/^\d+$/.test(id) || !/^[0-9a-f]{64}$/.test(pins[id]) ||
        catalog.cards.filter(card => card.id === id).length !== 1)
      throw new Error(`Invalid portrait competitor ID or pin: ${id}`);
    if (Object.hasOwn(atlas, id) || Object.hasOwn(screen.cards, id))
      throw new Error(`Portrait competitor already has an identity reference: ${id}`);
    const encoded = payload.cards[id];
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new Error(`Invalid portrait competitor encoding: ${id}`);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== 200 || bytes.toString('base64') !== encoded ||
        createHash('sha256').update(bytes).digest('hex') !== pins[id])
      throw new Error(`Invalid portrait competitor feature or hash: ${id}`);
  }
}
