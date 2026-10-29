import test from 'node:test';
import assert from 'node:assert/strict';
import {deferCompletionForMetadata, waitForReaderMetadata} from '../src/features/card-scanner/metadata-scheduling';
import type {MetadataWork} from '../src/features/card-scanner/metadata-scheduling';

function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}

test('pending metadata blocks only its primary OCR session, while independent work and acquisition continue', async () => {
  const reading = deferred(), events: string[] = [];
  let pending = true, settlements = 0;
  const metadata: MetadataWork = {
    pending: () => pending,
    settle: () => { settlements++; return reading.promise; },
  };
  const read = async (primary: boolean, name: string) => {
    await waitForReaderMetadata(primary, metadata);
    events.push(name);
  };
  const primary = read(true, 'primary');
  await Promise.all([
    read(false, 'visual'), read(false, 'independent-ocr'),
    Promise.resolve().then(() => { events.push('capture'); }),
  ]);
  assert.equal(settlements, 1);
  assert.deepEqual(new Set(events), new Set(['visual', 'independent-ocr', 'capture']));
  pending = false; reading.resolve(); await primary;
  assert.equal(events.at(-1), 'primary');
});

test('the primary session drains a newer metadata job before starting its card OCR', async () => {
  const first = deferred(), newer = deferred();
  let index = 0, started = false;
  const jobs = [first, newer];
  const metadata: MetadataWork = {
    pending: () => index < jobs.length,
    settle: () => jobs[index].promise.then(() => { index++; }),
  };
  const primary = waitForReaderMetadata(true, metadata).then(() => { started = true; });
  first.resolve();
  await first.promise; await Promise.resolve();
  assert.equal(index, 1); assert.equal(started, false);
  newer.resolve(); await primary;
  assert.equal(index, 2); assert.equal(started, true);
});

test('the primary session still settles an initial header when no periodic metadata is pending', async () => {
  let settled = false;
  await waitForReaderMetadata(true, {pending: () => false, settle: async () => { settled = true; }});
  assert.equal(settled, true);
});

test('incomplete name coverage never reserves capture or waits for a metadata refresh', async () => {
  const reading = deferred();
  let settlements = 0, paused = false, captures = 0;
  const metadata: MetadataWork = {pending: () => true, settle: () => { settlements++; return reading.promise; }};
  const deferredCompletion = await deferCompletionForMetadata(false, metadata, value => { paused = value; });
  if (!paused) captures++;
  await waitForReaderMetadata(false, metadata);
  assert.equal(deferredCompletion, false); assert.equal(settlements, 0);
  assert.equal(paused, false); assert.equal(captures, 1);
  reading.resolve();
});

test('plausible completion reserves capture only while its pending metadata settles', async () => {
  const reading = deferred(), pauses: boolean[] = [];
  let pending = true, completed = false;
  const metadata: MetadataWork = {pending: () => pending, settle: () => reading.promise};
  const verification = deferCompletionForMetadata(true, metadata, value => { pauses.push(value); })
    .then(value => { completed = true; return value; });
  assert.deepEqual(pauses, [true]); assert.equal(completed, false);
  pending = false; reading.resolve();
  assert.equal(await verification, true); assert.deepEqual(pauses, [true, false]);
  assert.equal(await deferCompletionForMetadata(true, metadata, value => { pauses.push(value); }), false);
  assert.deepEqual(pauses, [true, false]);
});

test('metadata rejection propagates and always releases completion capture reservation', async () => {
  const reading = deferred(), pauses: boolean[] = [], error = new Error('metadata failed');
  const metadata: MetadataWork = {pending: () => true, settle: () => reading.promise};
  const verification = deferCompletionForMetadata(true, metadata, value => { pauses.push(value); });
  const rejected = assert.rejects(verification, error);
  reading.reject(error); await rejected;
  assert.deepEqual(pauses, [true, false]);
  await assert.rejects(waitForReaderMetadata(true, metadata), error);
});
