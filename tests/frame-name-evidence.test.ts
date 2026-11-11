import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrameNameEvidence,replayFrameNameEvidence,hashFrameNameEvidence,type FrameNameFact} from '../src/features/card-scanner/recognition/frame-name-evidence';

function source(frameId:number,slot:number){return {sessionId:'s',frameId,slot,observationId:`${frameId}-${slot}`,
  captureOrder:frameId*100+slot,captureTime:frameId,phase:'input' as const};}
function frame(frameId:number):FrameNameFact {
  return {version:1,kind:'frame',sessionId:'s',frameId,processingFrame:frameId,cells:Array.from({length:40},(_,slot)=>
    slot<2?{group:slot,source:source(frameId,slot)}:null)};
}
function name(frameId:number,slot:number,id='card'){
  return {version:1,kind:'name-confirmed',source:{...source(frameId,slot),frame:`frame-${frameId}`},id};
}
test('joins exact source only and replay is deterministic in either event order',()=>{
  const a=new FrameNameEvidence('s');a.capture(frame(1));a.inventory(name(1,0));
  const b=new FrameNameEvidence('s');b.inventory(name(1,0));b.capture(frame(1));
  assert.deepEqual(a.snapshot(),b.snapshot());
  assert.equal(a.snapshot().frames[0].cells[0]?.name,'card');
  assert.equal(a.snapshot().frames[0].cells[1]?.name,null);
  assert.equal(a.snapshot().sortFilterEpoch,'unknown');
  assert.deepEqual(replayFrameNameEvidence('s',[{kind:'frame',value:frame(1)},{kind:'inventory',value:name(1,0)}]),a.snapshot());
});
test('name confirmation never transfers to another group or frame',()=>{
  const state=new FrameNameEvidence('s');state.capture(frame(1));state.capture(frame(2));state.inventory(name(1,0));
  assert.equal(state.snapshot().frames[1].cells[0]?.name,null);
  assert.equal(state.snapshot().frames[0].cells[1]?.name,null);
});
test('distinct processing frames may refer to the same source frame',()=>{
  const state=new FrameNameEvidence('s'),first=frame(1);state.capture(first);
  const again:FrameNameFact={...first,processingFrame:2,cells:first.cells.map(cell=>cell?{...cell,
    source:{...cell.source,observationId:`second-${cell.source.observationId}`}}:null)};
  state.capture(again);assert.equal(state.snapshot().frames.length,2);
  assert.equal(state.snapshot().frames[1].frameId,1);
});
test('conflicting names are withheld permanently',()=>{
  const state=new FrameNameEvidence('s');state.capture(frame(1));state.inventory(name(1,0,'a'));state.inventory(name(1,0,'b'));state.inventory(name(1,0,'a'));
  assert.equal(state.snapshot().frames[0].cells[0]?.name,null);assert.equal(state.snapshot().frames[0].cells[0]?.conflict,true);
});
test('rejects wrong session, source mismatch and sparse or out-of-place cells',()=>{
  const state=new FrameNameEvidence('s');state.capture(frame(1));
  assert.throws(()=>state.inventory({...name(1,0),source:{...name(1,0).source,slot:1}}),/source mismatch/);
  assert.throws(()=>state.capture({...frame(2),sessionId:'other'}),/frame/);
  const f=frame(2);(f.cells as unknown[])[0]={group:1,source:{...source(2,0),slot:9}};
  assert.throws(()=>state.capture(f),/source/);
  const sparse=frame(3);delete (sparse.cells as unknown[])[0];assert.throws(()=>state.capture(sparse),/sparse/);
});
test('bounds are explicit and never claim complete history after eviction',()=>{
  const state=new FrameNameEvidence('s',{frames:1,pending:1});state.capture(frame(1));state.capture(frame(2));
  assert.equal(state.snapshot().complete,false);assert.equal(state.snapshot().frames.length,1);
  const pending=new FrameNameEvidence('s',{frames:1,pending:1});pending.inventory(name(1,0));pending.inventory(name(2,0));
  assert.equal(pending.snapshot().complete,false);assert.equal(pending.snapshot().pending.length,1);
});
test('only a complete diagnostic projection yields a deterministic checksum',async()=>{
  const a=new FrameNameEvidence('s');a.capture(frame(1));a.inventory(name(1,0));
  const b=new FrameNameEvidence('s');b.capture(frame(1));b.inventory(name(1,0));
  assert.equal(await hashFrameNameEvidence(a.snapshot()),await hashFrameNameEvidence(b.snapshot()));
  const limited=new FrameNameEvidence('s',{frames:1,pending:1});limited.capture(frame(1));limited.capture(frame(2));
  assert.equal(await hashFrameNameEvidence(limited.snapshot()),null);
});
