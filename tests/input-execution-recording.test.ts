import {test} from 'node:test';
import assert from 'node:assert/strict';
import {entryParts,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import type {ExactEvent} from '../src/features/card-scanner/exact-recording-codec';
import {createLiveInputAdmission} from '../src/features/card-scanner/live-input-admission';
import type {InputStamp,LiveInputAdmissionFact} from '../src/features/card-scanner/live-input-admission';
import {createLiveCapturePipeline} from '../src/features/card-scanner/live-capture-pipeline';
import {InputDecisionReplay} from '../src/features/card-scanner/live-input-decision-replay';
import {RunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';

const signal=()=>new AbortController().signal;
const archive=(events:readonly ExactEvent[])=>new Blob(events.flatMap(event=>entryParts(event)));
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

async function capturedRun(){
  const events:ExactEvent[]=[],policy=createLiveInputAdmission(),replay=new InputDecisionReplay(signal());
  let now=0;const yielded=deferred(),active=deferred(),seen:number[]=[],released:number[]=[];
  const emit=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:now/1000,type,value});
  const fact=(value:LiveInputAdmissionFact)=>{replay.admission(value);emit('input-admission',value);};
  const pipeline=createLiveCapturePipeline<InputStamp>({maxPendingFrames:1,now:()=>now,yieldTask:()=>yielded.promise,
    onDecision:value=>{replay.pipeline(value);emit('input-decision',value);},onRecordError:assert.fail,onError:assert.fail,
    consume:async(stamp,captureTime)=>{
      seen.push(stamp.inputId);const startedAtMs=now;
      assert.equal(captureTime,stamp.captureTime);
      const link={inputId:stamp.inputId,frameId:stamp.inputId+100,captureTime,phase:'input' as const};
      replay.link(link);emit('input-link',link);
      if(seen.length===1)await active.promise;
      const value={kind:'completed' as const,startedAtMs,endedAtMs:now};
      policy.completed(startedAtMs,now);fact(value);
    },release:stamp=>{released.push(stamp.inputId);},
  });
  const arrive=(at:number,captureTime:number)=>{
    now=at;const stamp=policy.stamp(captureTime,now),gates={capturing:true,checkingCompletion:false};
    const decision=policy.consider(stamp,gates);
    fact({kind:'consider',stamp,gates,expected:decision.kind==='freeze'?'freeze':decision.reason});
    if(decision.kind==='freeze'){
      policy.frozen(stamp,{succeeded:true,freezeMs:1});fact({kind:'frozen',stamp,succeeded:true,freezeMs:1});
      pipeline.offer(stamp,stamp.captureTime,stamp);
    }
  };
  arrive(0,10);arrive(50,11);yielded.resolve();await turn();
  assert.deepEqual(seen,[2]);arrive(100,12);arrive(150,0.5);
  now=200;active.resolve();await pipeline.flush();
  assert.deepEqual(seen,[2,4]);assert.deepEqual(released,[1,3,2,4]);
  assert.deepEqual(policy.snapshot().pending,null);
  const captured=await replay.summary();
  emit('input-checkpoint',{complete:true,hash:captured.hash});
  return {events,captured,emit};
}

test('real admission and latest-pending pipeline choices replay from the exact archive to the captured hash',async()=>{
  const {events,captured}=await capturedRun();
  const blob=archive(events),result=await executionSummary(blob,signal(),{complete:true,dropped:0,events:events.length,frames:0});
  assert.equal(result.recordingComplete,true);assert.equal(result.frames,0);
  assert.equal(result.input.supported,true);assert.equal(result.input.settled,true);
  assert.equal(result.input.hash,captured.hash);assert.equal(result.input.expectedHash,captured.hash);
  assert.equal(result.input.matchesCapturedState,true);
  assert.deepEqual(result.input.pipeline,{supported:true,decisions:14,offered:4,replaced:2,started:2,finished:2,released:4,linked:2,retained:0});
  assert.deepEqual(result.input.admission,{supported:true,facts:10,considered:4,frozen:4,skipped:0,freezeFailed:0,completed:2});
  const starts=events.filter(event=>event.type==='input-decision'&&(event.value as {kind:string}).kind==='started');
  assert.deepEqual(starts.map(event=>(event.value as {captureTime:number}).captureTime),[11,0.5],
    'selection identity does not replace native capture time or imply card freshness');
  assert.equal(result.observations.supported,false);assert.equal(result.cards.length,0,
    'policy replay does not pretend to reconstruct pixels or recognition results');
  assert.deepEqual((await executionSummary(blob,signal())).input,result.input);
});

test('recording failure and incomplete container explicitly invalidate equality while legacy remains unsupported',async()=>{
  const {events,captured,emit}=await capturedRun();
  const totals={complete:true,dropped:0,events:events.length,frames:0};
  const partial=await executionSummary(archive(events),signal(),{...totals,complete:false,dropped:1});
  assert.equal(partial.recordingComplete,false);assert.equal(partial.input.hash,captured.hash);
  assert.equal(partial.input.matchesCapturedState,null);
  emit('input-recording-error',{message:'decision recording failed'});
  const lost=await executionSummary(archive(events),signal(),{...totals,events:events.length});
  assert.equal(lost.recordingComplete,false);assert.equal(lost.input.matchesCapturedState,null);
  const legacy=await executionSummary(archive([{kind:'event',seq:1,time:0,type:'frame',value:{}}]),signal());
  assert.equal(legacy.recordingComplete,null);assert.equal(legacy.input.supported,false);
  assert.equal(legacy.input.hash,null);assert.equal(legacy.input.matchesCapturedState,null);
});

test('missing and failed checkpoints are unknown while an incorrect settled checkpoint is a mismatch',async()=>{
  const {events,captured,emit}=await capturedRun(),noCheckpoint=events.slice(0,-1);
  const missing=await executionSummary(archive(noCheckpoint),signal());
  assert.equal(missing.input.hash,captured.hash);assert.equal(missing.input.matchesCapturedState,null);
  emit('input-checkpoint',{complete:false,error:'checkpoint interrupted'});
  const interrupted=await executionSummary(archive(events),signal());
  assert.equal(interrupted.input.expectedHash,null);assert.equal(interrupted.input.matchesCapturedState,null);
  emit('input-checkpoint',{complete:true,hash:'a'.repeat(64)});
  assert.equal((await executionSummary(archive(events),signal())).input.matchesCapturedState,false);
});

test('decision recording errors leave scanning operational but cannot claim settled matching input state',async()=>{
  const events:ExactEvent[]=[],replay=new InputDecisionReplay(signal());let consumed=0,released=0,losses=0;
  const emit=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:0,type,value});
  const pipeline=createLiveCapturePipeline<number>({now:()=>0,yieldTask:()=>Promise.resolve(),
    consume:()=>{consumed++;},release:()=>{released++;},onError:assert.fail,
    onDecision:value=>{
      if(value.kind==='started')throw Error('storage failed');
      replay.pipeline(value);emit('input-decision',value);
    },onRecordError:()=>{losses++;emit('input-recording-error',{message:'storage failed'});},
  });
  pipeline.offer(1,1);await pipeline.flush();
  assert.equal(consumed,1);assert.equal(released,1);assert.equal(losses,1);
  const partial=await replay.summary();emit('input-checkpoint',{complete:false,error:'storage failed'});
  const result=await executionSummary(archive(events),signal());
  assert.equal(result.recordingComplete,false);assert.equal(result.input.supported,true);
  assert.equal(result.input.settled,false);assert.equal(result.input.hash,partial.hash);
  assert.equal(result.input.matchesCapturedState,null);
});

test('changed policy choices, broken ownership and reordered event envelopes reject during archive replay',async()=>{
  const {events}=await capturedRun();
  const changed=events.map(event=>event.type==='input-admission'&&(event.value as {kind:string}).kind==='consider'
    ?{...event,value:{...(event.value as object),expected:'cadence'}}:event);
  await assert.rejects(executionSummary(archive(changed),signal()),/differs from the recorded choice/);
  const broken=events.map(event=>event.type==='input-decision'&&(event.value as {kind:string}).kind==='released'
    ?{...event,value:{...(event.value as object),inputId:999}}:event);
  await assert.rejects(executionSummary(archive(broken),signal()));
  await assert.rejects(executionSummary(archive([...events,events[0]]),signal()),/이벤트 순서/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(executionSummary(archive(events),controller.signal),{name:'AbortError'});
});

test('actual two-representative policy and immutable source annotations replay through raw and gzip archives',async()=>{
  type Frame={inputId:number;rowStart:number};
  const events:ExactEvent[]=[],trace=new RunStateTrace(),replay=new InputDecisionReplay(signal());
  const active=deferred(),seen:number[]=[],released:number[]=[];let now=0;
  const emit=(type:string,value:unknown)=>{
    const time=now/1000;events.push({kind:'event',seq:events.length+1,time,type,value});
    assert.equal(trace.record(type,value,time),true);
  };
  const pipeline=createLiveCapturePipeline<Frame>({maxPendingFrames:2,maxRetainedBytes:30,frameBytes:()=>10,
    now:()=>now++,yieldTask:()=>Promise.resolve(),onError:assert.fail,onRecordError:assert.fail,
    onDecision:value=>{replay.pipeline(value);emit('input-decision',value);},
    consume:async(frame,captureTime)=>{
      seen.push(frame.inputId);
      const link={inputId:frame.inputId,frameId:frame.inputId+100,captureTime,phase:'input' as const};
      replay.link(link);emit('input-link',link);
      if(frame.inputId===1)await active.promise;
    },release:frame=>{released.push(frame.inputId);},
  });
  const offer=(inputId:number)=>{
    const rowStart=(inputId-1)*4,captureTime=inputId/10;
    pipeline.offer({inputId,rowStart},captureTime,{inputId,captureTime,observedAtMs:now,
      source:{mediaTime:inputId,presentedFrames:inputId*30,frameTimestampUs:inputId*1_000_000}},
    {rowStart,rowCount:4});
  };
  offer(1);await turn();offer(2);offer(3);offer(4);
  active.resolve();await pipeline.flush();
  assert.deepEqual(seen,[1,2,4]);assert.deepEqual(released,[3,1,2,4]);
  const captured=await replay.summary();emit('input-checkpoint',{complete:true,hash:captured.hash});
  const raw=await executionSummary(archive(events),signal(),{complete:true,dropped:0,events:events.length,frames:0});
  const compressed=await replayRunStateTrace(await trace.snapshotBlob(),signal());
  assert.equal(raw.input.matchesCapturedState,true);assert.equal(compressed.input.matchesCapturedState,true);
  assert.equal(raw.input.hash,captured.hash);assert.equal(compressed.input.hash,captured.hash);
  assert.equal(raw.input.pipeline.started,3);assert.equal(raw.input.pipeline.replaced,1);
  assert.equal(raw.cards.length,0,'selection/source replay does not create recognition evidence');
});
