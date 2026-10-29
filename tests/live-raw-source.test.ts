import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanonicalCapture} from '../src/features/card-scanner/canonical-capture';
import {createLiveRawSource,type CanonicalRawLease} from '../src/features/card-scanner/live-raw-source';
import {createLiveInputAdmission} from '../src/features/card-scanner/live-input-admission';
import {createLiveCapturePipeline} from '../src/features/card-scanner/live-capture-pipeline';
import {createLiveOriginalCapture} from '../src/features/card-scanner/live-original-capture';
import {parseBackupCapacityDeferral,type BackupCapacityDeferral} from '../src/features/card-scanner/input-arrival';
import {MAX_FRAME_BYTES} from '../src/features/card-scanner/recording-frame-integrity';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
type Handle=VideoFrame&{readonly marker:string};
function handle(marker:string,width=2560,height=1440){
 let closed=0;
 return {value:{displayWidth:width,displayHeight:height,marker,close(){closed++;}} as Handle,closes:()=>closed};
}
interface FrameRequest {kind:'frame';id:number;width:number;height:number;time:number;role:string;bitmap:ImageBitmap&{marker:string}}
function storage(options:{byteLimit?:number}={}){
 const requests:Record<string,unknown>[]=[],reports:string[]=[],incomplete:string[]=[],frames=new Map<number,FrameRequest>(),acked=new Set<number>();
 const snapshots:{marker:string;width:number;height:number;closes:number}[]=[];let closed=0,started=0;
 const port={onmessage:null as ((event:MessageEvent)=>void)|null,start(){started++;},close(){closed++;},
  postMessage(value:Record<string,unknown>){requests.push(value);
   if(value.kind==='drain')queueMicrotask(()=>port.onmessage?.({data:{kind:'drained'}} as MessageEvent));
   if(value.kind==='frame'){const frame=value as unknown as FrameRequest;frames.set(frame.id,frame);frame.bitmap.close();}
  }};
 const capture=createCanonicalCapture({takePort:()=>port as unknown as MessagePort,incomplete:reason=>{incomplete.push(reason);},
  async readFrame(){throw Error('this capacity test must not allocate restored full rasters');}},reason=>reports.push(reason),{
   byteLimit:options.byteLimit,bitmapFactory:async source=>{
    const input=source as Handle,snapshot={marker:input.marker,width:input.displayWidth,height:input.displayHeight,closes:0};
    snapshots.push(snapshot);return {marker:snapshot.marker,close(){snapshot.closes++;}} as unknown as ImageBitmap;
   },
  });
 function ack(id:number){const frame=frames.get(id);assert.ok(frame);acked.add(id);
  port.onmessage?.({data:{kind:'stored',id,width:frame.width,height:frame.height,time:frame.time,hash:'a'.repeat(64)}} as MessageEvent);}
 return {capture,frames,requests,reports,incomplete,snapshots,ack,portCounts:()=>({closed,started}),
  async finish(){await turn();for(const id of frames.keys())if(!acked.has(id))ack(id);await capture.finish();},
 };
}

test('raw live leases persist only consumed inputs and due backups while replaced representatives return credit without source ID holes',async()=>{
 const h=storage(),admission=createLiveInputAdmission(),held=deferred(),frozen:ReturnType<typeof handle>[]=[],borrowed:ReturnType<typeof handle>[]=[];
 const deferredBackups:BackupCapacityDeferral[]=[],remembered:number[]=[],consumed:{marker:string;id:number|undefined;time:number}[]=[],errors:unknown[]=[];
 let backupCalls=0,freezeCalls=0,raw!:ReturnType<typeof createLiveRawSource>;
 const originals=createLiveOriginalCapture<Handle>((source,time,elapsed)=>{backupCalls++;return raw.backup(source,time,elapsed);});
 raw=createLiveRawSource(h.capture,{remember:elapsed=>{remembered.push(elapsed);originals.remember(elapsed);},
  backupDeferred:value=>{deferredBackups.push(value);}});
 type Input={source:Handle;lease:CanonicalRawLease;originalId:number|undefined;stampId:number};
 const pipeline=createLiveCapturePipeline<Input>({yieldTask:()=>Promise.resolve(),frameBytes:input=>input.source.displayWidth*input.source.displayHeight*4,
  consume:async(input,time)=>{
   const id=input.originalId??raw.commit(input.lease,input.source,time,time*1000);
   assert.ok(id!==undefined);consumed.push({marker:input.source.marker,id,time});
   if(input.stampId===1)await held.promise;
  },release:input=>{input.lease.release();input.source.close();},onError:error=>{errors.push(error);}});
 function arrival(marker:string,time:number,elapsed:number){
  const input=handle(marker);borrowed.push(input);
  const stamp=admission.stamp(time,elapsed),decision=admission.consider(stamp,{capturing:true,checkingCompletion:false,sourceCapacity:raw.capacity(input.value)});
  if(decision.kind==='skip')return decision;
  const lease=raw.lease(input.value);assert.ok(lease);
  freezeCalls++;const owned=handle(input.value.marker,input.value.displayWidth,input.value.displayHeight);frozen.push(owned);
  admission.frozen(stamp,{succeeded:true,freezeMs:0});
  const originalId=originals.capture(owned.value,time*1000,(source,time,elapsed)=>raw.commit(lease,source,time,elapsed,'backup'));
  pipeline.offer({source:owned.value,lease,originalId,stampId:stamp.inputId},time,stamp);
  return {kind:'offered' as const,originalId};
 }
 try{
  assert.deepEqual(arrival('input-1',0,0),{kind:'offered',originalId:1});await turn();
  assert.deepEqual(consumed,[{marker:'input-1',id:1,time:0}]);
  for(let index=2;index<=8;index++)assert.deepEqual(arrival(`input-${index}`,(index-1)*.033,(index-1)*33),{kind:'offered',originalId:undefined});
  assert.equal(h.capture.captured,1);assert.equal(h.snapshots.length,1,'leases and replaced inputs do not start a physical snapshot');
  assert.deepEqual(remembered,[0],'held representatives cannot suppress policy backups');
  assert.deepEqual(arrival('input-9',.264,264),{kind:'offered',originalId:2});
  assert.deepEqual(arrival('input-10',.297,297),{kind:'offered',originalId:undefined});
  await turn();assert.equal(freezeCalls,10);assert.equal(h.capture.captured,2);assert.equal(h.snapshots.length,2);
  assert.equal(h.capture.stats.leasedFrames,2);assert.equal(h.capture.stats.leasedBytes,2*2560*1440*4,'only the two surviving uncommitted representatives retain credit');
  assert.equal(h.frames.get(2)!.bitmap.marker,'input-9','a due backup survives replacement of its representative');
  assert.equal(h.frames.get(2)!.role,'backup');
  h.ack(1);assert.equal(h.capture.rawCapacity(2560,1440),'available');
  const background=handle('background-later');borrowed.push(background);
  assert.equal(originals.capture(background.value,514),3);await turn();assert.equal(backupCalls,1);
  assert.equal(h.frames.get(3)!.bitmap.marker,'background-later');assert.equal(h.frames.get(3)!.time,.514);
  assert.deepEqual(remembered,[0,264]);assert.deepEqual(deferredBackups,[]);
  held.resolve();await pipeline.flush();
  await turn();assert.deepEqual(consumed,[{marker:'input-1',id:1,time:0},{marker:'input-2',id:4,time:.033},{marker:'input-10',id:5,time:.297}]);
  assert.ok(consumed.every(value=>value.id!==3),'a newer background source never replaces an older input receipt');
  assert.deepEqual([...h.frames.keys()],[1,2,3,4,5],'released uncommitted leases do not leave dispatch ID holes');
  assert.deepEqual([...h.frames.values()].map(frame=>frame.bitmap.marker),['input-1','input-9','background-later','input-2','input-10']);
  for(const value of consumed){const stored=h.frames.get(value.id!)!;assert.equal(stored.bitmap.marker,value.marker);assert.equal(stored.time,value.time);}
  assert.deepEqual(remembered,[0,264,33,297]);assert.equal(originals.capture(background.value,763),undefined,'backdated input commits do not rewind the successful backup clock');
  assert.equal(h.capture.stats.leasedFrames,0);assert.equal(h.capture.stats.leasedBytes,0);
  pipeline.dispose();pipeline.dispose();assert.ok(frozen.every(input=>input.closes()===1));assert.ok(borrowed.every(input=>input.closes()===0));
  await h.finish();await h.capture.finish();assert.equal(h.capture.stats.storedFrames,5);assert.equal(h.capture.stats.pending,0);
  assert.equal(h.capture.stats.pendingBytes,0);assert.equal(h.capture.stats.error,'');
  assert.equal(h.portCounts().closed,1);assert.ok(h.snapshots.every(snapshot=>snapshot.closes===1));assert.deepEqual(errors,[]);
 }finally{held.resolve();pipeline.dispose();await pipeline.flush();await h.finish();}
});

test('unavailable and oversized raw inputs reach real submit validation without deferral, remembering or borrowed-handle release',async()=>{
 const closed=storage(),remembered:number[]=[],deferrals:BackupCapacityDeferral[]=[];
 const raw=createLiveRawSource(closed.capture,{remember:value=>remembered.push(value),backupDeferred:value=>deferrals.push(value)});
 const first=handle('successful',1,1);assert.equal(raw.input(first.value,1,1000),1);assert.deepEqual(remembered,[1000]);
 assert.equal(first.closes(),0);await closed.finish();
 const later=handle('inactive',1,1);assert.equal(closed.capture.rawCapacity(1,1),'unavailable');assert.equal(raw.capacity(later.value),true);
 assert.equal(raw.input(later.value,2,2000),undefined);assert.equal(raw.backup(later.value,2,2000),undefined);
 assert.deepEqual(remembered,[1000]);assert.deepEqual(deferrals,[]);assert.equal(later.closes(),0);assert.deepEqual(closed.reports,[]);
 for(const kind of ['input','backup']as const){
  const h=storage(),remembered:number[]=[],deferred:BackupCapacityDeferral[]=[],oversized=handle(kind,MAX_FRAME_BYTES/4+1,1);
  const source=createLiveRawSource(h.capture,{remember:value=>remembered.push(value),backupDeferred:value=>deferred.push(value)});
  try{
   assert.equal(h.capture.rawCapacity(oversized.value.displayWidth,1),'unavailable');assert.equal(source.capacity(oversized.value),true);
   assert.equal(source[kind](oversized.value,1,1000),undefined);assert.match(h.capture.stats.error,/용량 한도/);
   assert.equal(h.reports.length,1);assert.equal(h.incomplete.length,1);assert.equal(h.capture.captured,0);
   assert.equal(h.snapshots.length,0);assert.deepEqual(remembered,[]);assert.deepEqual(deferred,[]);assert.equal(oversized.closes(),0);
  }finally{await h.finish();}
 }
});

test('a failed freeze returns its lease without a source ID, snapshot or successful backup clock',async()=>{
 const h=storage({byteLimit:4}),remembered:number[]=[],raw=createLiveRawSource(h.capture,{remember:value=>remembered.push(value),backupDeferred:()=>assert.fail('a failed freeze cannot defer a backup')}),
  policy=createLiveInputAdmission(),borrowed=handle('not frozen',1,1),stamp=policy.stamp(0,0);
 try{
  assert.equal(policy.consider(stamp,{capturing:true,checkingCompletion:false,sourceCapacity:raw.capacity(borrowed.value)}).kind,'freeze');
  const lease=raw.lease(borrowed.value);assert.ok(lease);assert.equal(raw.capacity(borrowed.value),false);
  assert.equal(h.capture.stats.leasedBytes,4);
  assert.equal(h.capture.captured,0);assert.equal(h.snapshots.length,0);assert.deepEqual(remembered,[]);
  policy.frozen(stamp,{succeeded:false,freezeMs:0});lease.release();lease.release();
  assert.equal(h.capture.stats.leasedFrames,0);assert.equal(h.capture.stats.leasedBytes,0);
  assert.equal(raw.capacity(borrowed.value),true);assert.equal(h.capture.captured,0);assert.equal(borrowed.closes(),0);
  const next=policy.stamp(.001,0);assert.equal(policy.consider(next,{capturing:true,checkingCompletion:false,sourceCapacity:raw.capacity(borrowed.value)}).kind,'freeze');
  policy.frozen(next,{succeeded:false,freezeMs:0});assert.deepEqual(h.reports,[]);assert.deepEqual(h.incomplete,[]);
 }finally{await h.finish();}
});

test('committed lease credit waits for its ACK while busy backups defer before snapshotting and mint no source ID',async()=>{
 const h=storage({byteLimit:8}),remembered:number[]=[],deferrals:BackupCapacityDeferral[]=[],source=handle('borrowed',1,1),
  raw=createLiveRawSource(h.capture,{remember:value=>remembered.push(value),backupDeferred:value=>deferrals.push(value)});
 try{
  const first=raw.lease(source.value);assert.ok(first);assert.equal(h.capture.captured,0);
  assert.equal(raw.commit(first,source.value,0,0),1);first.release();assert.equal(h.capture.stats.pendingBytes,4);
  assert.equal(h.capture.stats.leasedBytes,0);
  const second=raw.lease(source.value);assert.ok(second);assert.equal(raw.commit(second,source.value,.25,250,'backup'),2);second.release();
  assert.equal(raw.capacity(source.value),false);assert.equal(raw.lease(source.value),undefined);
  assert.equal(raw.backup(source.value,.5,500),undefined);assert.equal(h.snapshots.length,2);assert.equal(h.capture.captured,2);
  assert.deepEqual(deferrals,[{version:1,reason:'source-capacity',captureTime:.5,observedAtMs:500,width:1,height:1,pendingBytes:8}]);
  assert.deepEqual(parseBackupCapacityDeferral(JSON.parse(JSON.stringify(deferrals[0]))),deferrals[0]);
  await turn();h.ack(1);assert.equal(raw.capacity(source.value),true);
  const third=raw.lease(source.value);assert.ok(third);assert.equal(raw.commit(third,source.value,.501,501),3);third.release();
  await turn();assert.deepEqual([...h.frames.keys()],[1,2,3]);assert.deepEqual(remembered,[0,250,501]);
  assert.equal(source.closes(),0);assert.deepEqual(h.reports,[]);assert.deepEqual(h.incomplete,[]);
 }finally{await h.finish();}
});

test('a failed lease commit never falls back to submitting unrelated pixels or advances the successful clock',async()=>{
 const h=storage(),remembered:number[]=[],source=handle('unused',1,1),raw=createLiveRawSource(h.capture,{remember:value=>remembered.push(value),backupDeferred:()=>assert.fail('a failed input commit cannot defer a backup')});
 let released=0;
 try{
  const rejected:CanonicalRawLease={commit:()=>undefined,release:()=>{released++;}};
  assert.equal(raw.commit(rejected,source.value,1,1000),undefined);assert.equal(released,0);
  const thrown:CanonicalRawLease={commit:()=>{throw Error('commit failed');},release:()=>{released++;}};
  assert.throws(()=>raw.commit(thrown,source.value,1,1000),/commit failed/);
  assert.equal(h.capture.captured,0);assert.equal(h.snapshots.length,0);assert.deepEqual(remembered,[]);assert.equal(source.closes(),0);
  rejected.release();thrown.release();assert.equal(released,2);
  const actual=raw.lease(source.value);assert.ok(actual);h.capture.cancel();
  assert.equal(raw.commit(actual,source.value,2,2000),undefined);actual.release();
  assert.equal(h.capture.captured,0);assert.equal(h.snapshots.length,0);assert.deepEqual(remembered,[]);
 }finally{await h.finish();}
});

test('disposing representatives releases uncommitted credit while an already committed backup still receives its ACK',async()=>{
 const h=storage(),held=deferred(),inputs=[handle('active',1,1),handle('pending-older',1,1),handle('pending-newer',1,1)];
 const raw=createLiveRawSource(h.capture,{remember(){},backupDeferred:()=>assert.fail('available sources must not defer')});
 const consumed:number[]=[],errors:unknown[]=[],pipeline=createLiveCapturePipeline<{source:Handle;lease:CanonicalRawLease;id?:number}>({
  yieldTask:()=>Promise.resolve(),frameBytes:()=>4,consume:async(input,time)=>{const id=input.id??raw.commit(input.lease,input.source,time,time*1000);
   assert.ok(id!==undefined);consumed.push(id);await held.promise;},
  release:input=>{input.lease.release();input.source.close();},onError:error=>{errors.push(error);}});
 try{
  for(const [index,input]of inputs.entries()){
   const lease=raw.lease(input.value);assert.ok(lease);assert.equal(input.closes(),0);
   const id=index===2?raw.commit(lease,input.value,index,index*1000,'backup'):undefined;
   pipeline.offer({source:input.value,lease,id},index);if(index===0)await turn();
  }
  await turn();pipeline.dispose();pipeline.dispose();assert.deepEqual(inputs.map(input=>input.closes()),[0,1,1]);
  assert.equal(h.capture.stats.pending,2);assert.equal(h.capture.captured,2);assert.deepEqual(consumed,[1]);
  assert.equal(h.capture.stats.leasedFrames,0);assert.equal(h.capture.stats.leasedBytes,0);
  assert.equal(h.capture.stats.pendingBytes,8,'uncommitted pending-older lease has returned its byte credit');
  await h.finish();assert.equal(h.capture.stats.storedFrames,2);assert.equal(h.capture.stats.error,'');
  assert.deepEqual([...h.frames.values()].map(frame=>frame.bitmap.marker),['active','pending-newer']);
  assert.deepEqual(h.reports,[]);assert.deepEqual(h.incomplete,[]);
  held.resolve();await pipeline.flush();pipeline.dispose();assert.deepEqual(inputs.map(input=>input.closes()),[1,1,1]);
  assert.ok(h.snapshots.every(snapshot=>snapshot.closes===1));assert.deepEqual(errors,[]);assert.equal(h.portCounts().closed,1);
 }finally{held.resolve();pipeline.dispose();await pipeline.flush();await h.finish();}
});
