import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeScanEvidence} from '../src/features/card-scanner/session/scan-evidence-union';

const proof = [
  {id:'a',name:'카드 A'},{id:'b',name:'카드 B'},{id:'c',name:'카드 C'},
];
const scanner = [
  {id:'c',name:'카드 C'},{id:'d',name:'카드 D'},
];

test('merges proof and scanner identities without double counting',()=>{
  const result=mergeScanEvidence({expected:4,proof,scanner});
  assert.equal(result.proofCount,3);
  assert.equal(result.scannerCount,2);
  assert.equal(result.unionCount,4);
  assert.equal(result.missingCount,0);
  assert.equal(result.excessCount,0);
  assert.equal(result.coversExpected,true);
  assert.deepEqual(result.proofOnly,[{id:'a',name:'카드 A'},{id:'b',name:'카드 B'}]);
  assert.deepEqual(result.scannerOnly,[{id:'d',name:'카드 D'}]);
});

test('reports missing and excess identities instead of calling either complete',()=>{
  const missing=mergeScanEvidence({expected:5,proof,scanner});
  assert.equal(missing.missingCount,1);
  assert.equal(missing.coversExpected,false);
  const excess=mergeScanEvidence({expected:2,proof,scanner});
  assert.equal(excess.missingCount,0);
  assert.equal(excess.excessCount,2);
  assert.equal(excess.coversExpected,true,'coverage is not an exact-count claim');
});

test('rejects duplicate ids, conflicting names and invalid expected counts',()=>{
  assert.throws(()=>mergeScanEvidence({expected:4,proof:[{id:'a',name:'A'},{id:'a',name:'A'}],scanner}),/Duplicate proof/);
  assert.throws(()=>mergeScanEvidence({expected:4,proof:[{id:'a',name:'A'}],scanner:[{id:'a',name:'B'}]}),/Conflicting names/);
  assert.throws(()=>mergeScanEvidence({expected:4,proof,scanner:[{id:'',name:'X'}]}),/Invalid scanner card/);
  assert.throws(()=>mergeScanEvidence({expected:0,proof,scanner}),/Invalid expected/);
  assert.throws(()=>mergeScanEvidence({expected:4.5,proof,scanner}),/Invalid expected/);
});
