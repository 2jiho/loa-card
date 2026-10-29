import test from 'node:test';
import assert from 'node:assert/strict';
import {runGrowthWorker} from '../src/features/growth/worker-calculation';
import type {GrowthComparisonRequest} from '../src/features/growth/optimizer';

const request={master:{version:'test',targets:[],cards:[],books:[]},cards:[],xp:0,target:'x'} as GrowthComparisonRequest;
class FakeWorker {
 onmessage:Worker['onmessage']=null;onerror:Worker['onerror']=null;onmessageerror:Worker['onmessageerror']=null;
 terminated=0;postMessage(){ }terminate(){this.terminated++;}
}
test('unresponsive calculation returns a timeout and terminates exactly once',async()=>{
 const worker=new FakeWorker(),results:unknown[]=[];
 runGrowthWorker(worker,request,result=>results.push(result),5);
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(results.length,1);assert.match(JSON.stringify(results),/시간/);assert.equal(worker.terminated,1);
 worker.onmessage?.call(worker as unknown as Worker,{data:{result:{collectionCandidates:[]}}} as MessageEvent);
 assert.equal(results.length,1);
});
test('message decoding failure and cancellation terminate without an endless pending calculation',()=>{
 const worker=new FakeWorker(),results:unknown[]=[];
 const cancel=runGrowthWorker(worker,request,result=>results.push(result));
 worker.onmessageerror?.call(worker as unknown as Worker,{} as MessageEvent);
 cancel();assert.equal(worker.terminated,1);assert.equal(results.length,1);
 const other=new FakeWorker();runGrowthWorker(other,request,result=>results.push(result))();
 assert.equal(other.terminated,1);assert.equal(results.length,1);
});
