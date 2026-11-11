import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RunStateTrace,parseRunStateTrace,replayRunStateTrace,replaySourceUseFromFrame,summarizeReplaySourceUses} from '../dev/run-state-trace';

const runId='12345678-1234-1234-1234-123456789abc';
const frame=()=>({frame:9,sourceFrameId:9,time:3.7474,phase:'recovery',layout:null,
  provenance:{frameId:9,sourceFrameId:23,captureTime:3.7474,phase:'recovery',phaseInferred:false,pixelHash:'a'.repeat(64)}});
const signal=()=>new AbortController().signal;

test('stored input source metadata survives a report trace without becoming scanner evidence',async()=>{
  const input=frame(),source=replaySourceUseFromFrame(input,runId);
  const trace=new RunStateTrace();assert.equal(trace.record('replay-source-use',source,1),true);
  input.provenance.sourceFrameId=99;
  const blob=await trace.snapshotBlob(),parsed=await parseRunStateTrace(blob,signal());
  assert.equal(parsed.complete,true);assert.equal(parsed.dropped,0);
  assert.deepEqual(parsed.events[0],{seq:1,time:1,type:'replay-source-use',value:{version:1,runId,
    processingFrame:9,acquisitionFrameId:9,sourceFrameId:23,captureTime:3.7474,phase:'recovery',phaseInferred:false,pixelHash:'a'.repeat(64)}});
  const replay=await replayRunStateTrace(blob,signal()),empty=await replayRunStateTrace(await new RunStateTrace().snapshotBlob(),signal());
  for(const key of ['grid','observations','inventory','input','unknownLifecycle','freshness','obstruction'] as const)
    assert.deepEqual(replay[key],empty[key]);
});

test('missing, mismatched or malformed frame provenance is never invented',async()=>{
  const cases:unknown[]=[{...frame(),provenance:undefined},{...frame(),sourceFrameId:10},{...frame(),time:3.8},
    {...frame(),phase:'input'},{...frame(),provenance:{...frame().provenance,pixelHash:'bad'}}];
  for(const value of cases)assert.throws(()=>replaySourceUseFromFrame(value,runId));
  const legacy=frame();delete (legacy.provenance as {sourceFrameId?:number}).sourceFrameId;
  assert.equal(replaySourceUseFromFrame(legacy,runId).sourceFrameId,null);
  const trace=new RunStateTrace();assert.equal(trace.record('replay-source-use',null,1),false);
  const parsed=await parseRunStateTrace(await trace.snapshotBlob(),signal());
  assert.equal(parsed.complete,false);assert.equal(parsed.dropped,1);assert.equal(parsed.events.length,0);
});

test('scope distinguishes independent runs and duplicate source frames are not independent observations',()=>{
  const a=replaySourceUseFromFrame(frame(),runId),b=replaySourceUseFromFrame(frame(),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.notEqual(a.runId,b.runId);assert.equal(a.pixelHash,b.pixelHash);
  assert.throws(()=>replaySourceUseFromFrame(frame(),'other-session'));
});

test('metadata join refuses missing, partial, mismatched, and mixed-session reports',()=>{
  const use={seq:1,time:1,type:'replay-source-use',value:replaySourceUseFromFrame(frame(),runId)};
  const capture={seq:2,time:2,type:'acquisition-capture',value:{sessionId:'s1',processingFrame:9,
    acquisitionFrameId:9,captureTime:3.7474,phase:'recovery'}};
  const trace={version:2,complete:true,dropped:0,events:[use,capture]};
  const valid=summarizeReplaySourceUses(trace as never,runId);
  assert.equal(valid.status,'matched-metadata');assert.equal(valid.readerPixelsVerified,false);
  assert.equal(valid.originalCaptureComplete,null);assert.equal(valid.matchedFrames,1);
  for(const [overrides,reason] of [
    [{complete:false},'partial-trace'],[{dropped:1},'partial-trace'],[{events:[capture]},'missing-events'],
    [{events:[{...use,value:{...use.value,runId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}},capture]},'different-run'],
    [{events:[use,capture,{...capture,seq:3,value:{...capture.value,sessionId:'s2'}}]},'mixed-sessions'],
    [{events:[use,{...use,seq:2},capture]},'duplicate-frame'],
    [{events:[{...use,value:{...use.value,sourceFrameId:null}},capture]},'source-frame-unavailable'],
    [{events:[use,{...capture,value:{...capture.value,captureTime:3.8}}]},'capture-source-unmatched'],
    [{events:[{...use,seq:3},capture]},'capture-source-unmatched'],
  ] as const){
    const result=summarizeReplaySourceUses({...trace,...overrides} as never,runId);
    assert.equal(result.status,'unknown');if(result.status==='unknown')assert.equal(result.reason,reason);
  }
});

test('repeated archive pixel source IDs require the same hash and inferred phases remain explicit',()=>{
  const input=frame();
  const one=replaySourceUseFromFrame(input,runId);
  const use1={seq:1,time:1,type:'replay-source-use',value:one};
  const cap1={seq:2,time:2,type:'acquisition-capture',value:{sessionId:'s1',processingFrame:9,
    acquisitionFrameId:9,captureTime:3.7474,phase:'recovery',canonicalSourceFrameId:751}};
  const use2={seq:3,time:3,type:'replay-source-use',value:{...one,processingFrame:10,
    acquisitionFrameId:10,captureTime:3.8,phase:'input',phaseInferred:true}};
  const cap2={seq:4,time:4,type:'acquisition-capture',value:{...cap1.value,processingFrame:10,
    acquisitionFrameId:10,captureTime:3.8,phase:'input',canonicalSourceFrameId:752}};
  const noCapture={seq:5,time:5,type:'replay-source-use',value:{...one,processingFrame:11,
    acquisitionFrameId:11,sourceFrameId:24}};
  const trace={version:2,complete:true,dropped:0,events:[use1,cap1,use2,cap2,noCapture]};
  const valid=summarizeReplaySourceUses(trace as never,runId);
  assert.equal(valid.status,'matched-metadata');
  if(valid.status==='matched-metadata'){
    assert.equal(valid.matchedFrames,2);assert.equal(valid.inferredPhaseFrames,1);
    assert.equal(valid.unmatchedSourceFrames,1);
    assert.deepEqual(valid.unmatchedSourceDetail,{status:'unknown',reason:'missing-scroll-capture',notLocatedFrames:null,otherStateFrames:null});
    assert.equal(valid.notLocatedProvesNoCards,false);
    assert.equal(valid.canonicalSourceLink,'unverified-separate-id-domain');
  }
  const inconsistent={...trace,events:[use1,cap1,{...use2,value:{...use2.value,pixelHash:'b'.repeat(64)}},cap2,noCapture]};
  const conflict=summarizeReplaySourceUses(inconsistent as never,runId);
  assert.equal(conflict.status,'unknown');
  if(conflict.status==='unknown')assert.equal(conflict.reason,'source-pixel-hash-conflict');
});

test('unmatched acquisition frames require same-run scroll evidence for a not-located count',()=>{
  const use={seq:1,time:1,type:'replay-source-use',value:replaySourceUseFromFrame(frame(),runId)};
  const capture={seq:2,time:2,type:'acquisition-capture',value:{sessionId:'s1',processingFrame:9,
    acquisitionFrameId:9,captureTime:3.7474,phase:'recovery'}};
  const unmatchedUse={...use,seq:3,value:{...use.value,processingFrame:10,acquisitionFrameId:10,
    sourceFrameId:24,captureTime:3.8,phase:'input'}};
  const scroll={seq:4,time:4,type:'scroll-capture',value:{state:'not-located',source:{sessionId:'s1',
    processingFrame:10,acquisitionFrameId:10,captureTime:3.8,phase:'input'}}};
  const trace={version:2,complete:true,dropped:0,events:[use,capture,unmatchedUse,scroll]};
  const valid=summarizeReplaySourceUses(trace as never,runId);
  assert.equal(valid.status,'matched-metadata');
  if(valid.status==='matched-metadata'){
    assert.deepEqual(valid.unmatchedSourceDetail,{status:'matched',notLocatedFrames:1,otherStateFrames:0});
    assert.equal(valid.notLocatedProvesNoCards,false);
  }
  for(const [events,reason] of [
    [[use,capture,unmatchedUse], 'missing-scroll-capture'],
    [[use,capture,unmatchedUse,scroll,{...scroll,seq:5}], 'duplicate-scroll-capture'],
    [[use,capture,unmatchedUse,{...scroll,seq:2}], 'scroll-source-unmatched'],
    [[use,capture,unmatchedUse,{...scroll,value:{...scroll.value,source:{...scroll.value.source,sessionId:'s2'}}}], 'scroll-source-unmatched'],
    [[use,capture,unmatchedUse,{...scroll,value:{...scroll.value,source:{...scroll.value.source,captureTime:4}}}], 'scroll-source-unmatched'],
  ] as const){
    const actual=summarizeReplaySourceUses({...trace,events} as never,runId);
    assert.equal(actual.status,'matched-metadata');
    if(actual.status==='matched-metadata')assert.deepEqual(actual.unmatchedSourceDetail,
      {status:'unknown',reason,notLocatedFrames:null,otherStateFrames:null});
  }
  const other=summarizeReplaySourceUses({...trace,events:[use,capture,unmatchedUse,
    {...scroll,value:{...scroll.value,state:'unreadable'}}]} as never,runId);
  if(other.status!=='matched-metadata')assert.fail('matching source metadata must remain available');
  assert.deepEqual(other.unmatchedSourceDetail,{status:'matched',notLocatedFrames:0,otherStateFrames:1});
});
