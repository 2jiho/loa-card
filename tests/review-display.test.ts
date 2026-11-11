import test from 'node:test';
import assert from 'node:assert/strict';
import {knownReviewCardCount} from '../src/features/card-scanner/ui/review-display';

test('unidentified observations do not become card kinds',()=>{
  // Many unlinked observations do not establish any affected card identity.
  assert.equal(knownReviewCardCount([],[]),0);
  assert.equal(knownReviewCardCount([{id:'a'},{id:'b'}],[{id:'c'}]),3);
});

test('overlapping references to the same card count only once',()=>{
  assert.equal(knownReviewCardCount([{id:'a'},{id:'a'}],[{id:'a'},{id:'b'}]),2);
});
