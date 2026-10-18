import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createExactRecording} from '../src/features/card-scanner/exact-recording';
test('recorder has bounded event batches and marks overflow as incomplete',async()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');let worker:any;
 class FakeWorker{
  onmessage:any;onerror:any;messages:any[]=[];terminated=false;
  constructor(){worker=this;}
  postMessage(m:any){this.messages.push(m);if(m.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready'}}));
   if(m.kind==='finish')queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(),stats:{frames:1,events:0,dropped:0,bytes:0,complete:true,error:''}}}));
   if(m.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
  }
  terminate(){this.terminated=true;}
 }
 Object.defineProperty(globalThis,'Worker',{value:FakeWorker,configurable:true});
 try{
  const recorder=await createExactRecording();
  for(let i=0;i<12;i++)recorder.event('large','x'.repeat(200000),i);
  assert.equal(worker.messages.filter((m:any)=>m.kind==='events').length,4);
  // Complete the outstanding writes. Overflow must still survive the final response.
  for(let i=0;i<5;i++)worker.onmessage({data:{kind:'events-written'}});
  const result=await recorder.finish();assert.equal(result.stats.complete,false);assert.match(result.stats.error,/한도/);
  await result.dispose();assert.equal(worker.terminated,true);
 }finally{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
});
test('a missing input channel is reported, not mistaken for a complete recording',async()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');let request:any;
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:class{
  onmessage:any;onerror:any;terminate(){}
  postMessage(m:any){if(m.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready'}}));if(m.kind==='finish'){request=m;queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(),stats:{frames:0,events:0,dropped:0,bytes:0,complete:true,error:''}}}));}if(m.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));}
 }});
 try{const r=await createExactRecording();r.takePort();assert.throws(()=>r.takePort(),/이미/);r.incomplete('입력 Worker 중단');const result=await r.finish();assert.equal(request.noSource,true);assert.equal(result.stats.complete,false);assert.match(result.stats.error,/중단/);await result.dispose();}
 finally{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
});
