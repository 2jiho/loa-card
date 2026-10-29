import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordingRasterPipeline,type RasterWorker} from '../src/features/card-scanner/recording-raster-pipeline';
import type {RecordingRasterInput} from '../src/features/card-scanner/recording-input-raster';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function bitmap(tag=1,width=1,height=1){return {width,height,tag,closed:0,close(){this.closed++;}};}
const input=(source:ReturnType<typeof bitmap>):RecordingRasterInput=>({width:source.width,height:source.height,bitmap:source as unknown as ImageBitmap});
class FakeWorker {
 onmessage:any;onerror:any;onmessageerror:any;
 messages:{data:any;transfer:any}[]=[];terminated=0;postFailure=false;
 constructor(readonly preparation:'ready'|'error'|'invalid'|'timeout'='ready'){}
 postMessage(data:any,transfer?:unknown){
  if(data.kind==='raster'&&this.postFailure){this.postFailure=false;throw Error('transfer rejected');}
  this.messages.push({data,transfer});
  if(data.kind==='init')queueMicrotask(()=>{
   if(this.preparation==='ready')this.onmessage?.({data:{kind:'ready'}});
   else if(this.preparation==='error')this.onerror?.(Error('prepare error'));
   else if(this.preparation==='invalid')this.onmessage?.({data:{kind:'wrong'}});
  });
  if(data.kind==='dispose')queueMicrotask(()=>this.onmessage?.({data:{kind:'disposed'}}));
 }
 terminate(){this.terminated++;}
 requests(){return this.messages.filter(value=>value.data.kind==='raster');}
 reply(id:number,override:Record<string,unknown>={}){
  const request=this.requests().find(value=>value.data.id===id)?.data;
  if(request&&!request.bitmap.closed)request.bitmap.close(); // the receiving child owns this close
  const pixels=new Uint8Array((request?.width??1)*(request?.height??1)*4).fill(request?.bitmap.tag??0);
  this.onmessage?.({data:{kind:'raster',id,width:request?.width??1,height:request?.height??1,pixels:pixels.buffer,readbackMs:2,queueMs:1,...override}});
 }
}
const nested=(worker:FakeWorker,options:Parameters<typeof createRecordingRasterPipeline>[0]={})=>
 createRecordingRasterPipeline({createWorker:()=>worker as RasterWorker,...options});

test('nested raster dispatch precedes codec reads and returned pixels keep their ownership after release',async()=>{
 const worker=new FakeWorker();let clock=10;
 const pipeline=await nested(worker,{now:()=>clock}),a=bitmap(7),b=bitmap(9);
 const first=pipeline.submit(input(a)),second=pipeline.submit(input(b));
 assert.equal(pipeline.engine,'nested-worker');assert.equal(worker.requests().length,2);
 assert.deepEqual(worker.requests().map(value=>value.transfer),[[a],[b]]);
 assert.equal(pipeline.stats.pendingBytes,8);assert.equal(pipeline.stats.dispatched,2);
 clock=25;worker.reply(2);const resultB=await second.read();assert.deepEqual([...resultB.pixels],[9,9,9,9]);
 clock=30;worker.reply(1);const resultA=await first.read();assert.deepEqual([...resultA.pixels],[7,7,7,7]);
 assert.equal(pipeline.stats.pendingBytes,8,'raster completion cannot return source credits before codec release');
 await second.release();assert.equal(pipeline.stats.pendingBytes,4);await first.release();
 assert.deepEqual([...resultA.pixels],[7,7,7,7],'XOR predecessor survives raster release');assert.equal(resultA.pixels.buffer.byteLength,4);
 assert.deepEqual([a.closed,b.closed],[1,1]);assert.equal(pipeline.stats.completed,2);
 assert.equal(pipeline.stats.roundTripMs,35);assert.equal(pipeline.stats.pendingBytes,0);
 await pipeline.drain();await pipeline.dispose();assert.equal(worker.terminated,1);
});

test('inline fallback is lazy, closes an unread source, and keeps legacy RGBA buffers without copying',async()=>{
 let calls=0;
 const pipeline=await createRecordingRasterPipeline({createWorker:()=>undefined,inlineRead:value=>{
  calls++;return value.pixels?new Uint8Array(value.pixels):new Uint8Array(value.width*value.height*4).fill((value.bitmap as any).tag);
 }}),unused=bitmap(1),used=bitmap(2);
 const skipped=pipeline.submit(input(unused)),reading=pipeline.submit(input(used));assert.equal(calls,0);
 await skipped.release();await assert.rejects(skipped.read(),/해제/);assert.equal(unused.closed,1);assert.equal(calls,0);
 const result=await reading.read();assert.equal(calls,1);assert.equal(used.closed,1);
 await reading.release();assert.equal(used.closed,1);assert.equal(result.pixels[0],2);
 const original=new Uint8Array([4,3,2,1]),legacy=pipeline.submit({width:1,height:1,pixels:original.buffer});
 assert.equal((await legacy.read()).pixels.buffer,original.buffer);await legacy.release();
 assert.equal(pipeline.engine,'inline');assert.equal(pipeline.stats.dispatched,0);assert.equal(pipeline.stats.pendingBytes,0);
 await pipeline.drain();await pipeline.dispose();
});

test('only preparation failure may fall back before a native payload is transferred',async()=>{
 for(const preparation of ['error','invalid','timeout'] as const){
  const worker=new FakeWorker(preparation),pipeline=await nested(worker,{prepareTimeoutMs:10,inlineRead:()=>new Uint8Array(4)});
  assert.equal(pipeline.engine,'inline');assert.equal(worker.terminated,1);assert.equal(worker.requests().length,0);
  const source=bitmap(),job=pipeline.submit(input(source));await job.read();await job.release();assert.equal(source.closed,1);await pipeline.dispose();
 }
 const pipeline=await createRecordingRasterPipeline({createWorker(){throw Error('Worker unavailable');}});assert.equal(pipeline.engine,'inline');await pipeline.dispose();
});

test('a failed post retains parent ownership and returns a rejected job without throwing from submit',async()=>{
 const worker=new FakeWorker(),pipeline=await nested(worker),source=bitmap();worker.postFailure=true;
 const job=pipeline.submit(input(source));await assert.rejects(job.read(),/transfer rejected/);await job.release();
 assert.equal(source.closed,1);assert.equal(pipeline.stats.pendingBytes,0);assert.equal(pipeline.stats.dispatched,0);
 const nextSource=bitmap(5),next=pipeline.submit(input(nextSource));worker.reply(2);await next.read();await next.release();
 assert.equal(nextSource.closed,1);await pipeline.dispose();
});

test('byte and descriptor caps reject only the new source while earlier raster work remains joinable',async()=>{
 for(const limits of [{maxPendingBytes:8,maxPendingJobs:128},{maxPendingBytes:4096,maxPendingJobs:2}]){
  const worker=new FakeWorker(),pipeline=await nested(worker,limits),a=bitmap(),b=bitmap(),c=bitmap();
  const first=pipeline.submit(input(a)),second=pipeline.submit(input(b)),rejected=pipeline.submit(input(c));
  await assert.rejects(rejected.read(),/한도/);await rejected.release();assert.equal(c.closed,1);
  assert.equal(pipeline.stats.pendingBytes,8);assert.equal(worker.requests().length,2);
  worker.reply(1);worker.reply(2);await first.read();await second.read();await first.release();await second.release();
  assert.equal(pipeline.stats.peakPendingBytes,8);assert.equal(pipeline.stats.pending,0);await pipeline.dispose();
 }
});

test('invalid and closed submissions are rejected jobs and always close locally owned native input',async()=>{
 const pipeline=await createRecordingRasterPipeline({createWorker:()=>undefined});
 for(const size of [{width:0,height:1},{width:100000,height:100000}]){
  const source=bitmap(),job=pipeline.submit({...size,bitmap:source as unknown as ImageBitmap});
  await assert.rejects(job.read(),/크기/);await job.release();assert.equal(source.closed,1);
 }
 const source=bitmap(),ambiguous=pipeline.submit({...input(source),pixels:new ArrayBuffer(4)});
 await assert.rejects(ambiguous.read(),/형식/);await ambiguous.release();assert.equal(source.closed,1);
 await pipeline.dispose();const late=bitmap(),job=pipeline.submit(input(late));await assert.rejects(job.read(),/종료/);await job.release();assert.equal(late.closed,1);
 for(const value of [{maxPendingBytes:0},{maxPendingJobs:0},{timeoutMs:0},{prepareTimeoutMs:NaN}])await assert.rejects(createRecordingRasterPipeline(value),/한도/);
});

test('a runtime Worker error rejects every outstanding job without retrying transferred pixels inline',async()=>{
 const worker=new FakeWorker();let inlineCalls=0;
 const pipeline=await nested(worker,{inlineRead:()=>{inlineCalls++;return new Uint8Array(4);}}),a=bitmap(),b=bitmap();
 const first=pipeline.submit(input(a)),second=pipeline.submit(input(b));worker.onerror(Error('crashed'));
 await assert.rejects(first.read(),/실행 실패/);await assert.rejects(second.read(),/실행 실패/);await first.release();await second.release();
 assert.equal(pipeline.engine,'nested-worker');assert.equal(inlineCalls,0);assert.equal(a.closed,0,'terminated receiver owns transferred native payload, never the parent');
 assert.equal(worker.terminated,1);assert.equal(pipeline.stats.pendingBytes,0);await pipeline.dispose();assert.equal(worker.terminated,1);
});

test('malformed child responses fail the affected job and cannot be replaced by a late successful response',async()=>{
 for(const override of [{width:2},{pixels:new ArrayBuffer(3)},{readbackMs:NaN},{queueMs:-1},{queueMs:Infinity}]){
  const worker=new FakeWorker(),pipeline=await nested(worker),source=bitmap(),job=pipeline.submit(input(source));
  worker.reply(1,override);await assert.rejects(job.read(),/크기|시각/);worker.reply(1);await assert.rejects(job.read(),/크기|시각/);
  await job.release();assert.equal(source.closed,1);assert.equal(pipeline.stats.completed,0);await pipeline.dispose();
 }
 const worker=new FakeWorker(),pipeline=await nested(worker),job=pipeline.submit(input(bitmap()));worker.reply(999);
 await assert.rejects(job.read(),/식별/);await job.release();assert.equal(worker.terminated,1);await pipeline.dispose();
});

test('release of skipped nested work waits for the receiver before returning reserved bytes',async()=>{
 const worker=new FakeWorker(),pipeline=await nested(worker),source=bitmap(),job=pipeline.submit(input(source));
 const reading=assert.rejects(job.read(),/해제/);let released=false,drained=false;
 const releasing=job.release().then(()=>{released=true;}),draining=pipeline.drain().then(()=>{drained=true;});await turn();
 assert.equal(released,false);assert.equal(drained,false);assert.equal(pipeline.stats.pendingBytes,4);
 worker.reply(1);await Promise.all([reading,releasing,draining]);assert.equal(released,true);assert.equal(drained,true);
 assert.equal(source.closed,1);assert.equal(pipeline.stats.pendingBytes,0);assert.equal(pipeline.stats.cancelled,1);await pipeline.dispose();
});

test('dispose promptly settles pending jobs and ignores late replies without waiting for their deadline',async()=>{
 const worker=new FakeWorker(),pipeline=await nested(worker),job=pipeline.submit(input(bitmap()));
 const rejection=assert.rejects(job.read(),/stop capture/),disposing=pipeline.dispose(Error('stop capture'));
 assert.equal(pipeline.dispose(),disposing);await Promise.all([rejection,disposing,job.release(),pipeline.drain()]);
 worker.reply(1);assert.equal(pipeline.stats.pendingBytes,0);assert.equal(worker.terminated,1);
});

test('raster timeout ends a stalled child and settles every reserved request',async()=>{
 const worker=new FakeWorker(),pipeline=await nested(worker,{timeoutMs:10}),first=pipeline.submit(input(bitmap())),second=pipeline.submit(input(bitmap()));
 await Promise.all([assert.rejects(first.read(),/時間|시간/),assert.rejects(second.read(),/時間|시간/)]);
 await Promise.all([first.release(),second.release(),pipeline.drain()]);assert.equal(worker.terminated,1);assert.equal(pipeline.stats.pendingBytes,0);await pipeline.dispose();
});

test('unread inline work times out, and malformed inline output closes its native source once',async()=>{
 const pipeline=await createRecordingRasterPipeline({createWorker:()=>undefined,timeoutMs:10,inlineRead:()=>new Uint8Array(3)}),source=bitmap(),job=pipeline.submit(input(source));
 await assert.rejects(job.read(),/크기/);await job.release();assert.equal(source.closed,1);
 const unread=bitmap(),pending=pipeline.submit(input(unread));await pipeline.drain();await assert.rejects(pending.read(),/시간/);await pending.release();
 assert.equal(unread.closed,1);assert.equal(pipeline.stats.pendingBytes,0);await pipeline.dispose();
});
