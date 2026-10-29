import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeInputResources} from '../scripts/analyze-input-resources.mjs';

const offer=(id:number,atMs:number)=>({version:2,kind:'offered',inputId:id,captureTime:id,atMs,observedAtMs:atMs,
  selection:null,estimatedBytes:16,maxPendingFrames:1,maxRetainedBytes:32});
const action=(kind:string,id:number,atMs:number,extra={})=>({version:2,kind,inputId:id,captureTime:id,atMs,...extra});
const trace=(values:object[],complete=true)=>({complete,dropped:complete?0:1,
  events:values.map((value,seq)=>({seq:seq+1,type:'input-decision',value:{...value,seq:seq+1}}))});

test('reports transient ownership separately from retained budget and acquisition wait',()=>{
  const r=analyzeInputResources(trace([offer(1,0),action('started',1,10),offer(2,11),offer(3,12),
    {version:2,kind:'replaced',oldInputId:2,newInputId:3,atMs:12},action('released',2,12,{reason:'replaced',failed:false}),
    action('finished',1,30,{outcome:'completed'}),action('released',1,30,{reason:'normal',failed:false}),
    action('started',3,40),action('finished',3,50,{outcome:'completed'}),action('released',3,50,{reason:'normal',failed:false})]));
  assert.equal(r.status,'measured');assert.equal(r.rasterEstimate.peakOwnedBytes,48);
  assert.equal(r.rasterEstimate.retainedBudgetBytes,32);assert.equal(r.rasterEstimate.endingOwnedBytes,0);
  assert.deepEqual(r.queueWait,{samples:2,p50Ms:10,p95Ms:28,maxMs:28});
  assert.equal(r.acquisition.maxMs,20);
});
test('missing, partial and failed cleanup cannot claim zero remaining physical memory',()=>{
  assert.equal(analyzeInputResources(trace([])).rasterEstimate.endingOwnedBytes,null);
  assert.equal(analyzeInputResources(trace([offer(1,0)],false)).status,'partial');
  const r=analyzeInputResources(trace([offer(1,0),action('released',1,1,{reason:'disposed',failed:true})]));
  assert.equal(r.status,'partial');assert.equal(r.rasterEstimate.endingOwnedBytes,null);
  assert.equal(r.rasterEstimate.releaseFailures,1);
});
test('legacy bytes are unknown and invalid lifecycles fail instead of inventing measurements',()=>{
  const r=analyzeInputResources(trace([{version:1,kind:'offered',inputId:1,captureTime:1,atMs:0,observedAtMs:0},
    {version:1,kind:'released',inputId:1,captureTime:1,atMs:1,reason:'disposed',failed:false}]));
  assert.equal(r.rasterEstimate.peakOwnedBytes,null);
  assert.throws(()=>analyzeInputResources(trace([action('started',1,0)])));
  assert.throws(()=>analyzeInputResources(trace([offer(1,10),action('started',1,9)])));
});
