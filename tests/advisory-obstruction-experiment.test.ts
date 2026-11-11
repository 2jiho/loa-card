import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AdvisoryObstructionExperiment} from '../src/features/card-scanner/session/advisory-obstruction-experiment';
import {timedCaptureOrder} from '../src/features/card-scanner/session/live-scan-policy';

const source={sessionId:'s',acquisitionFrameId:4,processingFrame:2,observationId:'3',captureTime:2,slot:5,pixelKey:'run/2',phase:'input' as const};
const newer=timedCaptureOrder(0,3,0),sameFrame=timedCaptureOrder(0,2,39);
test('sampled advisory requires all current card names and fields newer than the event',()=>{
 const e=new AdvisoryObstructionExperiment('s',0);
 assert.equal(e.pending(2,['a','b'],new Map(),new Map()),0,'no sampled candidate is not proof of no obstruction');
 e.notice(source);
 assert.equal(e.pending(2,['a','b'],new Map([['a',newer],['b',newer]]),new Map([['a',newer],['b',sameFrame]])),1);
 assert.equal(e.needsProof('b',new Map([['b',newer]]),new Map([['b',sameFrame]])),true);
 assert.equal(e.pending(2,['a','b'],new Map([['a',newer],['b',newer]]),new Map([['a',newer],['b',newer]])),0);
 assert.deepEqual(e.snapshot().records,[source]);assert.equal(e.snapshot().readerPixelsVerified,false);
 assert.equal(e.snapshot().scope,'sampled-advisory-not-complete');
});
test('location, matching totals, missing fields or same-timestamp frames cannot discharge an advisory',()=>{
 const e=new AdvisoryObstructionExperiment('s',0);e.notice(source);
 assert.equal(e.pending(2,['a','b'],new Map([['a',sameFrame],['b',sameFrame]]),new Map([['a',sameFrame],['b',sameFrame]])),2);
 assert.equal(e.pending(2,['a'],new Map([['a',newer]]),new Map([['a',newer]])),1);
 assert.equal(e.pending(null,['a'],new Map([['a',newer]]),new Map([['a',newer]])),1);
});
test('unbound, malformed or dropped notices fail closed even when later cards appear complete',()=>{
 for(const bad of [{...source,sessionId:'other'},{...source,acquisitionFrameId:0},{...source,captureTime:NaN},{...source,pixelKey:''},{...source,slot:40}]){
  const e=new AdvisoryObstructionExperiment('s',0);e.notice(bad);
  assert.equal(e.pending(1,['a'],new Map([['a',newer]]),new Map([['a',newer]])),1);
  assert.equal(e.snapshot().noticeRecordsComplete,false);
 }
 const e=new AdvisoryObstructionExperiment('s',0,1);e.notice(source);e.notice({...source,acquisitionFrameId:5,captureTime:3});
 assert.equal(e.pending(1,['a'],new Map([['a',newer]]),new Map([['a',newer]])),1);
 assert.equal(e.snapshot().noticeRecordsComplete,false);
});
