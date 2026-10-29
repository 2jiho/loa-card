import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';

test('proof page discards a late input list, restores after pagehide, and retains worker failure evidence',async()=>{
 const id='a'.repeat(64),digest='b'.repeat(64),windowTarget=Object.assign(new EventTarget(),{location:{search:''}});
 class Node extends EventTarget {disabled=false;textContent='';value='';options:{value:string;text:string}[]=[];
  add(option:{value:string;text:string}){this.options.push(option);if(!this.value)this.value=option.value;}
  replaceChildren(){this.options=[];this.value='';}}
 const nodes=Object.fromEntries(['corpus','run','stop','status','summary','result','form'].map(key=>[key,new Node()]));
 let firstList!:(value:Response)=>void,listCalls=0,firstSignal:AbortSignal|undefined;
 const workers:FakeWorker[]=[];
 class FakeWorker {
  onmessage:((event:{data:unknown})=>void)|null=null;onerror:((event:{message:string})=>void)|null=null;
  messages:Record<string,unknown>[]=[];terminated=false;
  constructor(){workers.push(this);}
  postMessage(value:Record<string,unknown>){this.messages.push(value);}
  terminate(){this.terminated=true;}
  emit(data:unknown){this.onmessage?.({data});}
 }
 const replacements={document:{querySelector:(selector:string)=>nodes[selector==='form'?'form':selector.slice(1)],documentElement:{style:{}},body:{style:{}}},window:windowTarget,
  Option:class{constructor(public text:string,public value:string){}},Worker:FakeWorker,
  fetch:(url:string,options:{signal?:AbortSignal}={})=>{
   if(url==='/__corpus'){
    if(++listCalls===1){firstSignal=options.signal;return new Promise<Response>(resolve=>{firstList=resolve;});}
    return Promise.resolve(Response.json({cases:[{id,name:'test-video',kind:'video',inputs:1}]}));
   }
   if(url==='/__corpus/environment')return Promise.resolve(Response.json({sourceDigest:digest}));
   if(url===`/__corpus/cases/${id}`)return Promise.resolve(Response.json({id,kind:'video',inputs:[{index:0,bytes:3,sha256:'c'.repeat(64),type:'video/mp4',url:`/__corpus/cases/${id}/input/0`}]}));
   if(url===`/__corpus/cases/${id}/input/0`)return Promise.resolve(new Response(new Uint8Array([1,2,3])));
   throw Error(`Unexpected request ${url}`);
  }};
 const originals=new Map(Object.keys(replacements).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const settle=async(predicate:()=>boolean)=>{for(let i=0;i<30&&!predicate();i++)await setImmediate();assert.ok(predicate(),'asynchronous page operation did not settle');};
 try{
  for(const [key,value]of Object.entries(replacements))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  await import('../dev/native-yuv-proof');
  assert.equal(listCalls,1);windowTarget.dispatchEvent(new Event('pagehide'));assert.equal(firstSignal?.aborted,true);
  windowTarget.dispatchEvent(Object.assign(new Event('pageshow'),{persisted:true}));
  await settle(()=>nodes.corpus.options.length===1);assert.equal(nodes.corpus.value,id);assert.equal(nodes.run.disabled,false);
  firstList(Response.json({cases:[{id:'d'.repeat(64),name:'late-old-list',kind:'video',inputs:1}]}));
  await setImmediate();await setImmediate();assert.deepEqual(nodes.corpus.options.map(option=>option.value),[id]);
  nodes.form.dispatchEvent(new Event('submit',{cancelable:true}));
  await settle(()=>workers.length===1&&workers[0].messages.length===1);
  const worker=workers[0],request=worker.messages[0];assert.equal(request.kind,'run');assert.equal((request.source as {caseId:string}).caseId,id);
  worker.emit({kind:'progress',id:request.id,pass:1,frames:8});assert.match(nodes.status.textContent,/1\/2.*8프레임/);
  worker.emit({kind:'error',id:request.id,code:'unsupported',error:'unsupported-color',report:{sourceVerified:true,passes:[{frames:8}],cleanup:{joined:true}}});
  await settle(()=>nodes.run.disabled===false&&nodes.result.textContent.length>0);
  const output=JSON.parse(nodes.result.textContent);assert.equal(output.complete,false);assert.equal(output.error,'unsupported-color');
  assert.equal(output.sourceVerified,true);assert.equal(output.passes[0].frames,8);assert.equal(output.cleanup.joined,true);
  assert.equal(output.validation.sourceChanged,false);assert.equal(output.workerCleanup.terminated,true);assert.equal(worker.terminated,true);
  const result=nodes.result.textContent;
  worker.emit({kind:'done',id:request.id,report:{complete:true}});await setImmediate();assert.equal(nodes.result.textContent,result,'late worker result must not overwrite its failure');
  nodes.form.dispatchEvent(new Event('submit',{cancelable:true}));await settle(()=>workers.length===2&&workers[1].messages.length===1);
  const next=workers[1];nodes.stop.dispatchEvent(new Event('click'));
  assert.equal(next.messages.at(-1)?.kind,'cancel');assert.equal(nodes.stop.disabled,true);
  const stoppingStatus=nodes.status.textContent;
  next.emit({kind:'progress',id:next.messages[0].id,pass:2,frames:999});
  assert.equal(nodes.status.textContent,stoppingStatus,'queued progress must not replace the stopping message');
  next.emit({kind:'done',id:next.messages[0].id,report:{complete:true,passes:[]}});
  await settle(()=>nodes.run.disabled===false);
  const cancelled=JSON.parse(nodes.result.textContent);assert.equal(cancelled.complete,false);assert.equal(cancelled.error,'사용자 중지');assert.equal(next.terminated,true);
 }finally{
  windowTarget.dispatchEvent(new Event('pagehide'));
  for(const worker of workers)worker.terminate();
  for(const [key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
 }
});
