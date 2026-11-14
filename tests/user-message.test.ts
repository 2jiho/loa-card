import {test} from 'node:test';
import assert from 'node:assert/strict';
import {userMessage} from '../src/shared/user-message';

test('the app\'s own Korean messages are shown; a browser\'s English one is replaced', () => {
  assert.equal(userMessage(Error('CSV 첫 줄은 이름,각수,카드수여야 합니다.'),'대체'),'CSV 첫 줄은 이름,각수,카드수여야 합니다.');
  assert.equal(userMessage(new DOMException('Permission denied','NotAllowedError'),'대체'),'대체');
  assert.equal(userMessage(undefined,'대체'),'대체');
});
