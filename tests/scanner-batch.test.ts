import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SCANNER_BATCH_BYTES, MAX_SCANNER_BATCH_JOBS, runScannerBatch } from '../dev/scanner-batch';
import type { ScannerBatchJob, ScannerBatchProgress, ScannerBatchRunSummary } from '../dev/scanner-batch';

const CASE = 'a'.repeat(64), SOURCE = 'b'.repeat(64), FIELDS = 'c'.repeat(64), ARCHIVE = 'd'.repeat(64);
const job = (variant: ScannerBatchJob['variant'] = 'baseline', mode: ScannerBatchJob['mode'] = 'offline', caseId = CASE): ScannerBatchJob =>
  ({ caseId, variant, mode });
function summary(selected: ScannerBatchJob, changed: Partial<ScannerBatchRunSummary> = {}): ScannerBatchRunSummary {
  return { completed: true, outcome: 'completed', expected: 2, read: 2, review: 0, unknown: 0,
    cardFieldsHash: FIELDS, sourceStart: SOURCE, sourceEnd: SOURCE, emptySeed: true,
    archive: { ref: `cases/${selected.caseId}/runs/run-${ARCHIVE}.json`, sha256: ARCHIVE }, elapsedMs: 12.5,
    elapsedKind: selected.mode === 'offline' ? 'offline-preparation-and-processing' : 'live-preparation-playback-and-drain', ...changed };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('fractional, gray and contrast comparisons keep their own partner and never compare experiments to each other', async () => {
  const plan = [job('fractional'), job('gray'), job('contrast'), job()];
  const seen: ScannerBatchJob[] = [];
  const result = await runScannerBatch(plan, {run: async selected => {
    seen.push(selected);
    return summary(selected, selected.variant === 'fractional' ? {cardFieldsHash:'e'.repeat(64),unknown:1} : {});
  }});
  assert.deepEqual(seen, plan);
  assert.equal(result.version, 2);
  assert.equal(result.comparisons.length, 3);
  const fractional = result.comparisons.find(item => item.variant === 'fractional')!;
  assert.equal(fractional.baselineIndex, 3);
  assert.equal(fractional.variantIndex, 0);
  assert.equal(fractional.cardFieldsEqual, false);
  assert.deepEqual(fractional.unknown, {baseline:0,variant:1});
  assert.equal(result.comparisons.find(item => item.variant === 'gray')!.cardFieldsEqual, true);
  const contrast = result.comparisons.find(item => item.variant === 'contrast')!;
  assert.equal(contrast.baselineIndex, 3);
  assert.equal(contrast.variantIndex, 2);
  assert.equal(contrast.cardFieldsEqual, true);
  const unpaired = await runScannerBatch([job('gray'), job('fractional'), job('contrast')], {run:async selected=>summary(selected)});
  assert.deepEqual(unpaired.comparisons, []);
});

test('fixed plan preserves order and never overlaps active work, cleanup or archiving', async () => {
  const plan = [job('gray'), job('baseline'), job('gray', 'live')], events: string[] = [];
  const cleanup = deferred(), enteredCleanup = deferred();
  let active = 0;
  const pending = runScannerBatch(plan, { run: async selected => {
    assert.equal(active++, 0);
    events.push(`start:${selected.variant}:${selected.mode}`);
    if (events.length === 1) { enteredCleanup.resolve(); await cleanup.promise; }
    events.push(`archived-and-cleaned:${selected.variant}:${selected.mode}`);
    active--; return summary(selected);
  } });
  await enteredCleanup.promise;
  assert.deepEqual(events, ['start:gray:offline']);
  cleanup.resolve();
  const result = await pending;
  assert.equal(result.status, 'completed'); assert.equal(result.clean, true);
  assert.deepEqual(result.runs.map(run => run.job), plan);
  assert.deepEqual(events, ['start:gray:offline', 'archived-and-cleaned:gray:offline',
    'start:baseline:offline', 'archived-and-cleaned:baseline:offline', 'start:gray:live', 'archived-and-cleaned:gray:live']);
  assert.equal(result.comparisons.length, 1); // A different timing mode has no partner.
  assert.equal(result.comparisons[0].baselineIndex, 1); assert.equal(result.comparisons[0].variantIndex, 0);
});

test('invalid and duplicate plans reject before starting any run without truncating an oversized plan', async () => {
  let calls = 0;
  const options = { run: async (selected: ScannerBatchJob) => { calls++; return summary(selected); } };
  await assert.rejects(runScannerBatch([job(), job()], options), /Duplicate/);
  await assert.rejects(runScannerBatch([], options), /ordered jobs/);
  await assert.rejects(runScannerBatch(Array.from({ length: MAX_SCANNER_BATCH_JOBS + 1 }, (_, index) =>
    job('baseline', 'offline', index.toString(16).padStart(64, '0'))), options), /ordered jobs/);
  await assert.rejects(runScannerBatch([job('baseline', 'offline', 'bad')], options), /Invalid/);
  await assert.rejects(runScannerBatch([{ ...job(), variant: { toString: () => 'baseline' } } as unknown as ScannerBatchJob], options), /Invalid/);
  assert.equal(calls, 0);
});

test('32 distinct jobs fit the fixed aggregate budget and retain all results', async () => {
  const plan = Array.from({ length: MAX_SCANNER_BATCH_JOBS }, (_, index) =>
    job('baseline', 'offline', index.toString(16).padStart(64, '0')));
  const result = await runScannerBatch(plan, { run: async selected => summary(selected) });
  assert.equal(result.status, 'completed'); assert.equal(result.runs.length, MAX_SCANNER_BATCH_JOBS);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_SCANNER_BATCH_BYTES);
});

test('recognition mismatch continues, retains unknown expected as null and separates semantic equality from quantities', async () => {
  let calls = 0;
  const result = await runScannerBatch([job(), job('gray')], { run: async selected => {
    calls++;
    return summary(selected, selected.variant === 'baseline'
      ? { expected: null, review: 1, unknown: 2 }
      : { expected: 3, read: 2, cardFieldsHash: 'e'.repeat(64) });
  } });
  assert.equal(calls, 2); assert.equal(result.status, 'completed'); assert.equal(result.clean, false);
  assert.equal(result.runs[0].summary.expected, null); assert.equal(result.runs[0].quantityMatches, null);
  assert.equal(result.runs[1].quantityMatches, false);
  assert.equal(result.comparisons[0].cardFieldsEqual, false);
  assert.deepEqual(result.comparisons[0].quantity, {
    baseline: { expected: null, read: 2, matches: null }, variant: { expected: 3, read: 2, matches: false },
  });
  assert.deepEqual(result.comparisons[0].unknown, { baseline: 2, variant: 0 });
  assert.deepEqual(result.comparisons[0].review, { baseline: 1, variant: 0 });
});

test('an explicitly observed zero is separate from an unknown inventory size', async () => {
  const result = await runScannerBatch([job(), job('gray')], { run: async selected =>
    summary(selected, { expected: selected.variant === 'baseline' ? 0 : null, read: 0 }) });
  assert.equal(result.runs[0].quantityMatches, true); assert.equal(result.runs[0].clean, true);
  assert.equal(result.runs[1].quantityMatches, null); assert.equal(result.runs[1].clean, false);
});

test('source drift across cases stops with the changed summary retained and no cross-version comparison', async () => {
  let calls = 0;
  const changed = 'e'.repeat(64);
  const result = await runScannerBatch([job(), job('gray'), job('baseline', 'live')], { run: async selected => {
    calls++; return summary(selected, calls === 2 ? { sourceStart: changed, sourceEnd: changed } : {});
  } });
  assert.equal(calls, 2); assert.equal(result.status, 'partial'); assert.equal(result.sourceDigest, SOURCE);
  assert.equal(result.runs[1].summary.sourceStart, changed); assert.equal(result.runs[1].executionSucceeded, false);
  assert.equal(result.comparisons.length, 0); assert.equal(result.diagnostics[0].code, 'source-changed');
});

test('source drift inside the first run also stops the batch', async () => {
  let calls = 0;
  const result = await runScannerBatch([job(), job('gray')], { run: async selected => {
    calls++; return summary(selected, { sourceEnd: 'e'.repeat(64) });
  } });
  assert.equal(calls, 1); assert.equal(result.runs.length, 1); assert.equal(result.status, 'partial');
  assert.equal(result.diagnostics[0].code, 'source-changed');
});

test('a missing immutable archive retains the active summary and stops before overwriting the report', async () => {
  let calls = 0;
  const result = await runScannerBatch([job(), job('gray'), job('gray', 'live')], { run: async selected => {
    calls++; return summary(selected, calls === 2 ? { archive: null } : {});
  } });
  assert.equal(calls, 2); assert.equal(result.status, 'partial'); assert.equal(result.runs[1].summary.archive, null);
  assert.equal(result.comparisons.length, 0); assert.equal(result.diagnostics[0].code, 'archive-missing');
});

test('abort waits for late cleanup even when the runner ignores cancellation and never starts the next job', async () => {
  const controller = new AbortController(), started = deferred(), cleanup = deferred();
  let calls = 0, settled = false;
  const pending = runScannerBatch([job(), job('gray')], { signal: controller.signal, run: async selected => {
    calls++; started.resolve(); await cleanup.promise; return summary(selected);
  } });
  void pending.then(() => { settled = true; });
  await started.promise; controller.abort();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false); assert.equal(calls, 1);
  cleanup.resolve();
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(calls, 1); assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].executionSucceeded, false); assert.equal(result.clean, false);
});

test('an already aborted signal starts no work', async () => {
  let calls = 0;
  const result = await runScannerBatch([job()], { signal: AbortSignal.abort(), run: async selected => { calls++; return summary(selected); } });
  assert.equal(calls, 0); assert.equal(result.status, 'cancelled'); assert.equal(result.runs.length, 0);
});

test('runner rejection preserves earlier results and a bounded failure diagnostic', async () => {
  let calls = 0;
  const result = await runScannerBatch([job(), job('gray'), job('gray', 'live')], { run: async selected => {
    if (++calls === 2) throw new Error('write failed '.repeat(1000));
    return summary(selected);
  } });
  assert.equal(calls, 2); assert.equal(result.runs.length, 1); assert.equal(result.status, 'partial');
  assert.equal(result.diagnostics[0].code, 'runner-error'); assert.ok(result.diagnostics[0].message.length <= 512);
});

test('failed execution stops while an archived recognition-only failure can continue', async () => {
  let calls = 0;
  const result = await runScannerBatch([job(), job('gray')], { run: async selected => {
    calls++; return summary(selected, { completed: false, outcome: 'failed', review: 1 });
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'partial'); assert.equal(result.runs.length, 1);
  assert.equal(result.diagnostics[0].code, 'run-incomplete'); assert.equal(result.runs[0].executionSucceeded, false);
});

test('progress snapshots, runner job arguments and runner-owned metadata cannot mutate the plan or accepted results', async () => {
  const plan = [job(), job('gray')], snapshots: ScannerBatchProgress[] = [], originals: ScannerBatchRunSummary[] = [];
  const result = await runScannerBatch(plan, {
    run: async selected => {
      const value = summary(selected); originals.push(value); selected.caseId = 'f'.repeat(64); return value;
    },
    onProgress: progress => {
      snapshots.push(progress);
      progress.result.jobs.length = 0;
      if (progress.result.runs[0]) {
        progress.result.runs[0].summary.read = 999;
        progress.result.runs[0].summary.archive!.ref = 'changed';
        originals[0].read = 777; originals[0].archive!.ref = 'also changed';
      }
      throw new Error('observer failed');
    },
  });
  assert.equal(result.status, 'completed'); assert.equal(result.runs.length, 2); assert.equal(result.jobs.length, 2);
  assert.equal(plan.length, 2); assert.equal(plan[0].caseId, CASE); assert.equal(result.runs[0].summary.read, 2);
  assert.equal(result.runs[0].summary.archive!.ref, `cases/${CASE}/runs/run-${ARCHIVE}.json`);
  assert.equal(result.comparisons[0].cardFieldsEqual, true);
  assert.ok(snapshots.length <= 2 * plan.length + 1);
});

test('asynchronous observer rejection is contained and never delays execution', async () => {
  const observer = deferred();
  const result = await runScannerBatch([job(), job('gray')], { run: async selected => summary(selected),
    onProgress: async () => { await observer.promise; throw new Error('late observer failure'); } });
  assert.equal(result.status, 'completed'); assert.equal(result.runs.length, 2);
  observer.resolve(); await new Promise(resolve => setImmediate(resolve));
});

test('malformed summaries stop, never coerce values, and do not retain full report or pixel payloads', async t => {
  const malformed: Array<[string, (selected: ScannerBatchJob) => unknown, string]> = [
    ['nonempty seed', selected => ({ ...summary(selected), emptySeed: false }), 'nonempty-seed'],
    ['missing field', selected => { const value = { ...summary(selected) } as Partial<ScannerBatchRunSummary>; delete value.read; return value; }, 'malformed-summary'],
    ['null read', selected => ({ ...summary(selected), read: null }), 'malformed-summary'],
    ['string expected', selected => ({ ...summary(selected), expected: '2' }), 'malformed-summary'],
    ['negative count', selected => ({ ...summary(selected), unknown: -1 }), 'malformed-summary'],
    ['fractional count', selected => ({ ...summary(selected), review: 0.5 }), 'malformed-summary'],
    ['non-finite elapsed', selected => ({ ...summary(selected), elapsedMs: Infinity }), 'malformed-summary'],
    ['wrong elapsed mode', selected => ({ ...summary(selected), elapsedKind: 'live-preparation-playback-and-drain' }), 'malformed-summary'],
    ['obsolete elapsed label', selected => ({ ...summary(selected), elapsedKind: 'offline-processing' }), 'malformed-summary'],
    ['contradictory outcome', selected => ({ ...summary(selected), completed: false }), 'malformed-summary'],
    ['wrong archive case', selected => ({ ...summary(selected), archive: { ref: `cases/${'f'.repeat(64)}/runs/run-${ARCHIVE}.json`, sha256: ARCHIVE } }), 'malformed-summary'],
    ['report payload', selected => ({ ...summary(selected), frames: new Array(1000).fill('PRIVATE-PIXELS') }), 'malformed-summary'],
    ['oversized field', selected => ({ ...summary(selected), cardFieldsHash: 'PRIVATE-PIXELS'.repeat(10000) }), 'summary-too-large'],
    ['oversized archive', selected => ({ ...summary(selected), archive: { ref: 'PRIVATE-PIXELS'.repeat(10000), sha256: ARCHIVE } }), 'summary-too-large'],
    ['getter', selected => Object.defineProperty(summary(selected), 'read', { get() { throw new Error('must not execute getter'); } }), 'malformed-summary'],
  ];
  for (const [name, makeSummary, code] of malformed) await t.test(name, async () => {
    let calls = 0;
    const result = await runScannerBatch([job(), job('gray')], { run: async selected => { calls++; return makeSummary(selected); } });
    assert.equal(calls, 1); assert.equal(result.status, 'partial'); assert.equal(result.runs.length, 0);
    assert.equal(result.sourceDigest, null); assert.equal(result.diagnostics[0].code, code);
    assert.equal(JSON.stringify(result).includes('PRIVATE-PIXELS'), false);
    assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_SCANNER_BATCH_BYTES);
  });
});

test('valid summaries for different case IDs or modes never produce a semantic pair', async () => {
  const result = await runScannerBatch([job(), job('gray', 'live'), job('gray', 'offline', 'f'.repeat(64))],
    { run: async selected => summary(selected) });
  assert.equal(result.status, 'completed'); assert.equal(result.comparisons.length, 0);
});
