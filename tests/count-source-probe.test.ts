import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CountSourceProbe} from '../src/features/card-scanner/recognition/count-source-probe';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';
const source=(id:number,time=id):ObservationSource=>({sessionId:'s',frameId:id,observationId:`o${id}`,captureOrder:id*100,captureTime:time,phase:'input',slot:2});
const receipt=(id:number,time=id,canonical=id)=>({version:1 as const,kind:'measured' as const,sourceFrameId:canonical,
 acquisitionFrameId:id,captureTime:time,width:10,height:10,hash:'a'.repeat(64)});
const input={borderAlignment:.95,awakening:0,extraCopies:8,pattern:{value:8,candidate:8,score:.32,gap:.02,reason:'repeat'}};
const pixels=new Uint8Array(3240).fill(100),barrier={sessionId:'s',captureOrder:0,captureTime:0};
test('diagnostics join source and receipt, isolate recording loss, and never attest physical frames',()=>{
 const recorded:unknown[]=[];const p=new CountSourceProbe('s','canonical',event=>{recorded.push(event);return false;});
 const first=p.acquire(source(2),receipt(2));assert.equal(first?.canonicalFrameId,2);assert.equal(first?.provenance,'unverified');
 const bad=p.acquire(source(3),receipt(99));assert.equal(bad?.canonicalFrameId,null);
 assert.equal(p.stats.mismatch,1);assert.equal(p.stats.missing,1);assert.equal(p.stats.recordingComplete,false);assert.equal(recorded.length,2);
 p.read('a',first,pixels,input,barrier);p.read('a',bad,pixels,input,barrier);
 assert.equal(p.stats.unverified,2);assert.equal(p.stats.conditional,0);assert.equal(p.stats.reads,2);p.finish();
 assert.equal(p.stats.cleaned,true);assert.equal(p.stats.retainedPixelBytes,0);assert.equal(p.stats.recordingComplete,false);
});
test('same original retry remains unverified, late completion cannot evict and cleanup closes capture',()=>{
 const p=new CountSourceProbe('s','canonical');const a=p.acquire(source(2),receipt(2));
 const retry=p.acquire(source(3,2),{...receipt(3,2,2),kind:'analysis-reused',originAcquisitionFrameId:2});
 const latest=p.acquire(source(4),receipt(4));p.read('a',latest,pixels,input,barrier);p.read('a',a,pixels,input,barrier);p.read('a',retry,pixels,input,barrier);
 assert.equal(p.stats.late,2);assert.equal(p.stats.reused,1);assert.equal(p.stats.conditional,0);assert.equal(p.stats.recordingComplete,null);
 p.finish();assert.equal(p.acquire(source(5),receipt(5)),undefined);assert.equal(p.stats.cleaned,true);
});
test('invalid reuse origin and unavailable input remain visible without throwing',()=>{
 const p=new CountSourceProbe('s','canonical');const invalid=p.acquire(source(3,2),{...receipt(3,2,2),kind:'analysis-reused',originAcquisitionFrameId:2});
 assert.equal(invalid,undefined);p.read('a',invalid,pixels,input,barrier);assert.equal(p.stats.errors,1);assert.equal(p.stats.readWithoutSource,1);
});
