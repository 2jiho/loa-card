import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { analyzeRecordingImpact } from '../scripts/analyze-recording-impact.mjs';

const chunk = (events: unknown[]) => ({
  data: gzipSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n'))).toString('base64'),
});

test('recording impact separates input and recovery work and retires resolved unknown groups', () => {
  const report = { execution: { complete: true, chunks: [chunk([
    { type: 'acquisition-capture', value: { phase: 'input', acquisitionFrameId: 1, quality: { usable: true } } },
    { type: 'acquisition-capture', value: { phase: 'recovery', acquisitionFrameId: 2, quality: { usable: false } } },
    { type: 'inventory-event', value: { kind: 'identity-accepted', id: 'card-a', source: { phase: 'input', observationId: 'a' } } },
    { type: 'inventory-event', value: { kind: 'identity-accepted', id: 'card-b', source: { phase: 'recovery', observationId: 'b' } } },
    { type: 'unknown-event', value: { kind: 'upsert', key: { kind: 'group', sessionId: 's', group: 1 }, source: { phase: 'input' } } },
    { type: 'unknown-event', value: { kind: 'upsert', key: { kind: 'group', sessionId: 's', group: 2 }, source: { phase: 'recovery' } } },
    { type: 'unknown-event', value: { kind: 'retire', key: { kind: 'group', sessionId: 's', group: 2 } } },
  ])] } };
  const result = analyzeRecordingImpact(report);
  assert.equal(result.traceComplete, true);
  assert.equal(result.phases.input.acquisitionFrames, 1);
  assert.equal(result.phases.input.usableCrops, 1);
  assert.equal(result.phases.input.acceptedObservations, 1);
  assert.equal(result.phases.input.uniqueCardIds, 1);
  assert.equal(result.phases.input.activeUnknownGroups, 1);
  assert.equal(result.phases.recovery.acquisitionFrames, 1);
  assert.equal(result.phases.recovery.uniqueCardIds, 1);
  assert.equal(result.recoveryOnlyCards, 1);
  assert.equal(result.phases.recovery.unknownGroups, 1);
  assert.equal(result.phases.recovery.unknownRetires, 1);
  assert.equal(result.phases.recovery.activeUnknownGroups, 0);
});

test('recording impact rejects absent or oversized traces', () => {
  assert.throws(() => analyzeRecordingImpact({}), /recorded execution trace/);
  assert.throws(() => analyzeRecordingImpact({ execution: { chunks: new Array(4097) } }), /bounded/);
});
