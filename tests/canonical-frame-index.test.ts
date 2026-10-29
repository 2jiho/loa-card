import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalFrameIndex} from '../src/features/card-scanner/canonical-frame-index';
import type {CanonicalFrameCommit} from '../src/features/card-scanner/canonical-frame-index';

const hash='1'.repeat(64);
const frame=(id:number,overrides:Partial<CanonicalFrameCommit>={}):CanonicalFrameCommit=>({
  sourceFrameId:id,frameId:id,offset:(id-1)*100,endOffset:id*100,width:2,height:2,
  captureTime:id,arrivalOrder:id,key:id===1,pixelHash:hash,role:'input',...overrides,
});

test('source identity differs from archive append order and originals sort by capture time then arrival',()=>{
  const index=new CanonicalFrameIndex();
  index.append(frame(1,{sourceFrameId:90,captureTime:3,arrivalOrder:1}));
  index.append(frame(2,{sourceFrameId:7,captureTime:1,arrivalOrder:3,role:'backup'}));
  index.append(frame(3,{sourceFrameId:12,captureTime:1,arrivalOrder:2}));
  assert.deepEqual(index.snapshotOriginals().map(value=>value.sourceFrameId),[12,7,90]);
  assert.equal(index.get(7)?.frameId,2);
  assert.equal(index.stats().entries,3,'matching pixel hashes do not merge distinct immutable captures');
});

test('a finite original snapshot cannot grow or mutate when recovery appends or late facts arrive',()=>{
  const index=new CanonicalFrameIndex();index.append(frame(1));index.append(frame(2,{role:'backup'}));
  const before=index.snapshotOriginals();
  index.addRole(1,'recovery');index.attachAnalysisReceipt(1,42);
  index.append(frame(3,{captureTime:.5,role:'recovery'}));
  assert.deepEqual(before.map(value=>value.sourceFrameId),[1,2]);
  assert.deepEqual(before[0].roles,['input']);assert.equal(before[0].analysisReceiptId,undefined);
  assert.deepEqual(index.get(1)?.roles,['input','recovery']);assert.equal(index.get(1)?.analysisReceiptId,42);
  assert.equal(index.snapshotOriginals().length,2,'recovery-only pixels are not original input');
  index.addRole(3,'backup');assert.deepEqual(index.snapshotOriginals().map(value=>value.sourceFrameId),[3,1,2]);
  assert.equal(before.length,2);
  assert.throws(()=>{(before as CanonicalFrameCommit[]).push(frame(4));},TypeError);
});

test('reusing a source and repeating a receipt never duplicates bytes or changes freshness metadata',()=>{
  const index=new CanonicalFrameIndex();const original=index.append(frame(1));
  index.addRole(1,'backup');index.addRole(1,'recovery');const same=index.addRole(1,'recovery');
  const receipt=index.attachAnalysisReceipt(1,5);assert.equal(index.attachAnalysisReceipt(1,5),receipt);
  const newerReceipt=index.attachAnalysisReceipt(1,6);
  assert.equal(newerReceipt.analysisReceiptId,6);assert.equal(receipt.analysisReceiptId,5);
  assert.equal(index.stats().entries,1);assert.equal(index.stats().indexedFrameBytes,100);
  assert.equal(same.captureTime,original.captureTime);assert.equal(same.pixelHash,original.pixelHash);
  assert.equal(same.offset,original.offset);assert.equal(same.frameId,original.frameId);
});

test('random access starts at the nearest key and includes intervening physical frames and event gaps',()=>{
  const index=new CanonicalFrameIndex();
  index.append(frame(1,{offset:40,endOffset:140}));
  index.append(frame(2,{offset:170,endOffset:270}));
  index.append(frame(3,{offset:300,endOffset:400,key:true}));
  index.append(frame(4,{offset:430,endOffset:530}));
  assert.deepEqual(index.decodeRange(2),{sourceFrameId:2,frameId:2,keyFrameId:1,offset:40,endOffset:270,frameIds:[1,2],decodeBytes:32});
  assert.deepEqual(index.decodeRange(4),{sourceFrameId:4,frameId:4,keyFrameId:3,offset:300,endOffset:530,frameIds:[3,4],decodeBytes:32});
  assert.equal(index.stats().indexedFrameBytes,400);assert.equal(index.stats().indexedEndOffset,530);
});

test('the first frame and every resize require a key before append mutates the index',()=>{
  const index=new CanonicalFrameIndex();
  assert.equal(index.keyRequired(2,2),true);
  assert.throws(()=>index.append(frame(1,{key:false})),/keyframe/);assert.equal(index.stats().entries,0);
  index.append(frame(1));assert.equal(index.keyRequired(2,2),false);assert.equal(index.keyRequired(3,2),true);
  assert.throws(()=>index.append(frame(2,{width:3,key:false})),/keyframe/);assert.equal(index.stats().entries,1);
  index.append(frame(2,{width:3,key:true}));assert.equal(index.decodeRange(2).keyFrameId,2);
});

test('delta count and decoded-byte budgets bound random access independently of compressed payload size',()=>{
  const count=new CanonicalFrameIndex({maxDeltaFrames:2});count.append(frame(1));count.append(frame(2));count.append(frame(3));
  assert.equal(count.keyRequired(2,2),true);
  assert.throws(()=>count.append(frame(4)),/bounded keyframe/);assert.equal(count.stats().entries,3);
  count.append(frame(4,{key:true}));assert.equal(count.keyRequired(2,2),false);
  const bytes=new CanonicalFrameIndex({maxDecodeBytes:48});
  bytes.append(frame(1));bytes.append(frame(2));bytes.append(frame(3));assert.equal(bytes.decodeRange(3).decodeBytes,48);
  assert.equal(bytes.keyRequired(2,2),true);assert.throws(()=>bytes.append(frame(4)),/bounded keyframe/);
  bytes.append(frame(4,{key:true}));assert.equal(bytes.decodeRange(4).decodeBytes,16);
});

test('one large key is supported without extending it past the decode-chain budget',()=>{
  const index=new CanonicalFrameIndex({maxDecodeBytes:48});
  index.append(frame(1,{width:4,height:4}));assert.equal(index.decodeRange(1).decodeBytes,64);
  assert.equal(index.keyRequired(4,4),true);
  assert.throws(()=>index.append(frame(2,{width:4,height:4})),/keyframe/);
  index.append(frame(2,{width:4,height:4,key:true}));assert.deepEqual(index.decodeRange(2).frameIds,[2]);
});

test('default full-screen budget requires a new key after two 2560x1440 frames',()=>{
  const index=new CanonicalFrameIndex();
  index.append(frame(1,{width:2560,height:1440}));assert.equal(index.keyRequired(2560,1440),false);
  index.append(frame(2,{width:2560,height:1440}));assert.equal(index.keyRequired(2560,1440),true);
  assert.equal(index.decodeRange(2).decodeBytes,29_491_200);
});

test('entry and archive-end caps reject before mutation and never evict a dependency',()=>{
  const entries=new CanonicalFrameIndex({maxEntries:2});entries.append(frame(1));entries.append(frame(2));
  assert.throws(()=>entries.append(frame(3)),/capacity/);assert.equal(entries.stats().entries,2);
  assert.deepEqual(entries.decodeRange(2).frameIds,[1,2]);
  const bytes=new CanonicalFrameIndex({maxArchiveBytes:250});bytes.append(frame(1));
  assert.throws(()=>bytes.append(frame(2,{endOffset:251})),/capacity/);assert.equal(bytes.get(2),undefined);
  bytes.append(frame(2));assert.equal(bytes.stats().indexedEndOffset,200);
});

test('duplicate source IDs, archive-ID regressions and overlapping extents are conflicts',()=>{
  const index=new CanonicalFrameIndex();index.append(frame(1));
  for(const value of [frame(2,{sourceFrameId:1}),frame(2,{frameId:1}),frame(2,{offset:99})])
    assert.throws(()=>index.append(value),/already committed|conflict/);
  assert.equal(index.stats().entries,1);index.append(frame(2));assert.equal(index.stats().entries,2);
});

test('metadata is detached and frozen, including source timestamps and role arrays',()=>{
  const source={mediaTime:1.5,presentedFrames:3,frameTimestampUs:1_500_000};
  const input=frame(1,{source}),index=new CanonicalFrameIndex(),stored=index.append(input);
  source.mediaTime=50;(input as {captureTime:number}).captureTime=99;
  assert.equal(stored.source?.mediaTime,1.5);assert.equal(stored.captureTime,1);
  assert.throws(()=>{(stored.source as {mediaTime:number}).mediaTime=99;},TypeError);
  assert.throws(()=>{(stored.roles as string[]).push('recovery');},TypeError);
  assert.throws(()=>{(index.decodeRange(1).frameIds as number[]).push(9);},TypeError);
});

test('untrusted scalar fields, source handles and extension keys do not enter the index',()=>{
  const invalid:unknown[]=[null,[],{...frame(1),sourceFrameId:0},{...frame(1),frameId:1.2},
    {...frame(1),captureTime:NaN},{...frame(1),captureTime:-1},{...frame(1),arrivalOrder:-1},
    {...frame(1),offset:1,endOffset:1},{...frame(1),width:Infinity},{...frame(1),width:100_000,height:100_000},
    {...frame(1),key:1},{...frame(1),pixelHash:'a'},{...frame(1),role:'confirmed'},
    {...frame(1),source:{bitmap:{}}},{...frame(1),pixels:new Uint8Array(1)}];
  for(const value of invalid){const index=new CanonicalFrameIndex();assert.throws(()=>index.append(value as CanonicalFrameCommit));assert.equal(index.stats().entries,0);}
});

test('unknown references and invalid limits fail explicitly',()=>{
  for(const options of [{maxEntries:0},{maxEntries:100_001},{maxArchiveBytes:Infinity},{maxDeltaFrames:8},
    {maxDeltaFrames:1024},{maxDecodeBytes:0},{maxDecodeBytes:32*1024*1024+1}])
    assert.throws(()=>new CanonicalFrameIndex(options));
  const index=new CanonicalFrameIndex();assert.equal(index.get(1),undefined);
  assert.throws(()=>index.get(0));assert.throws(()=>index.decodeRange(1),/Unknown/);
  assert.throws(()=>index.addRole(1,'backup'),/Unknown/);assert.throws(()=>index.attachAnalysisReceipt(1,2),/Unknown/);
  index.append(frame(1));assert.throws(()=>index.attachAnalysisReceipt(1,0));
  assert.throws(()=>index.addRole(1,'invalid' as 'input'));
});
