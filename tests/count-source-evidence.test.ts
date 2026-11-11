import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CountObservations,type CountObservationSource} from '../src/features/card-scanner/recognition/count-confidence';
const input={borderAlignment:.95,awakening:0,extraCopies:8,pattern:{value:8,candidate:8,score:.32,gap:.02,reason:'repeat'}};
const vector=new Uint8Array(3240).fill(100),after={sessionId:'session',captureOrder:100,captureTime:1};
const makeTracker=()=>{const value=new CountObservations();value.beginSourceBoundSession('session');return value;};
const source=(id:number,patch:Partial<CountObservationSource>={}):CountObservationSource=>({sessionId:'session',observationId:`obs-${id}`,
 captureOrder:id*100,captureTime:id,slot:1,canonicalFrameId:id,canonicalStreamId:'stream',provenance:'canonical-claim',...patch});
test('source bound API preserves old boolean API, and reports unverified for missing physical provenance',()=>{
 const tracker=makeTracker();assert.equal(tracker.offer('a','old',vector,input),false);
 const old=source(2,{canonicalFrameId:null,canonicalStreamId:null,provenance:'unverified'});
 const result=tracker.offerSourceBound('a',vector,input,old,after);assert.equal(result.status,'unverified');assert.deepEqual(result.current,old);
 assert.equal(tracker.offer('a','new',vector,input),true,'existing API remains independent');
 assert.equal(tracker.offerSourceBound('a',vector,input,source(3),after).status,'unverified');
});
test('only same-session post-barrier claims of distinct ordered frames yield a conditional pair',()=>{
 const tracker=makeTracker();tracker.offerSourceBound('a',vector,input,source(2),after);
 const result=tracker.offerSourceBound('a',vector,input,source(3),after);assert.equal(result.status,'conditional');
 if(result.status==='conditional'){assert.deepEqual(result.previous,source(2));assert.deepEqual(result.current,source(3));assert.ok(Object.isFrozen(result.previous));}
 const advanced={...after,captureOrder:200,captureTime:2};
 assert.equal(makeTracker().offerSourceBound('a',vector,input,source(1),after).status,'unverified');
 const t=makeTracker();t.offerSourceBound('a',vector,input,source(2),after);
 assert.equal(t.offerSourceBound('a',vector,input,source(3),advanced).status,'unverified','barrier equal to previous invalidates it');
});
test('same canonical frame, retry, changed values, session or stream never imply independence',()=>{
 for(const newer of [source(3,{canonicalFrameId:2}),source(3,{observationId:'obs-2'}),source(3,{sessionId:'other'}),
  source(3,{canonicalStreamId:'other'}),source(3,{captureTime:2}),source(3,{captureOrder:200})]){
  const t=makeTracker();t.offerSourceBound('a',vector,input,source(2),after);
  assert.equal(t.offerSourceBound('a',vector,input,newer,after).status,'unverified');
 }
 const t=makeTracker();t.offerSourceBound('a',vector,input,source(2),after);
 assert.equal(t.offerSourceBound('a',vector,{...input,extraCopies:9,pattern:{...input.pattern,value:9,candidate:9}},source(3),after).status,'unverified');
});
test('stored source and pixel evidence are copied; later caller mutations cannot fabricate a match',()=>{
 const t=makeTracker(),first=source(2),pixels=vector.slice();t.offerSourceBound('a',pixels,input,first,after);
 (first as {captureTime:number}).captureTime=0;pixels.fill(0);
 const result=t.offerSourceBound('a',vector,input,source(3),after);assert.equal(result.status,'conditional');
 if(result.status==='conditional')assert.equal(result.previous.captureTime,2);
});

test('session boundaries release pixels and reject stale callbacks without switching sessions',()=>{
 const t=makeTracker();t.offerSourceBound('a',vector,input,source(2),after);
 assert.deepEqual(t.sourceBoundStats(),{sessionId:'session',cards:1,entries:1,pixelBytes:1152});
 t.beginSourceBoundSession('next');assert.equal(t.sourceBoundStats().pixelBytes,0);
 assert.equal(t.offerSourceBound('a',vector,input,source(3),after).status,'unverified');
 assert.equal(t.sourceBoundStats().sessionId,'next');assert.equal(t.sourceBoundStats().entries,0);
 t.clearSourceBound();assert.equal(t.sourceBoundStats().sessionId,null);assert.equal(t.sourceBoundStats().pixelBytes,0);
 assert.equal(t.offerSourceBound('a',vector,input,source(4),after).status,'unverified');
 assert.equal(t.sourceBoundStats().sessionId,null);
});
test('late older completions cannot evict newer six observations',()=>{
 const t=makeTracker();for(let n=10;n<16;n++)t.offerSourceBound('a',vector,input,source(n),after);
 assert.equal(t.sourceBoundStats().entries,6);
 for(let n=2;n<10;n++)assert.equal(t.offerSourceBound('a',vector,input,source(n),after).status,'unverified');
 assert.equal(t.sourceBoundStats().entries,6);
 const current=t.offerSourceBound('a',vector,input,source(16),after);assert.equal(current.status,'conditional');
 if(current.status==='conditional')assert.equal(current.previous.captureOrder,1000);
});
test('observation aliases cannot change their source metadata',()=>{
 const t=makeTracker();t.offerSourceBound('a',vector,input,source(2),after);
 assert.equal(t.offerSourceBound('a',vector,input,source(3,{observationId:'obs-2'}),after).status,'unverified');
 assert.equal(t.sourceBoundStats().entries,1);
});


test('source-bound evidence is capped at 2048 cards and six cropped vectors each',()=>{
 const t=makeTracker();for(let id=0;id<2049;id++)for(let n=2;n<9;n++)t.offerSourceBound(`card-${id}`,vector,input,source(n),after);
 const stats=t.sourceBoundStats();assert.equal(stats.cards,2048);assert.equal(stats.entries,2048*6);
 assert.equal(stats.pixelBytes,2048*6*1152);t.clearSourceBound();assert.equal(t.sourceBoundStats().pixelBytes,0);
});
