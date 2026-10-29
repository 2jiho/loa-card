import test from 'node:test';
import assert from 'node:assert/strict';
import {entryParts} from '../src/features/card-scanner/exact-recording-codec';
import {inspectExactPrefix} from '../src/features/card-scanner/exact-recording-prefix';
const signal=()=>new AbortController().signal;
const event=(seq:number)=>new Blob(entryParts({kind:'event',seq,time:seq,type:'fact',value:{}}));
const frame=(id:number,key:boolean)=>new Blob(entryParts({kind:'frame',id,time:id,width:2,height:2,key,
  hash:'a'.repeat(64),codec:'lz4',xor:true},new Uint8Array([1,2,3])));
test('interrupted entry is trimmed at its original byte boundary without reading whole media',async()=>{
  const first=frame(1,true),second=event(1),tail=frame(2,false);
  const blob=new Blob([first,second,tail.slice(0,tail.size-1)]);
  blob.arrayBuffer=()=>{throw Error('whole archive read');};
  const result=await inspectExactPrefix(blob,signal());
  assert.equal(result.bytes,first.size+second.size);assert.equal(result.frames,1);assert.equal(result.events,1);
  assert.equal(result.complete,false);assert.ok(result.error);
  assert.deepEqual(await result.blob.arrayBuffer(),await new Blob([first,second]).arrayBuffer());
});
test('complete structure, event-only, partial first key and absent dependency remain distinguishable',async()=>{
  const good=await inspectExactPrefix(new Blob([frame(1,true),event(1),frame(2,false)]),signal());
  assert.equal(good.complete,true);assert.equal(good.frames,2);
  const facts=await inspectExactPrefix(event(1),signal());assert.equal(facts.complete,true);assert.equal(facts.frames,0);
  for(const blob of [frame(1,true).slice(0,-1),frame(2,false)]) {
    const result=await inspectExactPrefix(blob,signal());assert.equal(result.bytes,0);assert.equal(result.complete,false);
  }
});
test('invalid following sequence preserves a prefix but cannot be advertised complete',async()=>{
  const result=await inspectExactPrefix(new Blob([event(2),event(1)]),signal());
  assert.equal(result.bytes,event(2).size);assert.equal(result.events,1);assert.equal(result.complete,false);
  const abort=new AbortController();abort.abort();await assert.rejects(inspectExactPrefix(event(1),abort.signal),{name:'AbortError'});
});
