import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaSequenceStart,createMediaDecodedFrame,createMediaSequenceEnd,parseMediaInputLink} from '../src/features/card-scanner/media-lineage';
import {normalizeScannerInputFrame} from '../src/features/card-scanner/scanner-input-frame';
import {RunStateTrace,parseRunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';

const playbackId='12345678-1234-4234-8234-123456789abc';
test('display callbacks and decoder uses retain separate clocks and cannot create inventory evidence',async()=>{
 const plain=new RunStateTrace(),trace=new RunStateTrace(),signal=new AbortController().signal;
 const record=(type:string,value:unknown,time=0)=>assert.equal(trace.record(type,value,time),true);
 record('source-playback',{version:1,type:'start',playbackId,observedAtMs:0,callbackSupported:true});
 for(const callbackOrdinal of [1,2])record('source-playback',{version:1,type:'frame',playbackId,observedAtMs:callbackOrdinal,
  callbackOrdinal,mediaTime:12,presentedFrames:77,width:1920,height:1080});
 record('source-playback',{version:1,type:'end',playbackId,observedAtMs:3,reason:'ended',naturalEnd:true,callbacks:2});
 const start=createMediaSequenceStart(new Blob(['encoded stream'],{type:'video/webm'}),{role:'re-recorded-video',parentCaptureSessionId:'capture'});
 const frame=createMediaDecodedFrame(start,1,.125,{trackId:1,duration:.04});
 record('media-lineage',start);record('media-lineage',frame);
 record('media-input-link',parseMediaInputLink({version:1,sequenceId:start.sequenceId,sourceId:start.sourceId,role:start.role,
  ordinal:1,processingFrame:19,acquisitionFrameId:27,captureTime:.125,phase:'recovery'}));
 record('media-lineage',createMediaSequenceEnd(start,1,'eof'));
 const parsed=await parseRunStateTrace(await trace.snapshotBlob(),signal);
 const callbacks=parsed.events.filter(event=>event.type==='source-playback'&&event.value.type==='frame');
 assert.equal(callbacks.length,2,'same mediaTime is not deduplicated into a fictional decoder sample');
 const a=await replayRunStateTrace(await plain.snapshotBlob(),signal),b=await replayRunStateTrace(await trace.snapshotBlob(),signal);
 for(const key of ['grid','inventory','input','observations','unknownLifecycle']as const)assert.deepEqual(b[key],a[key]);
 assert.equal(b.inventory.supported,false);assert.equal(b.input.supported,false);
});

test('common input preserves borrowed pixels and validates decoder origin independently of canonical provenance',()=>{
 const element={}as HTMLCanvasElement,start=createMediaSequenceStart('local-original',{role:'original-file'});
 const lineage=createMediaDecodedFrame(start,4,2,{duration:.1,trackId:7});
 const input={element,time:2,percent:50,lineage},normalized=normalizeScannerInputFrame(input);
 assert.equal(normalized.element,element);assert.notEqual(normalized.lineage,lineage);assert.ok(Object.isFrozen(normalized.lineage));
 assert.equal(normalized.provenance,undefined);assert.equal(normalized.lineage!.ordinal,4);
 assert.throws(()=>normalizeScannerInputFrame({...input,time:2.01}),/lineage PTS/);
 assert.throws(()=>normalizeScannerInputFrame({...input,lineage:{...lineage,originalOrdinal:4}as typeof lineage}),/media lineage/);
 assert.equal(normalizeScannerInputFrame({element,time:0,percent:0}).lineage,undefined);
});

test('malformed playback diagnostics and loss markers refuse complete state replay',async()=>{
 const signal=new AbortController().signal;
 for(const [type,value]of [
  ['source-playback',{version:1,type:'start',playbackId,observedAtMs:0,callbackSupported:true,originalFrame:1}],
  ['media-recording-error',{error:'lost source receipt'}],
 ]as const){
  const trace=new RunStateTrace();assert.equal(trace.record(type,value,0),false);assert.equal(trace.stats.complete,false);
  await assert.rejects(replayRunStateTrace(await trace.snapshotBlob(),signal),/불완전/);
 }
});
