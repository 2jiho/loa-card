import test from 'node:test';
import assert from 'node:assert/strict';
import {scanStateAfterIncomplete} from '../src/app/scan-state-fallback';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';

test('an interrupted scan keeps its final state, then the previous list, never a blank screen', () => {
  const previous = {status: '이전 목록'} as ScannerState;
  const final = {status: '이번 스캔'} as ScannerState;
  assert.equal(scanStateAfterIncomplete(final, previous), final, 'completed/partial final state wins');
  assert.equal(scanStateAfterIncomplete(undefined, previous), previous, 'no final state falls back to the visible list');
  assert.equal(scanStateAfterIncomplete(undefined, null), null, 'a first run with no previous list stays empty');
});
