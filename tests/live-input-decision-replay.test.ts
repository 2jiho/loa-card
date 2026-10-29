import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveCapturePipeline} from '../src/features/card-scanner/live-capture-pipeline';
import type {LiveCaptureDecision} from '../src/features/card-scanner/live-capture-pipeline';
import {createLiveInputAdmission} from '../src/features/card-scanner/live-input-admission';
import type {LiveInputAdmissionFact} from '../src/features/card-scanner/live-input-admission';
import {InputDecisionReplay,parseInputCheckpoint,parseInputFrameLink} from '../src/features/card-scanner/live-input-decision-replay';

const signal=()=>new AbortController().signal;
const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function completedInput(inputId:number,startSequence=1):LiveCaptureDecision[] {
  const base={version:1 as const,inputId,captureTime:inputId/10};
  return [
    {...base,seq:startSequence,atMs:startSequence,kind:'offered',observedAtMs:startSequence},
    {...base,seq:startSequence+1,atMs:startSequence+1,kind:'started'},
    {...base,seq:startSequence+2,atMs:startSequence+2,kind:'finished',outcome:'completed'},
    {...base,seq:startSequence+3,atMs:startSequence+3,kind:'released',reason:'normal',failed:false},
  ];
}

test('actual pipeline replacement, selection and worker links replay to the captured input hash',async()=>{
  const live=new InputDecisionReplay(signal()),events:({kind:'pipeline';value:LiveCaptureDecision}|{kind:'link';value:unknown})[]=[];
  const yields:(()=>void)[]=[];let clock=0;
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:()=>new Promise(resolve=>yields.push(resolve)),
    consume:(inputId,captureTime)=>{
      const value={inputId,frameId:inputId+100,captureTime,phase:'input'};
      live.link(value);events.push({kind:'link',value});
    },release:()=>{},onError:assert.fail,now:()=>clock++,
    onDecision:value=>{live.pipeline(value);events.push({kind:'pipeline',value});}});
  pipeline.offer(1,0.1);pipeline.offer(2,0.2);pipeline.offer(3,0.3);
  await turn();assert.equal(yields.length,1);yields.shift()!();await pipeline.flush();
  const captured=await live.summary();
  assert.deepEqual(captured.pipeline,{supported:true,decisions:10,offered:3,replaced:2,started:1,finished:1,released:3,linked:1,retained:0});
  assert.equal(captured.settled,true);assert.equal(captured.matchesCapturedState,null);
  const replay=new InputDecisionReplay(signal());
  for(const event of events)if(event.kind==='pipeline')replay.pipeline(event.value);else replay.link(event.value);
  replay.checkpoint({complete:true,hash:captured.hash});
  const restored=await replay.summary();assert.equal(restored.matchesCapturedState,true);assert.equal(restored.hash,captured.hash);
  const altered=new InputDecisionReplay(signal());
  for(const event of events)if(event.kind==='pipeline')altered.pipeline(event.value);else altered.link({...event.value as object,frameId:999});
  altered.checkpoint({complete:true,hash:captured.hash});assert.equal((await altered.summary()).matchesCapturedState,false);
});

test('admission replay checks intermediate choices without retaining skipped arrivals',async()=>{
  const policy=createLiveInputAdmission(),replay=new InputDecisionReplay(signal());
  const gates={capturing:true,checkingCompletion:false};
  const facts:LiveInputAdmissionFact[]=[];
  for(let i=0;i<100;i++){
    const stamp=policy.stamp(i/60,i*16),decision=policy.consider(stamp,gates);
    facts.push({kind:'consider',stamp,gates,expected:decision.kind==='freeze'?'freeze':decision.reason});
    if(decision.kind==='freeze'){
      const fact:LiveInputAdmissionFact={kind:'frozen',stamp,succeeded:true,freezeMs:1};
      policy.frozen(stamp,fact);facts.push(fact);
    }
  }
  for(const fact of facts)replay.admission(fact);
  const result=await replay.summary();assert.equal(result.supported,true);assert.equal(result.admission.considered,100);
  assert.equal(result.admission.frozen,policy.snapshot().offered);assert.equal(result.admission.skipped,100-result.admission.frozen);
  assert.equal(result.pipeline.supported,false);assert.equal(result.settled,true);
  const wrong=new InputDecisionReplay(signal());
  assert.throws(()=>wrong.admission({...facts[0],expected:'cadence'}),/differs from the recorded choice/);
  await assert.rejects(wrong.summary(),/유효하지 않은 입력 상태/);
});

test('pipeline replay handles disposed/rejected inputs and release callback failures from real ownership code',async()=>{
  const replay=new InputDecisionReplay(signal()),errors:unknown[]=[];let clock=0;
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:()=>new Promise(()=>{}),consume:assert.fail,
    release:input=>{if(input===1)throw Error('release failed');},onError:error=>errors.push(error),now:()=>clock++,
    onDecision:value=>replay.pipeline(value)});
  pipeline.offer(1,1);pipeline.offer(2,2);await pipeline.flush();pipeline.offer(3,3);
  const result=await replay.summary();assert.equal(errors.length,1);assert.equal(result.settled,true);
  assert.equal(result.pipeline.released,3);assert.equal(result.pipeline.started,0);
});

test('missing starts, duplicate releases, sequence gaps, capture changes and duplicate links fail explicitly',async()=>{
  const events=completedInput(1);
  for(const invalid of [
    [events[1]],
    [events[0],{...events[1],seq:3}],
    [events[0],{...events[1],captureTime:999}],
    [...events,{...events[3],seq:5,atMs:5}],
  ]){
    const replay=new InputDecisionReplay(signal());
    assert.throws(()=>invalid.forEach(event=>replay.pipeline(event)));
    await assert.rejects(replay.summary(),/유효하지 않은 입력 상태/);
  }
  const replay=new InputDecisionReplay(signal());replay.pipeline(events[0]);replay.pipeline(events[1]);
  const link={inputId:1,frameId:1,captureTime:0.1,phase:'input'};
  replay.link(link);assert.throws(()=>replay.link(link),/중복 입력 프레임/);
  const wrongTime=new InputDecisionReplay(signal());wrongTime.pipeline(events[0]);wrongTime.pipeline(events[1]);
  assert.throws(()=>wrongTime.link({...link,captureTime:0.2}),/시작되지 않은 입력/);
});

test('selection overflow poisons replay instead of quietly dropping a tail',async()=>{
  const replay=new InputDecisionReplay(signal(),1);completedInput(1).forEach(event=>replay.pipeline(event));
  const second=completedInput(2,5);replay.pipeline(second[0]);
  assert.throws(()=>replay.pipeline(second[1]),/재생 한도 초과/);
  await assert.rejects(replay.summary(),/유효하지 않은 입력 상태/);
});

test('legacy/missing checkpoints, later facts and outstanding ownership never claim a completed match',async()=>{
  const empty=await new InputDecisionReplay(signal()).summary();assert.equal(empty.supported,false);assert.equal(empty.hash,null);
  const checkpointOnly=new InputDecisionReplay(signal());checkpointOnly.checkpoint({complete:true,hash:'0'.repeat(64)});
  assert.equal((await checkpointOnly.summary()).matchesCapturedState,null);
  const replay=new InputDecisionReplay(signal());const events=completedInput(1);
  replay.pipeline(events[0]);const pending=await replay.summary();
  replay.checkpoint({complete:true,hash:pending.hash});assert.equal((await replay.summary()).matchesCapturedState,null);
  events.slice(1).forEach(event=>replay.pipeline(event));const settled=await replay.summary();
  assert.equal(settled.expectedHash,null);replay.checkpoint({complete:true,hash:settled.hash});
  assert.equal((await replay.summary()).matchesCapturedState,true);
  replay.checkpoint({complete:false,error:'recording lost'});assert.equal((await replay.summary()).matchesCapturedState,null);
  replay.checkpoint({complete:true,hash:settled.hash});replay.pipeline(completedInput(2,5)[0]);
  assert.equal((await replay.summary()).expectedHash,null);
});

test('strict checkpoint/link contracts and cancellation reject before publishing a summary',async()=>{
  for(const value of [{},[],{complete:true},{complete:false,hash:'0'.repeat(64)},
    {complete:true,hash:'A'.repeat(64)},{complete:false,error:'x'.repeat(2001)}])assert.throws(()=>parseInputCheckpoint(value));
  for(const value of [{inputId:1,frameId:0,captureTime:0,phase:'input'},
    {inputId:1,frameId:1,captureTime:NaN,phase:'input'},
    {inputId:1,frameId:1,captureTime:0,phase:'future'},
    {inputId:1,frameId:1,captureTime:0,phase:'input',image:'pixels'}])assert.throws(()=>parseInputFrameLink(value));
  const controller=new AbortController(),replay=new InputDecisionReplay(controller.signal);controller.abort();
  assert.throws(()=>replay.pipeline(completedInput(1)[0]),{name:'AbortError'});
  await assert.rejects(replay.summary(),{name:'AbortError'});
});

test('legacy v1 input checkpoint hashes remain byte-for-byte compatible',async()=>{
  const replay=new InputDecisionReplay(signal());
  completedInput(1).forEach(event=>replay.pipeline(event));
  assert.equal((await replay.summary()).hash,'850cf25cf8dd1e37c8e744e3c93a2e9b0d9c0ea0a5d240ad6d421b35482f0337');
  const ownership=new InputDecisionReplay(signal());
  for(let i=1;i<=3;i++)ownership.pipeline({...completedInput(i)[0],seq:i,atMs:i});
  assert.throws(()=>ownership.pipeline({...completedInput(4)[0],seq:4,atMs:4}),/초과 입력 소유권/);
});

function v2Stream(){
  let seq=0;
  const event=(inputId:number,kind:string,extra:Record<string,unknown>={})=>({
    version:2,seq:++seq,atMs:seq,inputId,captureTime:inputId/10,kind,...extra,
  });
  const offer=(inputId:number,extra:Record<string,unknown>={})=>event(inputId,'offered',{
    observedAtMs:inputId,selection:{rowStart:inputId*4,rowCount:4},estimatedBytes:10,maxPendingFrames:2,maxRetainedBytes:30,...extra,
  });
  const replace=(oldInputId:number,newInputId:number)=>({version:2,seq:++seq,atMs:seq,kind:'replaced',oldInputId,newInputId});
  return {event,offer,replace};
}

test('v2 retains two distinct representatives and permits the bounded incoming fourth ownership',async()=>{
  const replay=new InputDecisionReplay(signal()),facts:unknown[]=[],stream=v2Stream();
  const apply=(event:unknown)=>{replay.pipeline(event);facts.push(event);};
  apply(stream.offer(1));apply(stream.event(1,'started'));
  apply(stream.offer(2));apply(stream.offer(3));
  apply(stream.offer(4));apply(stream.replace(3,4));apply(stream.event(3,'released',{reason:'replaced',failed:false}));
  apply(stream.event(1,'finished',{outcome:'completed'}));apply(stream.event(1,'released',{reason:'normal',failed:false}));
  for(const inputId of [2,4]){
    apply(stream.event(inputId,'started'));apply(stream.event(inputId,'finished',{outcome:'completed'}));
    apply(stream.event(inputId,'released',{reason:'normal',failed:false}));
  }
  const captured=await replay.summary();assert.equal(captured.settled,true);assert.equal(captured.pipeline.started,3);
  assert.equal(captured.pipeline.offered,4);assert.equal(captured.pipeline.replaced,1);assert.equal(captured.pipeline.retained,0);
  const restored=new InputDecisionReplay(signal());facts.forEach(event=>restored.pipeline(event));
  restored.checkpoint({complete:true,hash:captured.hash});assert.equal((await restored.summary()).matchesCapturedState,true);
});

test('v2 rejects missing cleanup, changed config, FIFO violations and mixed pipeline versions',async()=>{
  const create=()=>({replay:new InputDecisionReplay(signal()),stream:v2Stream()});
  {
    const {replay,stream}=create();replay.pipeline(stream.offer(1));replay.pipeline(stream.offer(2));replay.pipeline(stream.offer(3));
    assert.throws(()=>replay.pipeline(stream.offer(4)),/정리 또는 메모리/);
  }
  {
    const {replay,stream}=create();replay.pipeline(stream.offer(1));
    assert.throws(()=>replay.pipeline(stream.offer(2,{maxRetainedBytes:31})),/설정 변경/);
  }
  {
    const {replay,stream}=create();replay.pipeline(stream.offer(1));replay.pipeline(stream.offer(2));
    assert.throws(()=>replay.pipeline(stream.event(2,'started')),/판독 순서/);
  }
  {
    const {replay,stream}=create();replay.pipeline(stream.offer(1));
    assert.throws(()=>replay.pipeline({...stream.event(1,'started'),version:1}),/버전 변경/);
  }
  {
    const {replay,stream}=create();replay.pipeline(stream.offer(1,{estimatedBytes:31}));
    assert.throws(()=>replay.pipeline(stream.event(1,'started')),/정리 또는 메모리/);
  }
});

test('v2 capacity rejects only the incoming frame and selected hints/source affect its checkpoint',async()=>{
  const replay=new InputDecisionReplay(signal()),stream=v2Stream();
  replay.pipeline(stream.offer(1,{estimatedBytes:40}));replay.pipeline(stream.event(1,'released',{reason:'capacity',failed:false}));
  assert.equal((await replay.summary()).settled,true);assert.equal((await replay.summary()).pipeline.started,0);
  const hash=async(extra:Record<string,unknown>)=>{
    const replay=new InputDecisionReplay(signal()),stream=v2Stream();replay.pipeline(stream.offer(1,extra));
    replay.pipeline(stream.event(1,'started'));replay.pipeline(stream.event(1,'finished',{outcome:'completed'}));
    replay.pipeline(stream.event(1,'released',{reason:'normal',failed:false}));return (await replay.summary()).hash;
  };
  const baseline=await hash({source:{mediaTime:3.5,frameTimestampUs:3_500_000}});
  assert.notEqual(await hash({source:{mediaTime:3.6,frameTimestampUs:3_500_000}}),baseline);
  assert.notEqual(await hash({source:{mediaTime:3.5,frameTimestampUs:3_500_000},selection:{rowStart:5,rowCount:4}}),baseline);
  const invalid=new InputDecisionReplay(signal()),bad=v2Stream();invalid.pipeline(bad.offer(1));invalid.pipeline(bad.offer(2));
  assert.throws(()=>invalid.pipeline(bad.event(1,'released',{reason:'capacity',failed:false})),/해제 상태/);
});

test('v2 joins a successful frozen admission and only enriches previously absent source metadata',async()=>{
  const seed=(source?:object)=>{
    const replay=new InputDecisionReplay(signal()),stamp={inputId:1,captureTime:0.1,observedAtMs:1,...(source?{source}:{})};
    replay.admission({kind:'consider',stamp,gates:{capturing:true,checkingCompletion:false},expected:'freeze'});
    replay.admission({kind:'frozen',stamp,succeeded:true,freezeMs:0});return replay;
  };
  const enriched=seed();enriched.pipeline(v2Stream().offer(1,{source:{frameTimestampUs:20}}));
  assert.equal((await enriched.summary()).pipeline.offered,1);
  const mismatch=seed({frameTimestampUs:20});
  assert.throws(()=>mismatch.pipeline(v2Stream().offer(1,{source:{frameTimestampUs:21}})),/복사 승인/);
  const missing=seed({frameTimestampUs:20});assert.throws(()=>missing.pipeline(v2Stream().offer(1)),/복사 승인/);
  const wrongTime=seed();assert.throws(()=>wrongTime.pipeline(v2Stream().offer(1,{observedAtMs:2})),/복사 승인/);
});

test('capacity deferrals and the later admitted v2 input replay to the same final checkpoint without invented jobs',async()=>{
  const live=new InputDecisionReplay(signal()),stream=v2Stream(),facts:{kind:'admission'|'pipeline'|'link';value:unknown}[]=[];
  const admission=(value:LiveInputAdmissionFact)=>{live.admission(value);facts.push({kind:'admission',value:structuredClone(value)});};
  const pipeline=(value:unknown)=>{live.pipeline(value);facts.push({kind:'pipeline',value});};
  const gates={capturing:true,checkingCompletion:false};
  for(const inputId of [1,2])admission({kind:'consider',stamp:{inputId,captureTime:inputId/10,observedAtMs:0},
    gates:{...gates,sourceCapacity:false},expected:'source-capacity'});
  const stamp={inputId:3,captureTime:.3,observedAtMs:0};
  admission({kind:'consider',stamp,gates:{...gates,sourceCapacity:true},expected:'freeze'});
  admission({kind:'frozen',stamp,succeeded:true,freezeMs:1});
  pipeline(stream.offer(3,{observedAtMs:0}));pipeline(stream.event(3,'started'));
  const link={inputId:3,frameId:100,captureTime:.3,phase:'input'};
  live.link(link);facts.push({kind:'link',value:link});
  admission({kind:'completed',startedAtMs:2,endedAtMs:3});
  pipeline(stream.event(3,'finished',{outcome:'completed'}));pipeline(stream.event(3,'released',{reason:'normal',failed:false}));
  const captured=await live.summary();
  assert.deepEqual(captured.admission,{supported:true,facts:5,considered:3,frozen:1,skipped:2,freezeFailed:0,completed:1});
  assert.deepEqual(captured.pipeline,{supported:true,decisions:4,offered:1,replaced:0,started:1,finished:1,released:1,linked:1,retained:0});
  assert.equal(captured.settled,true);
  const replay=new InputDecisionReplay(signal());
  for(const fact of JSON.parse(JSON.stringify(facts))){
    if(fact.kind==='admission')replay.admission(fact.value);else if(fact.kind==='pipeline')replay.pipeline(fact.value);else replay.link(fact.value);
  }
  replay.checkpoint({complete:true,hash:captured.hash});
  const restored=await replay.summary();assert.equal(restored.hash,captured.hash);assert.equal(restored.matchesCapturedState,true);
});

test('a source-capacity deferral cannot authorize a frozen result, v2 offer or acquisition link',async()=>{
  const stamp={inputId:1,captureTime:.1,observedAtMs:1},fact={kind:'consider',stamp,
    gates:{capturing:true,checkingCompletion:false,sourceCapacity:false},expected:'source-capacity'};
  const skipped=new InputDecisionReplay(signal());skipped.admission(fact);
  const summary=await skipped.summary();assert.equal(summary.settled,true);
  assert.equal(summary.admission.skipped,1);assert.equal(summary.admission.frozen,0);assert.equal(summary.pipeline.supported,false);
  for(const invent of [
    (replay:InputDecisionReplay)=>replay.admission({kind:'frozen',stamp,succeeded:true,freezeMs:0}),
    (replay:InputDecisionReplay)=>replay.pipeline(v2Stream().offer(1)),
    (replay:InputDecisionReplay)=>replay.link({inputId:1,frameId:1,captureTime:.1,phase:'input'}),
  ]){
    const replay=new InputDecisionReplay(signal());replay.admission(fact);assert.throws(()=>invent(replay));
    await assert.rejects(replay.summary(),/유효하지 않은 입력 상태/);
  }
  const wrong=new InputDecisionReplay(signal());assert.throws(()=>wrong.admission({...fact,expected:'freeze'}),/differs from the recorded choice/);
});
