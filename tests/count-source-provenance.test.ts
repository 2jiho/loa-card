import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CountSourceProvenance,type CountProvenanceEvent} from '../src/features/card-scanner/recognition/count-source-provenance';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';
const source=(frame:number,time:number,observationId=`obs-${frame}`):ObservationSource=>({sessionId:'s',frameId:frame,observationId,
 captureOrder:frame*100,captureTime:time,phase:'input',slot:1});
const measured=(sourceFrameId:number,acquisitionFrameId:number,captureTime:number)=>({version:1 as const,kind:'measured' as const,
 sourceFrameId,acquisitionFrameId,captureTime,width:10,height:10,hash:'a'.repeat(64)});
const fact=(s:ObservationSource,raster:CountProvenanceEvent['raster']):CountProvenanceEvent=>({version:1,source:s,raster});
test('missing and parsed measured input stay unverified, and replay preserves that limit',()=>{
 const events:CountProvenanceEvent[]=[],live=new CountSourceProvenance('s','stream',event=>{events.push(event);return true;});
 const missing=live.apply(fact(source(1,1),null));assert.equal(missing.source.canonicalFrameId,null);assert.equal(missing.relation,'missing');
 const known=live.apply(fact(source(2,2),measured(8,2,2)));assert.equal(known.source.canonicalFrameId,8);assert.equal(known.source.provenance,'unverified');
 assert.equal(known.physicalSourceVerified,false);assert.equal(known.independentRepeatVerified,false);
 const replay=new CountSourceProvenance('s','stream');assert.deepEqual(events.map(e=>replay.apply(e)),[missing,known]);assert.deepEqual(replay.snapshot(),{...live.snapshot(),recordingComplete:null});
});
test('a retry joins the exact measured acquisition and cannot become an independent observation',()=>{
 const live=new CountSourceProvenance('s','stream',()=>true);live.apply(fact(source(2,2),measured(8,2,2)));
 const reused={...measured(8,3,2),kind:'analysis-reused' as const,originAcquisitionFrameId:2};
 const result=live.apply(fact(source(3,2),reused));assert.equal(result.relation,'reused');assert.equal(result.source.canonicalFrameId,8);
 assert.equal(result.source.provenance,'unverified');assert.equal(result.independentRepeatVerified,false);
});
test('source clock changes, bad origin, same frame alias and changed session fail closed and flag incomplete',()=>{
 const live=new CountSourceProvenance('s','stream',()=>true);live.apply(fact(source(2,2),measured(8,2,2)));
 assert.throws(()=>live.apply(fact(source(3,3),measured(8,3,3))),/frame alias/);
 assert.throws(()=>live.apply(fact(source(4,4),{...measured(9,4,4),kind:'analysis-reused',originAcquisitionFrameId:2})),/reuse origin/);
 assert.throws(()=>live.apply(fact({...source(5,5),sessionId:'other'},null)),/session/);
 assert.throws(()=>live.apply(fact(source(2,2,'other'),measured(8,2,3))),/acquisition mismatch/);
 assert.equal(live.snapshot().recordingComplete,false);
});
test('recording loss and explicit disposal cannot masquerade as complete replay',()=>{
 const live=new CountSourceProvenance('s','stream',()=>false);live.apply(fact(source(1,1),null));assert.equal(live.snapshot().recordingComplete,false);
 live.clear();assert.throws(()=>live.apply(fact(source(2,2),null)),/closed/);
});

test('reuse can only point to a real earlier measured receipt, never another reused receipt',()=>{
 const live=new CountSourceProvenance('s','stream',()=>true);live.apply(fact(source(2,2),measured(8,2,2)));
 const reuse={...measured(8,3,2),kind:'analysis-reused' as const,originAcquisitionFrameId:2};
 live.apply(fact(source(3,2),reuse));
 assert.throws(()=>live.apply(fact(source(4,2),{...reuse,acquisitionFrameId:4,originAcquisitionFrameId:3})),/reuse origin/);
 assert.throws(()=>live.apply(fact(source(3,2),measured(8,3,2))),/acquisition alias/);
 assert.equal(live.snapshot().recordingComplete,false);
});
