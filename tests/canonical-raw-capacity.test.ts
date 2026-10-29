import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanonicalCapture} from '../src/features/card-scanner/canonical-capture';
import {MAX_FRAME_BYTES} from '../src/features/card-scanner/recording-frame-integrity';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const source=(width=1,height=1)=>({width,height}) as HTMLCanvasElement;
interface FrameRequest {kind:'frame';id:number;width:number;height:number;time:number;bitmap?:ImageBitmap}
function harness(options:{byteLimit?:number;autoAck?:boolean}={}){
 const requests:Record<string,unknown>[]=[],reports:string[]=[],incomplete:string[]=[],frames=new Map<number,FrameRequest>(),acked=new Set<number>();
 let copies=0,closedBitmaps=0,started=0,closed=0,taken=0;
 const port={onmessage:null as ((event:MessageEvent)=>void)|null,start(){started++;},close(){closed++;},
  postMessage(value:Record<string,unknown>){requests.push(value);
   if(value.kind==='drain')queueMicrotask(()=>port.onmessage?.({data:{kind:'drained'}} as MessageEvent));
   if(value.kind==='frame'){const frame=value as unknown as FrameRequest;frames.set(frame.id,frame);frame.bitmap?.close();
    if(options.autoAck)ack(frame.id);}
  }};
 function ack(id:number){const frame=frames.get(id);assert.ok(frame);acked.add(id);
  port.onmessage?.({data:{kind:'stored',id,width:frame.width,height:frame.height,time:frame.time,hash:'a'.repeat(64)}} as MessageEvent);}
 const capture=createCanonicalCapture({takePort(){taken++;return port as unknown as MessagePort;},
  incomplete(reason){incomplete.push(reason);},async readFrame(){throw Error('capacity queries must not read stored pixels');}},
  reason=>reports.push(reason),{byteLimit:options.byteLimit,
   bitmapFactory:async()=>{copies++;return {close(){closedBitmaps++;}} as ImageBitmap;},
   canvasFactory:()=>({width:0,height:0,getContext:()=>({putImageData(){}})}) as unknown as HTMLCanvasElement});
 return {capture,requests,reports,incomplete,frames,ack,
  sourceError(){port.onmessage?.({data:{kind:'source-error',error:'fake writer failure'}} as MessageEvent);},
  counts:()=>({copies,closedBitmaps,started,closed,taken}),
  async finish(){await turn();for(const id of frames.keys())if(!acked.has(id))ack(id);await capture.finish();},
 };
}

test('nine 2560x1440 raw sources fill the existing 128MiB budget; queries are inert and one ACK restores credit',async()=>{
 const h=harness(),width=2560,height=1440,frameBytes=width*height*4;
 for(let index=0;index<9;index++){
  assert.equal(h.capture.rawCapacity(width,height),'available');
  assert.equal(h.capture.submit(source(width,height),index,index,'input'),index+1);
 }
 assert.equal(h.capture.stats.pendingBytes,9*frameBytes);assert.equal(h.capture.stats.pendingBytes,132_710_400);
 const before=structuredClone(h.capture.stats),counts=h.counts(),requests=h.requests.length;
 for(let index=0;index<25;index++){
  assert.equal(h.capture.rawCapacity(width,height),'busy');assert.equal(h.capture.rawCapacity(width,height,'backup'),'busy');
  assert.equal(h.capture.rawCapacity(width,height,'recovery'),'busy');
 }
 assert.deepEqual(h.capture.stats,before);assert.deepEqual(h.counts(),counts);assert.equal(h.requests.length,requests);
 assert.equal(h.capture.captured,9);assert.deepEqual(h.reports,[]);assert.deepEqual(h.incomplete,[]);
 await turn();h.ack(1);assert.equal(h.capture.rawCapacity(width,height),'available');
 assert.equal(h.capture.submit(source(width,height),10,10,'input'),10,'queries never consume source IDs');
 assert.equal(h.capture.rawCapacity(width,height),'busy');assert.equal(h.capture.stats.peakPendingBytes,9*frameBytes);
 await h.finish();assert.equal(h.capture.stats.storedFrames,10);assert.equal(h.capture.stats.error,'');
});

test('prepared reservations remain conservative when a raw capacity query shares their pending byte credits',async()=>{
 const h=harness({byteLimit:16}),prepared=h.capture.reserve({width:1,height:1,time:0,elapsed:0})!;
 assert.equal(prepared.id,1);assert.equal(h.capture.stats.pendingBytes,8);
 assert.equal(h.capture.rawCapacity(1,2),'available');assert.equal(h.capture.rawCapacity(1,3),'busy');
 assert.equal(h.capture.submit(source(),1,1,'input'),2);assert.equal(h.capture.stats.pendingBytes,12);
 assert.equal(h.capture.rawCapacity(1,2),'busy');assert.equal(h.capture.rawCapacity(1,1),'available');
 h.capture.submitPrepared(prepared.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
 assert.equal(h.capture.stats.pendingBytes,12,'RGBA prepared submission retains its two-RGBA reservation');
 await turn();h.ack(prepared.id);assert.equal(h.capture.stats.pendingBytes,4);assert.equal(h.capture.rawCapacity(1,3),'available');
 assert.equal(h.capture.submit(source(1,3),2,2,'input'),3);assert.equal(h.capture.stats.pendingBytes,16);
 assert.equal(h.capture.rawCapacity(1,1),'busy');await h.finish();assert.equal(h.capture.stats.peakPendingBytes,16);
});

test('invalid dimensions, roles and permanently oversized raw frames return unavailable without poisoning capture',async()=>{
 const h=harness({byteLimit:8}),before=structuredClone(h.capture.stats),counts=h.counts();
 for(const [width,height]of [[0,1],[-1,1],[1,0],[1,1.5],[NaN,1],[1,Infinity],[Number.MAX_SAFE_INTEGER,2],
  [1,3],[MAX_FRAME_BYTES/4+1,1]])assert.equal(h.capture.rawCapacity(width,height),'unavailable');
 assert.equal(h.capture.rawCapacity(1,1,'other' as never),'unavailable');assert.equal(h.capture.rawCapacity(1,1,null as never),'unavailable');
 assert.deepEqual(h.capture.stats,before);assert.deepEqual(h.counts(),counts);assert.deepEqual(h.requests,[]);
 assert.deepEqual(h.reports,[]);assert.deepEqual(h.incomplete,[]);assert.equal(h.capture.rawCapacity(1,1),'available');
 assert.equal(h.capture.submit(source(),0,0,'input'),1);await h.finish();
 const maximum=harness();assert.equal(maximum.capture.rawCapacity(MAX_FRAME_BYTES/4,1),'available');
 assert.equal(maximum.capture.rawCapacity(MAX_FRAME_BYTES/4+1,1),'unavailable');await maximum.finish();
});

test('raw submit still fails closed when a prior available query becomes stale before submission',async()=>{
 const h=harness({byteLimit:8});assert.equal(h.capture.rawCapacity(1,1),'available');
 assert.equal(h.capture.submit(source(),0,0,'input'),1);assert.equal(h.capture.rawCapacity(1,1),'available');
 assert.equal(h.capture.submit(source(),1,1,'input'),2);
 assert.equal(h.capture.submit(source(),2,2,'input'),undefined,'capacity queries are not reservations');
 assert.match(h.capture.stats.error,/용량 한도/);assert.equal(h.capture.stats.pendingBytes,0);assert.equal(h.capture.captured,2);
 assert.equal(h.reports.length,1);assert.equal(h.incomplete.length,1);assert.equal(h.capture.rawCapacity(1,1),'unavailable');
 await h.finish();
});

test('failed, finishing and closed producers never classify as temporary busy',async()=>{
 const failed=harness({byteLimit:4});failed.capture.submit(source(),0,0,'input');failed.sourceError();
 assert.equal(failed.capture.rawCapacity(1,1),'unavailable');assert.equal(failed.capture.rawCapacity(1,1,'recovery'),'unavailable');await failed.finish();
 const ending=harness({byteLimit:4});ending.capture.submit(source(),0,0,'input');await turn();
 const finish=ending.capture.finish();assert.equal(ending.capture.rawCapacity(1,1),'unavailable');
 ending.ack(1);await finish;assert.equal(ending.capture.rawCapacity(1,1),'unavailable');
 assert.equal(ending.capture.rawCapacity(1,1,'recovery'),'unavailable');
});

test('original replay closes input and backup admission while preserving the existing recovery role rule',async()=>{
 const h=harness(),iterator=h.capture.frames(new AbortController().signal);assert.equal((await iterator.next()).done,true);
 assert.equal(h.capture.rawCapacity(1,1),'unavailable');assert.equal(h.capture.rawCapacity(1,1,'input'),'unavailable');
 assert.equal(h.capture.rawCapacity(1,1,'backup'),'unavailable');assert.equal(h.capture.rawCapacity(1,1,'recovery'),'available');
 assert.equal(h.capture.submit(source(),0,0,'input'),undefined);assert.equal(h.capture.submit(source(),0,0,'recovery'),1);
 await h.finish();
});

test('the existing ten-thousand-record limit is permanently unavailable even after every byte credit is acknowledged',async()=>{
 const h=harness({byteLimit:4,autoAck:true});
 for(let index=0;index<10_000;index++){
  assert.equal(h.capture.submit(source(),index,index,'input'),index+1);await Promise.resolve();
 }
 assert.equal(h.capture.stats.pendingBytes,0);assert.equal(h.capture.stats.storedFrames,10_000);
 assert.equal(h.capture.rawCapacity(1,1),'unavailable');assert.equal(h.capture.rawCapacity(1,1,'recovery'),'unavailable');
 assert.equal(h.capture.captured,10_000);assert.deepEqual(h.reports,[]);assert.deepEqual(h.incomplete,[]);await h.finish();
});
