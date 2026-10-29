import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FieldDiagnosticImages} from '../src/features/card-scanner/field-diagnostic-images';

test('failure pixels are capture-ordered and reused only for exact pixels', () => {
  const images = new FieldDiagnosticImages(); let encoded = 0;
  images.capture('a', 2, 'pixels1', () => { encoded++; return 'one'; });
  images.capture('a', 3, 'pixels1', () => { throw Error('same pixels encoded twice'); });
  images.capture('a', 1, 'older', () => { throw Error('older capture replaced latest'); });
  assert.equal(images.get('a', 2), undefined);
  assert.equal(images.get('a', 3), 'one');
  images.resolved('a', 2); assert.equal(images.get('a', 3), 'one');
  images.capture('a', 4, 'pixels2', () => { encoded++; return 'two'; });
  assert.equal(encoded, 2);
  images.resolved('a', 4); assert.equal(images.get('a', 4), undefined);
});

test('failure images respect both image and encoded-byte budgets', () => {
  const images = new FieldDiagnosticImages(2, 7);
  images.capture('a', 1, 'a', () => 'aaa');
  images.capture('b', 1, 'b', () => 'bbb');
  images.capture('c', 1, 'c', () => 'ccc');
  assert.equal(images.get('a', 1), undefined);
  assert.equal(images.get('b', 1), 'bbb');
  images.capture('d', 1, 'd', () => 'ddddd');
  assert.equal(images.get('b', 1), undefined);
  assert.equal(images.get('c', 1), undefined);
  assert.equal(images.get('d', 1), 'ddddd');
  images.capture('e', 1, 'e', () => 'oversized');
  assert.equal(images.get('e', 1), undefined);
});
