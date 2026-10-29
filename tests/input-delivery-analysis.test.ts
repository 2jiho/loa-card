import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeInputDelivery} from '../scripts/analyze-input-delivery.mjs';

const trace=(values: {type:string;value:object}[])=>({complete:true,dropped:0,events:values.map((v,i)=>({...v,seq:i+1}))});
const frame=(playbackId:string,mediaTime:number,observedAtMs:number)=>({type:'source-playback',value:{type:'frame',playbackId,mediaTime,observedAtMs}});
test('delivery separates playback clocks and does not bridge different sources',()=>{
  const r=analyzeInputDelivery(trace([frame('a',1,100),frame('b',20,5000),frame('a',2,350)]));
  assert.equal(r.playback[0].maxMediaGapSeconds,1);assert.equal(r.playback[0].maxCallbackGapMs,250);
  assert.equal(r.playback[1].maxMediaGapSeconds,null);assert.equal(r.playback[1].maxCallbackGapMs,null);
});
test('acquisition counts distinct session/frame receipts without equating slots to frames',()=>{
  const capture=(sessionId:string)=>({type:'acquisition-capture',value:{sessionId,acquisitionFrameId:1,captureTime:2,phase:'recovery'}});
  const r=analyzeInputDelivery(trace([capture('a'),capture('a'),capture('b')]));
  assert.equal(r.acquisition[0].observations,3);assert.equal(r.acquisition[0].framesWithObservations,2);
});
test('missing and truncated traces never claim complete coverage',()=>{
  assert.equal(analyzeInputDelivery(trace([])).status,'unmeasured');
  const t=trace([frame('a',1,1)]);assert.equal(analyzeInputDelivery({...t,complete:false,dropped:3}).status,'partial');
  assert.throws(()=>analyzeInputDelivery({...t,events:[t.events[0],t.events[0]]}),/ordered/);
});
test('regressions are explicit instead of treated as negative gaps',()=>{
  const r=analyzeInputDelivery(trace([frame('a',5,100),frame('a',2,50)]));
  assert.equal(r.playback[0].mediaRegressions,1);assert.equal(r.playback[0].callbackRegressions,1);
  assert.equal(r.playback[0].maxMediaGapSeconds,null);
});

const location=(sessionId:string,processingFrame:number,state:string)=>({type:'scroll-capture',value:{
 source:{sessionId,processingFrame,phase:'recovery'},state}});
test('location analysis separates leading misses from later failures without relying on callback order',()=>{
 const r=analyzeInputDelivery(trace([location('a',3,'unreadable'),location('a',1,'not-located'),
  location('a',2,'not-located'),location('a',4,'not-located'),location('a',3,'unreadable')]));
 assert.equal(r.status,'measured');
 assert.deepEqual(r.locations,[{sessionId:'a',phase:'recovery',observedFrames:4,conflictingFrames:0,
  firstLocatedProcessingFrame:3,notLocatedFrames:3,notLocatedBeforeFirst:2,notLocatedAfterFirst:1}]);
});
test('location analysis never merges sessions or manufactures a first location from conflicting facts',()=>{
 const r=analyzeInputDelivery(trace([location('a',1,'not-located'),location('a',1,'measured'),location('b',1,'not-located')]));
 assert.equal(r.locations.length,2);assert.equal(r.locations[0].conflictingFrames,1);
 assert.equal(r.locations[0].firstLocatedProcessingFrame,null);
 assert.equal(r.locations[1].notLocatedBeforeFirst,null);assert.equal(r.locations[1].notLocatedAfterFirst,null);
 assert.deepEqual(analyzeInputDelivery(trace([])).locations,[]);
});
