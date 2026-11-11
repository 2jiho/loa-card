import test from 'node:test';
import assert from 'node:assert/strict';
import {publishCanonicalSource,reportCanonicalSourceGap} from '../src/features/card-scanner/reproduction/canonical-source-publication';
import {entryParts,executionSummary} from '../src/features/card-scanner/reproduction/exact-recording-codec';

test('an unavailable exact source is recorded for both live and recovery input and cannot certify a complete recording',async()=>{
 for(const phase of ['input','recovery'] as const){
  const gaps:unknown[]=[],uses:unknown[][]=[];
  const capture={use:(...args:unknown[])=>uses.push(args)};
  publishCanonicalSource(capture,undefined,71,phase,1.25,undefined,{recordingExpected:true},value=>gaps.push(value));
  assert.deepEqual(uses,[]);
  assert.deepEqual(gaps,[{kind:'source-unavailable',sourceFrameId:null,acquisitionFrameId:71,phase,captureTime:1.25}]);
  const blob=new Blob(entryParts({kind:'event',seq:1,time:2,type:'canonical-source-gap',value:gaps[0]}));
  const summary=await executionSummary(blob,new AbortController().signal,{complete:true,dropped:0,events:1,frames:0});
  assert.equal(summary.recordingComplete,false);
 }
});

test('a missing source downgrades the producer even if the gap diagnostic throws',()=>{
 const facts:unknown[]=[],missing:string[]=[];
 const recorder={missingInput:(reason:string)=>missing.push(reason)};
 const capture={use:()=>assert.fail('missing source cannot be used')};
 for(const phase of ['input','recovery'] as const)
  publishCanonicalSource(capture,undefined,1,phase,2,undefined,{recordingExpected:true},fact=>
   reportCanonicalSourceGap(fact,value=>{facts.push(value);throw Error('trace unavailable');},recorder));
 assert.equal(facts.length,2);assert.equal(missing.length,2);
 assert.ok(missing.every(reason=>reason.includes('원본 입력')));
 assert.doesNotThrow(()=>reportCanonicalSourceGap(facts[0] as Parameters<typeof reportCanonicalSourceGap>[0],()=>{},
  {missingInput(){throw Error('recorder unavailable');}}));
});

test('persistent sources keep their exact use, ephemeral sources report the correct missing ID, and no recorder invents no gap',()=>{
 const calls:unknown[][]=[],gaps:unknown[]=[];
 const capture={use:(...args:unknown[])=>calls.push(args)},report=(value:unknown)=>gaps.push(value);
 publishCanonicalSource(capture,4,9,'recovery',2.5,undefined,{recordingExpected:true,preparedPersistent:true},report);
 assert.deepEqual(calls,[[4,9,'recovery',2.5,undefined]]);assert.deepEqual(gaps,[]);
 publishCanonicalSource(capture,5,10,'input',3,undefined,{recordingExpected:true,preparedPersistent:false},report);
 assert.deepEqual(gaps,[{kind:'ephemeral-unrecorded',sourceFrameId:5,acquisitionFrameId:10,phase:'input',captureTime:3}]);
 publishCanonicalSource(capture,undefined,11,'input',4,undefined,{recordingExpected:false},report);
 publishCanonicalSource(undefined,undefined,12,'input',5,undefined,{recordingExpected:true},report);
 assert.equal(gaps.length,1);assert.equal(calls.length,1);
});
