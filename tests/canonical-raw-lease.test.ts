import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanonicalCapture,type CanonicalRawLease} from '../src/features/card-scanner/canonical-capture';
import {MAX_FRAME_BYTES} from '../src/features/card-scanner/recording-frame-integrity';
import {planNativeYuvFrame,type NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
type Source=HTMLCanvasElement&{marker:string;close():void};
function source(width=1,height=1,marker='source'){
 let closed=0;return {value:{width,height,marker,close(){closed++;}} as Source,closes:()=>closed};
}
type Frame={kind:'frame';id:number;width:number;height:number;time:number;role:string;bitmap?:ImageBitmap;pixels?:ArrayBuffer;native?:{pixels:Uint8Array<ArrayBuffer>}};
function harness(options:{byteLimit?:number;manualCopies?:boolean;copyThrows?:boolean;copyRejects?:boolean;sendThrows?:boolean;autoAck?:boolean}={}){
 const requests:Record<string,unknown>[]=[],frames=new Map<number,Frame>(),reports:string[]=[],incomplete:string[]=[],acked=new Set<number>();
 const copies:{marker:string;closed:number;settled:boolean;resolve:(bitmap:ImageBitmap)=>void}[]=[];
 let portClosed=0;
 const port={onmessage:null as ((event:MessageEvent)=>void)|null,start(){},close(){portClosed++;},
  postMessage(message:Record<string,unknown>){requests.push(message);
   if(message.kind==='drain')queueMicrotask(()=>port.onmessage?.({data:{kind:'drained'}} as MessageEvent));
   if(message.kind!=='frame')return;
   if(options.sendThrows)throw Error('fake send failed');
   const frame=message as unknown as Frame;frames.set(frame.id,frame);frame.bitmap?.close();if(options.autoAck)ack(frame.id);
  }};
 function ack(id:number){const frame=frames.get(id);assert.ok(frame);acked.add(id);
  port.onmessage?.({data:{kind:'stored',id,width:frame.width,height:frame.height,time:frame.time,hash:'a'.repeat(64)}} as MessageEvent);}
 function resolveCopy(index:number){const copy=copies[index];assert.ok(copy);if(copy.settled)return;copy.settled=true;
  copy.resolve({close(){copy.closed++;}} as ImageBitmap);}
 const capture=createCanonicalCapture({takePort:()=>port as unknown as MessagePort,incomplete:reason=>incomplete.push(reason),
  async readFrame(){throw Error('Lease tests must not read pixels');}},reason=>reports.push(reason),{
   byteLimit:options.byteLimit,
   bitmapFactory:input=>{
    if(options.copyThrows)throw Error('fake copy threw');
    if(options.copyRejects)return Promise.reject(Error('fake copy rejected'));
    return new Promise<ImageBitmap>(resolve=>{copies.push({marker:(input as Source).marker,closed:0,settled:false,resolve});if(!options.manualCopies)resolveCopy(copies.length-1);});
   },
   canvasFactory:()=>({width:0,height:0,getContext:()=>({putImageData(){}})}) as unknown as HTMLCanvasElement,
  });
 return {capture,requests,frames,reports,incomplete,copies,ack,resolveCopy,portClosed:()=>portClosed,
  fail(){port.onmessage?.({data:{kind:'source-error',error:'fake writer failure'}} as MessageEvent);},
  async finish(){for(let index=0;index<copies.length;index++)resolveCopy(index);await turn();for(const id of frames.keys())if(!acked.has(id))ack(id);await capture.finish();},
 };
}

test('leases reserve bounded credit without physical IDs, timers, bitmaps, or ownership of sources',async()=>{
 const h=harness({byteLimit:8}),borrowed=source();let timers=0;
 const original=globalThis.setTimeout;
 globalThis.setTimeout=((...args:Parameters<typeof setTimeout>)=>{timers++;return original(...args);}) as typeof setTimeout;
 let first:CanonicalRawLease|undefined,second:CanonicalRawLease|undefined;
 try{first=h.capture.leaseRaw(1,1);second=h.capture.leaseRaw(1,1);
  assert.ok(first&&second);assert.ok(Object.isFrozen(first));assert.equal(h.capture.leaseRaw(1,1),undefined);
  assert.equal(h.capture.rawCapacity(1,1),'busy');assert.equal(timers,0);
 }finally{globalThis.setTimeout=original;}
 assert.equal(h.capture.captured,0);assert.equal(h.capture.stats.frames,0);assert.equal(h.capture.stats.pending,0);assert.equal(h.capture.stats.pendingBytes,0);
 assert.equal(h.capture.stats.leasedFrames,2);assert.equal(h.capture.stats.leasedBytes,8);assert.equal(h.capture.stats.peakReservedBytes,8);
 assert.deepEqual(h.requests,[]);assert.equal(h.copies.length,0);assert.deepEqual(h.incomplete,[]);
 first!.release();first!.release();assert.equal(h.capture.stats.leasedBytes,4);assert.equal(first!.commit(borrowed.value,0,0),undefined);
 second!.release();assert.equal(h.capture.stats.leasedBytes,0);assert.equal(h.capture.rawCapacity(1,1),'available');assert.equal(borrowed.closes(),0);await h.finish();
});

test('commit transfers held credit once; post-commit release cannot bypass the withheld ACK',async()=>{
 const h=harness({byteLimit:4}),borrowed=source(),lease=h.capture.leaseRaw(1,1)!;
 assert.equal(lease.commit(borrowed.value,2,2000),1);assert.equal(h.capture.stats.leasedFrames,0);assert.equal(h.capture.stats.pendingBytes,4);
 assert.equal(h.capture.stats.peakPendingBytes,4);assert.equal(h.capture.stats.peakReservedBytes,4);assert.equal(h.capture.rawCapacity(1,1),'busy');
 lease.release();lease.release();assert.equal(lease.commit(borrowed.value,3,3000),undefined);assert.equal(h.capture.stats.pendingBytes,4);
 await turn();assert.equal(h.frames.size,1);assert.equal(h.frames.get(1)!.role,'input');assert.equal(h.copies[0].closed,1);assert.equal(borrowed.closes(),0);
 h.ack(1);assert.equal(h.capture.stats.pendingBytes,0);lease.release();assert.equal(h.capture.stats.pendingBytes,0);
 assert.equal(h.capture.rawCapacity(1,1),'available');assert.equal((await h.capture.stored(1)).time,2);await h.finish();
});

test('a committing lease never wakes a recovery waiter in a temporary credit handoff gap',async()=>{
 const h=harness({byteLimit:4}),lease=h.capture.leaseRaw(1,1)!;let ready=false;
 const waiting=h.capture.waitForRecoveryCapacity(4,new AbortController().signal).then(()=>{ready=true;});
 assert.equal(lease.commit(source().value,0,0),1);await turn();assert.equal(ready,false);
 lease.release();await turn();assert.equal(ready,false);assert.equal(h.capture.stats.pendingBytes,4);
 h.ack(1);await waiting;assert.equal(ready,true);assert.equal(h.capture.stats.capacityWaits,1);await h.finish();
});

test('released replacements create no dispatch holes before or between committed sources',async()=>{
 const h=harness({byteLimit:12,manualCopies:true}),dropped=h.capture.leaseRaw(1,1)!,first=h.capture.leaseRaw(1,1)!,second=h.capture.leaseRaw(1,1)!;
 dropped.release();assert.equal(h.capture.captured,0);assert.equal(first.commit(source(1,1,'first').value,1,1000),1);
 const replacement=h.capture.leaseRaw(1,1)!;replacement.release();assert.equal(second.commit(source(1,1,'second').value,2,2000,'backup'),2);
 h.resolveCopy(1);await turn();assert.equal(h.frames.size,0);h.resolveCopy(0);await turn();
 assert.deepEqual([...h.frames.keys()],[1,2]);assert.deepEqual([...h.frames.values()].map(frame=>[frame.id,frame.time,frame.role]),[[1,1,'input'],[2,2,'backup']]);
 assert.deepEqual(h.copies.map(copy=>copy.marker),['first','second']);assert.equal(h.capture.stats.leasedBytes,0);await h.finish();
});

test('prepared and raw sources share held credit without a lease being charged twice',async()=>{
 const h=harness({byteLimit:12}),lease=h.capture.leaseRaw(1,1)!,prepared=h.capture.reserve({width:1,height:1,time:0,elapsed:0})!;
 assert.equal(prepared.id,1);assert.equal(h.capture.stats.pendingBytes,8);assert.equal(h.capture.stats.leasedBytes,4);assert.equal(h.capture.rawCapacity(1,1,'backup'),'busy');
 assert.equal(lease.commit(source().value,1,1000),2);assert.equal(h.capture.stats.pendingBytes,12);assert.equal(h.capture.stats.leasedBytes,0);assert.equal(h.capture.stats.peakReservedBytes,12);
 h.capture.submitPrepared(prepared.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});await turn();
 assert.deepEqual([...h.frames.keys()],[1,2]);h.ack(1);assert.equal(h.capture.stats.pendingBytes,4);
 const next=h.capture.leaseRaw(1,2)!;assert.ok(next);assert.equal(h.capture.rawCapacity(1,1),'busy');next.release();assert.equal(h.capture.rawCapacity(1,2),'available');await h.finish();
});

test('native prepared reservations retain their existing conservative charge alongside a raw lease',async()=>{
 const h=harness({byteLimit:768}),lease=h.capture.leaseRaw(8,8)!,record=h.capture.reserve({width:8,height:8,time:0,elapsed:0})!;
 const descriptor:NativeYuvFrameMetadata={format:'I420',codedWidth:8,codedHeight:8,displayWidth:8,displayHeight:8,visibleRect:{x:0,y:0,width:8,height:8},
  rotation:0,flip:false,colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}};
 const native=new Uint8Array(planNativeYuvFrame(descriptor).nativeByteLength);
 h.capture.submitPrepared(record.id,{native:{descriptor,pixels:native},hash:'a'.repeat(64)});assert.equal(native.byteLength,0);
 assert.equal(h.capture.stats.pendingBytes,512);assert.equal(h.capture.stats.leasedBytes,256);
 assert.equal(lease.commit(source(8,8).value,1,1000),2);assert.equal(h.capture.stats.pendingBytes,768);assert.equal(h.capture.stats.peakReservedBytes,768);
 await turn();h.ack(1);assert.equal(h.capture.stats.pendingBytes,256);assert.equal(h.capture.rawCapacity(8,8),'available');await h.finish();
});

test('direct backup and prepared admission cannot steal held leases and retain fail-closed overflow',async()=>{
 const backup=harness({byteLimit:8}),held=backup.capture.leaseRaw(1,2)!;
 assert.equal(backup.capture.submit(source().value,0,0,'backup'),undefined);assert.match(backup.capture.stats.error,/용량 한도/);
 assert.equal(backup.capture.captured,0);assert.equal(backup.capture.stats.leasedBytes,0);assert.equal(held.commit(source(1,2).value,1,1),undefined);held.release();await backup.finish();
 const prepared=harness({byteLimit:8}),lease=prepared.capture.leaseRaw(1,1)!;
 assert.equal(prepared.capture.reserve({width:1,height:1,time:0,elapsed:0}),undefined);assert.match(prepared.capture.stats.error,/용량 한도/);
 assert.equal(prepared.capture.stats.leasedBytes,0);assert.equal(prepared.capture.stats.pendingBytes,0);lease.release();await prepared.finish();
});

test('invalid lease dimensions are inert while permanent direct submission keeps normal validation',async()=>{
 const h=harness({byteLimit:8});
 for(const [width,height]of [[0,1],[-1,1],[1,0],[1,1.5],[NaN,1],[1,Infinity],[Number.MAX_SAFE_INTEGER,2],[1,3],[MAX_FRAME_BYTES/4+1,1]])assert.equal(h.capture.leaseRaw(width,height),undefined);
 assert.equal(h.capture.stats.leasedFrames,0);assert.equal(h.capture.captured,0);assert.deepEqual(h.reports,[]);assert.equal(h.copies.length,0);
 assert.equal(h.capture.submit(source(1,3).value,0,0),undefined);assert.match(h.capture.stats.error,/용량 한도/);await h.finish();
});

test('invalid commits release their reservation without IDs or borrowed-source closure',async()=>{
 const h=harness({byteLimit:8});
 const attempts:[Source,number,number,'input'|'backup'][]=[
  [source(2,1).value,0,0,'input'],[source().value,-1,0,'input'],[source().value,0,NaN,'input'],
  [source().value,Infinity,0,'backup'],[source().value,0,0,'recovery' as never],
 ];
 for(const [borrowed,time,elapsed,role]of attempts){const lease=h.capture.leaseRaw(1,1)!;assert.equal(lease.commit(borrowed,time,elapsed,role),undefined);
  assert.equal(h.capture.stats.leasedBytes,0);assert.equal(h.capture.captured,0);assert.equal(lease.commit(source().value,0,0),undefined);lease.release();}
 const lease=h.capture.leaseRaw(1,1)!;const throwing={get width(){throw Error('source getter failed');},height:1} as HTMLCanvasElement;
 assert.throws(()=>lease.commit(throwing,0,0),/source getter failed/);assert.equal(h.capture.stats.leasedBytes,0);assert.equal(h.capture.stats.error,'');
 assert.equal(h.capture.leaseRaw(1,1)!.commit(source().value,0,0),1);await h.finish();
});

test('commit is reentrancy-safe when a source getter releases or terminates its lease',async()=>{
 const h=harness({byteLimit:4}),lease=h.capture.leaseRaw(1,1)!;
 const borrowed={get width(){lease.release();return 1;},height:1} as HTMLCanvasElement;
 assert.equal(lease.commit(borrowed,0,0),1);assert.equal(h.capture.stats.pendingBytes,4);assert.equal(h.capture.stats.leasedBytes,0);await h.finish();
 const ending=harness({byteLimit:4}),stale=ending.capture.leaseRaw(1,1)!;let finish:Promise<void>|undefined;
 const closesProducer={get width(){finish=ending.capture.finish();return 1;},height:1} as HTMLCanvasElement;
 assert.equal(stale.commit(closesProducer,0,0),undefined);assert.equal(ending.capture.captured,0);assert.equal(ending.copies.length,0);await finish;
});

test('bitmap and transfer exceptions return credit through the existing failure path without closing the source',async()=>{
 for(const options of [{copyThrows:true},{copyRejects:true},{sendThrows:true}]){
  const h=harness({byteLimit:4,...options}),borrowed=source(),lease=h.capture.leaseRaw(1,1)!;
  assert.equal(lease.commit(borrowed.value,0,0),1);await turn();assert.notEqual(h.capture.stats.error,'');
  assert.equal(h.capture.stats.pendingBytes,0);assert.equal(h.capture.stats.leasedBytes,0);assert.equal(h.capture.stats.peakReservedBytes,4);
  lease.release();assert.equal(h.capture.leaseRaw(1,1),undefined);assert.equal(borrowed.closes(),0);
  assert.ok(h.copies.every(copy=>copy.closed===1));await h.finish();
 }
});

test('finish, discard and original replay cut invalidate unused leases without creating work',async()=>{
 for(const terminal of ['finish','discard','frames']as const){
  const h=harness({byteLimit:8}),one=h.capture.leaseRaw(1,1)!,two=h.capture.leaseRaw(1,1)!;
  if(terminal==='frames')assert.equal((await h.capture.frames(new AbortController().signal).next()).done,true);
  else await h.capture[terminal]();
  const unreadable={get width(){throw Error('stale lease must not inspect source');}} as HTMLCanvasElement;
  assert.equal(one.commit(unreadable,0,0),undefined);one.release();two.release();assert.equal(h.capture.stats.leasedBytes,0);
  assert.equal(h.capture.leaseRaw(1,1),undefined);assert.equal(h.capture.captured,0);assert.equal(h.copies.length,0);assert.equal(h.frames.size,0);await h.finish();
 }
});

test('failure invalidates held leases while a late stored ACK returns physical credit only once',async()=>{
 const h=harness({byteLimit:8});assert.equal(h.capture.submit(source().value,0,0),1);const lease=h.capture.leaseRaw(1,1)!;await turn();
 h.fail();assert.equal(h.capture.stats.leasedBytes,0);assert.equal(h.capture.stats.pendingBytes,0);lease.release();h.ack(1);
 assert.equal(h.capture.stats.pendingBytes,0);assert.equal(h.capture.stats.storedFrames,1);assert.equal(lease.commit(source().value,1,1),undefined);await h.finish();
 const canceled=harness({byteLimit:4}),stale=canceled.capture.leaseRaw(1,1)!;canceled.capture.cancel();stale.release();
 assert.equal(canceled.capture.stats.leasedBytes,0);assert.equal(stale.commit(source().value,0,0),undefined);await canceled.finish();
});

test('physical records plus held leases share the existing ten-thousand slot bound',async()=>{
 const h=harness(),leases:CanonicalRawLease[]=[];
 for(let index=0;index<10_000;index++){const lease=h.capture.leaseRaw(1,1);assert.ok(lease);leases.push(lease);}
 assert.equal(h.capture.stats.leasedFrames,10_000);assert.equal(h.capture.captured,0);assert.equal(h.capture.rawCapacity(1,1),'busy');assert.equal(h.capture.leaseRaw(1,1),undefined);assert.equal(h.capture.stats.error,'');
 leases.pop()!.release();const prepared=h.capture.reserve({width:1,height:1,time:0,elapsed:0})!;assert.equal(prepared.id,1);
 h.capture.submitPrepared(prepared.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});h.ack(1);
 assert.equal(h.capture.rawCapacity(1,1),'busy');assert.equal(leases[0].commit(source().value,1,1),2);
 assert.equal(h.capture.stats.frames+h.capture.stats.leasedFrames,10_000);assert.equal(h.capture.captured,2);await h.finish();
 assert.equal(h.capture.stats.leasedFrames,0);assert.equal(h.capture.stats.leasedBytes,0);assert.equal(h.capture.stats.error,'');
});
