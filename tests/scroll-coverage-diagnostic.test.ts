import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScrollCoverage} from '../src/features/card-scanner/session/scroll-coverage';
import {parseScrollCoverageDiagnostic} from '../src/features/card-scanner/session/scroll-coverage-diagnostic';
import {summarizeScrollCoverage} from '../dev/scroll-coverage-replay';
import type {RunStateTraceEvent,RunStateTraceSnapshot} from '../dev/run-state-trace';

function sample() {
 const values:unknown[]=[],sessionId='session';let ordinal=0;
 const record=(v:object)=>values.push({version:1,sessionId,ordinal:++ordinal,...v});
 const coverage=new ScrollCoverage(()=>record({kind:'reset'}));record({kind:'seed'});
 const offer=(frame:number,position:number,span:number,slots:boolean[])=>{
  coverage.offer(position,span,slots);record({kind:'offer',processingFrame:frame,inputId:frame,captureTime:frame/10,
   phase:'input',position,pageSpan:span,slots:slots.map(v=>v?'1':'0').join(''),gaps:coverage.gaps(),gapsTruncated:false});
 };
 offer(1,0,.08,Array(40).fill(true));offer(2,.2,.08,Array(40).fill(true));
 // Thumb-size change internally resets; it must be a separate recorded fact.
 offer(3,.4,.12,Array(40).fill(true));record({kind:'checkpoint'});
 return {version:1 as const,complete:true,dropped:0,events:values.map((v,i)=>({seq:i+1,time:i,type:'scroll-coverage' as const,value:parseScrollCoverageDiagnostic(v)}))};
}
test('coverage hint trace records resets and replays without claiming UI or complete input',()=>{
 const trace=sample(),result=summarizeScrollCoverage(trace);
 assert.equal(result.status,'matched-hint-state');if(result.status!=='matched-hint-state')return;
 assert.equal(result.resets,1);assert.equal(result.offers,3);assert.deepEqual(result.gaps,[]);
 assert.equal(result.uiReceipt,'unknown');assert.equal(result.inputCoverage,'unknown');assert.equal(result.identityEvidence,false);
});
test('coverage hint replay fails closed for partial, missing or altered events',()=>{
 const trace=sample();assert.equal(summarizeScrollCoverage({...trace,complete:false}).status,'unknown');
 assert.equal(summarizeScrollCoverage({...trace,dropped:1}).status,'unknown');
 const missingCheckpoint={...trace,events:trace.events.filter(event=>event.value.kind!=='checkpoint')};
 assert.equal(summarizeScrollCoverage(missingCheckpoint).status,'unknown');
 const withoutReset={...trace,events:trace.events.filter(event=>event.value.kind!=='reset')};
 assert.equal(summarizeScrollCoverage(withoutReset).status,'unknown');
 const altered=structuredClone(trace);const offer=altered.events.find(event=>event.value.kind==='offer');
 assert.ok(offer&&offer.value.kind==='offer');offer.value.gaps=[{from:0,to:.5}];
 assert.equal(summarizeScrollCoverage(altered as RunStateTraceSnapshot).status,'unknown');
 const truncated=structuredClone(trace);const item=truncated.events.find(event=>event.value.kind==='offer');
 assert.ok(item&&item.value.kind==='offer');item.value.gapsTruncated=true;
 assert.equal(summarizeScrollCoverage(truncated as RunStateTraceSnapshot).status,'unknown');
 const malformed={...trace,events:trace.events.map((event,i)=>i===1?{...event,seq:1}:event)};
 assert.equal(summarizeScrollCoverage(malformed as {events:RunStateTraceEvent[];version:1;complete:true;dropped:0}).status,'unknown');
});
test('coverage fact rejects malformed slot strings and numeric fields',()=>{
 const trace=sample(),offer=trace.events.find(event=>event.value.kind==='offer');assert.ok(offer);
 assert.throws(()=>parseScrollCoverageDiagnostic({...offer.value,slots:'1'}));
 assert.throws(()=>parseScrollCoverageDiagnostic({...offer.value,pageSpan:0}));
 assert.throws(()=>parseScrollCoverageDiagnostic({...offer.value,inputId:0}));
});
