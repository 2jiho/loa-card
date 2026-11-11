import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseUnknownSourcePolicy,sourceScopedUnknownEnabled} from '../src/features/card-scanner/session/unknown-source-policy';

test('the source policy requires an explicit dev opt-in and cannot be enabled in a production build',()=>{
  assert.equal(parseUnknownSourcePolicy(''),undefined);
  assert.equal(sourceScopedUnknownEnabled(true,undefined),false);
  const policy=parseUnknownSourcePolicy('?unknownPolicy=source-v2');
  assert.equal(policy,'source-v2');
  assert.equal(sourceScopedUnknownEnabled(true,policy),true);
  assert.equal(sourceScopedUnknownEnabled(false,policy),false);
  for(const search of ['?unknownPolicy=','?unknownPolicy=v2','?unknownPolicy=source-v2&unknownPolicy=source-v2'])
    assert.throws(()=>parseUnknownSourcePolicy(search));
});
