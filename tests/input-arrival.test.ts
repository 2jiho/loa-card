import test from 'node:test';
import assert from 'node:assert/strict';
import {inputArrival,parseInputArrival,parseInputBackupReservation,parseBackupCapacityDeferral} from '../src/features/card-scanner/input-arrival';
import {MAX_FRAME_BYTES} from '../src/features/card-scanner/recording-frame-integrity';
import {createLiveInputAdmission} from '../src/features/card-scanner/live-input-admission';
import {RunStateTrace,parseRunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';

const stamp={inputId:1,captureTime:3.2,observedAtMs:400};
const callback={mediaTime:19.3,presentedFrames:77,missedFrames:2};
test('arrival coordinates are detached immutable diagnostics in separate clock namespaces',()=>{
 const value=inputArrival(stamp,-10,callback);callback.mediaTime=20;
 assert.equal(value.delivery,'video-callback');assert.equal(value.callback!.mediaTime,19.3);
 assert.equal(value.nativeTimestampUs,-10);assert.equal(value.captureTime,3.2);
 assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.callback));
 assert.equal(Object.hasOwn(stamp,'source'),false);
 assert.deepEqual(inputArrival(stamp),{version:1,...stamp,delivery:'video-poll'});
 assert.equal(inputArrival(stamp,0).delivery,'track-frame');
});
test('malformed arrival fields and invented pixel authority are refused',()=>{
 const base=inputArrival(stamp);
 for(const patch of [{inputId:0},{captureTime:NaN},{observedAtMs:-1},{source:{}},{pixels:[1]},
  {nativeTimestampUs:1},{delivery:'track-frame'},{callback:{mediaTime:1,presentedFrames:1,missedFrames:0}},
  {delivery:'video-callback',callback:{mediaTime:1,presentedFrames:1,missedFrames:0,originalOrdinal:1}}])
  assert.throws(()=>parseInputArrival({...base,...patch}));
 for(const value of [NaN,Infinity,1.2,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>inputArrival(stamp,value));
 for(const invalid of [{mediaTime:-1,presentedFrames:0,missedFrames:0},{mediaTime:0,presentedFrames:1.1,missedFrames:0},
  {mediaTime:0,presentedFrames:1,missedFrames:-1}])assert.throws(()=>inputArrival(stamp,undefined,invalid));
});
test('backup reservation is explicitly nullable and does not assert persistence or acquisition identity',()=>{
 const value={version:1,inputId:2,captureTime:1.25,store:'prepared-native',reservationId:8};
 assert.deepEqual(parseInputBackupReservation(value),value);assert.ok(Object.isFrozen(parseInputBackupReservation(value)));
 assert.equal(parseInputBackupReservation({...value,reservationId:null}).reservationId,null);
 for(const patch of [{reservationId:0},{reservationId:NaN},{store:'persisted'},{acquisitionFrameId:3},{hash:'invented'},
  {inputId:-1},{captureTime:Infinity}])assert.throws(()=>parseInputBackupReservation({...value,...patch}));
});

const backupDeferral={version:1,reason:'source-capacity',captureTime:3.25,observedAtMs:400,width:2560,height:1440,pendingBytes:14_745_600};
test('backup capacity deferral is detached planned metadata and round trips without pixel or identity authority',()=>{
 const original={...backupDeferral},parsed=parseBackupCapacityDeferral(original);original.captureTime=999;original.pendingBytes=0;
 assert.deepEqual(parsed,backupDeferral);assert.notEqual(parsed,original);assert.ok(Object.isFrozen(parsed));
 assert.deepEqual(parseBackupCapacityDeferral(JSON.parse(JSON.stringify(parsed))),parsed);
 assert.notEqual(parseBackupCapacityDeferral(parsed),parsed);
 assert.deepEqual(Object.keys(parsed),['version','reason','captureTime','observedAtMs','width','height','pendingBytes']);
 assert.equal(parseBackupCapacityDeferral({...backupDeferral,captureTime:0,observedAtMs:0,pendingBytes:0}).pendingBytes,0);
 assert.equal(parseBackupCapacityDeferral({...backupDeferral,width:MAX_FRAME_BYTES/4,height:1,pendingBytes:Number.MAX_SAFE_INTEGER}).width,MAX_FRAME_BYTES/4);
 const nullPrototype=Object.assign(Object.create(null),backupDeferral);assert.deepEqual(parseBackupCapacityDeferral(nullPrototype),parsed);
});

test('backup capacity deferral rejects invalid dimensions, times, byte counts and invented evidence',()=>{
 for(const patch of [{version:2},{reason:'capacity'},{width:MAX_FRAME_BYTES/4+1,height:1},
  {width:Number.MAX_SAFE_INTEGER,height:Number.MAX_SAFE_INTEGER},{inputId:1},{sourceFrameId:1},{reservationId:1},
  {pixels:[1]},{hash:'invented'},{card:{}},{position:{}},{complete:true}])
  assert.throws(()=>parseBackupCapacityDeferral({...backupDeferral,...patch}));
 for(const field of ['captureTime','observedAtMs']as const)for(const value of [-1,NaN,Infinity,'1',null,undefined])
  assert.throws(()=>parseBackupCapacityDeferral({...backupDeferral,[field]:value}));
 for(const field of ['width','height']as const)for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'8',null])
  assert.throws(()=>parseBackupCapacityDeferral({...backupDeferral,[field]:value}));
 for(const value of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'0',null])
  assert.throws(()=>parseBackupCapacityDeferral({...backupDeferral,pendingBytes:value}));
 for(const field of Object.keys(backupDeferral)){const missing={...backupDeferral} as Record<string,unknown>;delete missing[field];assert.throws(()=>parseBackupCapacityDeferral(missing));}
 for(const input of [null,[],new Date(),Object.assign(Object.create({}),backupDeferral)])assert.throws(()=>parseBackupCapacityDeferral(input));
 assert.throws(()=>parseBackupCapacityDeferral({...backupDeferral,[Symbol('pixels')]:[1]}));
 assert.throws(()=>parseBackupCapacityDeferral(Object.defineProperty({...backupDeferral},'sourceFrameId',{value:1})));
});

test('backup capacity deferral stays a retained fact while malformed facts mark trace loss',async()=>{
 const original={...backupDeferral},trace=new RunStateTrace();assert.equal(trace.record('backup-capacity-deferral',original,0),true);original.pendingBytes=0;
 const blob=await trace.snapshotBlob(),parsed=await parseRunStateTrace(blob,new AbortController().signal);
 assert.equal(parsed.events.length,1);const event=parsed.events[0];assert.equal(event.type,'backup-capacity-deferral');
 if(event.type!=='backup-capacity-deferral')throw Error('Missing diagnostic');assert.deepEqual(event.value,backupDeferral);assert.ok(Object.isFrozen(event.value));
 const replay=await replayRunStateTrace(blob,new AbortController().signal);assert.equal(replay.events,1);
 for(const key of ['grid','inventory','input','unknownLifecycle']as const)assert.equal(replay[key].supported,false);
 assert.equal(replay.input.hash,null);assert.equal(replay.unknownLifecycle.matchesCapturedState,null);
 const invalid=new RunStateTrace();assert.equal(invalid.record('backup-capacity-deferral',{...backupDeferral,sourceFrameId:1},0),false);
 assert.equal(invalid.stats.dropped,1);await assert.rejects(replayRunStateTrace(await invalid.snapshotBlob(),new AbortController().signal),/불완전/);
});
test('all admission arrivals including cadence skips round trip without changing policy replay',async()=>{
 const plain=new RunStateTrace(),augmented=new RunStateTrace(),admission=createLiveInputAdmission();
 const gates={capturing:true,checkingCompletion:false};
 const first=admission.stamp(1,1000),decision=admission.consider(first,gates);assert.equal(decision.kind,'freeze');
 const record=(type:string,value:unknown,time:number)=>{assert.equal(plain.record(type,value,time),true);assert.equal(augmented.record(type,value,time),true);};
 assert.equal(augmented.record('input-arrival',inputArrival(first,undefined,{mediaTime:7,presentedFrames:9,missedFrames:0}),0),true);
 record('input-admission',{kind:'consider',stamp:first,gates,expected:'freeze'},0);
 admission.frozen(first,{succeeded:true,freezeMs:1});record('input-admission',{kind:'frozen',stamp:first,succeeded:true,freezeMs:1},0);
 assert.equal(augmented.record('input-backup-reservation',{version:1,inputId:first.inputId,captureTime:1,store:'capture-originals',reservationId:null},0),true);
 const second=admission.stamp(1.01,1001),skipped=admission.consider(second,gates);assert.deepEqual(skipped.kind,'skip');
 if(skipped.kind!=='skip')throw Error('Expected a cadence skip');assert.equal(skipped.reason,'cadence');
 assert.equal(augmented.record('input-arrival',inputArrival(second,undefined,{mediaTime:7.01,presentedFrames:10,missedFrames:0}),.01),true);
 record('input-admission',{kind:'consider',stamp:second,gates,expected:'cadence'},.01);
 const plainBlob=await plain.snapshotBlob(),augmentedBlob=await augmented.snapshotBlob(),signal=new AbortController().signal;
 const parsed=await parseRunStateTrace(augmentedBlob,signal);
 assert.equal(parsed.events.filter(event=>event.type==='input-arrival').length,2);
 assert.equal(parsed.events.filter(event=>event.type==='input-backup-reservation').length,1);
 assert.equal(parsed.events.filter(event=>event.type==='input-decision'||event.type==='input-link').length,0);
 const a=await replayRunStateTrace(plainBlob,signal),b=await replayRunStateTrace(augmentedBlob,signal);
 for(const key of ['input','grid','inventory','observations','unknownLifecycle']as const)assert.deepEqual(b[key],a[key]);
 assert.equal(Object.hasOwn(first,'source'),false);
});
test('malformed optional diagnostics make trace incomplete without fabricating a policy event',async()=>{
 const trace=new RunStateTrace();assert.equal(trace.record('input-arrival',{...inputArrival(stamp),pixels:[1]},0),false);
 assert.equal(trace.stats.dropped,1);await assert.rejects(replayRunStateTrace(await trace.snapshotBlob(),new AbortController().signal),/불완전/);
 const only=new RunStateTrace();only.record('input-arrival',inputArrival(stamp),0);
 const result=await replayRunStateTrace(await only.snapshotBlob(),new AbortController().signal);
 assert.equal(result.input.supported,false);assert.equal(result.inventory.supported,false);
});
