import test from 'node:test';
import assert from 'node:assert/strict';
import {runRecoveryPipeline} from '../src/features/card-scanner/recovery-pipeline';

function deferred<T=void>() {
  let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function* frames(...values:number[]){yield* values;}

test('ordered collection continues while an earlier card is still being read',async()=>{
  const held=deferred(),queue:number[]=[],collected:number[]=[],read:number[]=[];
  const done=runRecoveryPipeline(frames(1,2,3),new AbortController().signal,{
    lanes:1,pending:()=>queue.length,
    collect:async frame=>{collected.push(frame);queue.push(frame);},
    consume:async lane=>{assert.equal(lane,0);const card=queue.shift();if(card===undefined)return false;read.push(card);if(card===1)await held.promise;return true;},
  });
  await turn();assert.deepEqual(collected,[1,2,3]);assert.deepEqual(read,[1]);
  held.resolve();await done;assert.deepEqual(read,[1,2,3]);
});

test('backpressure bounds queued work to the watermark plus one collected frame',async()=>{
  const held=deferred(),queue:number[]=[],collected:number[]=[];let peak=0,first=true,count=0;
  const done=runRecoveryPipeline(frames(1,2,3,4,5,6),new AbortController().signal,{
    lanes:1,pending:()=>queue.length,
    collect:async frame=>{collected.push(frame);queue.push(...Array<number>(40).fill(frame));peak=Math.max(peak,queue.length);},
    consume:async()=>{if(!queue.length)return false;queue.shift();count++;if(first){first=false;await held.promise;}return true;},
  });
  await turn();assert.equal(collected.length,3);assert.equal(queue.length,119);
  held.resolve();await done;assert.equal(count,240);assert.ok(peak<=119);assert.deepEqual(collected,[1,2,3,4,5,6]);
});

test('independent lanes drain retries enqueued by the final in-flight card',async()=>{
  const held=deferred(),queue:{stage:number}[]=[],seen:number[]=[];let active=0,peak=0;
  const done=runRecoveryPipeline(frames(1),new AbortController().signal,{
    lanes:3,pending:()=>queue.length,collect:async()=>{queue.push({stage:0},{stage:0});},
    consume:async()=>{const item=queue.shift();if(!item)return false;active++;peak=Math.max(peak,active);seen.push(item.stage);
      if(item.stage===0){await held.promise;queue.push({stage:1});}active--;return true;},
  });
  await turn();assert.equal(peak,2);held.resolve();await done;
  assert.deepEqual(seen,[0,0,1,1]);assert.equal(active,0);assert.equal(queue.length,0);
});

test('a lane with no eligible jobs sleeps until another lane produces its retry',async()=>{
  const held=deferred(),queue:number[]=[];let emptyCalls=0;
  const done=runRecoveryPipeline(frames(1),new AbortController().signal,{
    lanes:2,pending:()=>queue.length,collect:async()=>{queue.push(0,0);},
    consume:async lane=>{const index=queue.findIndex(value=>value===lane);if(index<0){emptyCalls++;return false;}
      queue.splice(index,1);if(lane===0){await held.promise;queue.push(1);}return true;},
  });
  await turn();const before=emptyCalls;await turn();assert.equal(emptyCalls,before);
  held.resolve();await done;assert.equal(queue.length,0);
});

test('collection failure closes the iterator and joins in-flight reads before preserving the first error',async()=>{
  const held=deferred(),queue:number[]=[],failure=new Error('collect failed');let closed=false,settled=false;
  async function* source(){try{yield 1;yield 2;yield 3;}finally{closed=true;}}
  const done=runRecoveryPipeline(source(),new AbortController().signal,{
    lanes:1,pending:()=>queue.length,
    collect:async frame=>{if(frame===2)throw failure;queue.push(frame);},
    consume:async()=>{if(!queue.length)return false;queue.shift();await held.promise;return true;},
  });
  const caught=done.catch(error=>{settled=true;assert.equal(error,failure);});
  await turn();assert.equal(closed,true);assert.equal(settled,false);held.resolve();await caught;
});

test('reader failure stops new work and waits for other readers and an active collection',async()=>{
  const reading=deferred(),collecting=deferred(),failed=deferred(),failure=new Error('reader failed');
  const queue:number[]=[],seen:number[]=[],collected:number[]=[];let closed=false,settled=false;
  async function* source(){try{yield 1;yield 2;yield 3;}finally{closed=true;}}
  const done=runRecoveryPipeline(source(),new AbortController().signal,{
    lanes:2,pending:()=>queue.length,
    collect:async frame=>{collected.push(frame);if(frame===1)queue.push(1,2);else await collecting.promise;},
    consume:async()=>{const item=queue.shift();if(item===undefined)return false;seen.push(item);if(item===1)await failed.promise;else await reading.promise;return true;},
  });
  const caught=done.catch(error=>{settled=true;assert.equal(error,failure);});
  await turn();failed.reject(failure);await turn();assert.equal(settled,false);
  reading.resolve();await turn();assert.equal(settled,false);collecting.resolve();await caught;
  assert.equal(closed,true);assert.deepEqual(seen,[1,2]);assert.deepEqual(collected,[1,2]);
});

test('abort wakes backpressure and joins an active read without starting queued work',async()=>{
  const held=deferred(),controller=new AbortController(),reason=new Error('stop'),queue:number[]=[],seen:number[]=[];
  let closed=false,settled=false;
  async function* source(){try{yield 1;yield 2;yield 3;yield 4;}finally{closed=true;}}
  const done=runRecoveryPipeline(source(),controller.signal,{
    lanes:1,highWaterMark:1,pending:()=>queue.length,collect:async frame=>{queue.push(frame);},
    consume:async()=>{const item=queue.shift();if(item===undefined)return false;seen.push(item);await held.promise;return true;},
  });
  const caught=done.catch(error=>{settled=true;assert.equal(error,reason);});
  await turn();controller.abort(reason);await turn();assert.equal(closed,true);assert.equal(settled,false);
  held.resolve();await caught;assert.deepEqual(seen,[1]);assert.equal(queue.length,1);
});

test('unserviceable final work fails explicitly instead of polling or waiting forever',async()=>{
  let pending=0,calls=0;
  await assert.rejects(runRecoveryPipeline(frames(1),new AbortController().signal,{
    lanes:2,pending:()=>pending,collect:async()=>{pending=1;},consume:async()=>{calls++;return false;},
  }),/no reader can consume/);
  assert.ok(calls<=4);
});

test('pre-aborted input starts no iterator, collection or reader',async()=>{
  const controller=new AbortController(),reason=new Error('already stopped');controller.abort(reason);
  await assert.rejects(runRecoveryPipeline({[Symbol.asyncIterator](){assert.fail('iterator must not start');}},controller.signal,{
    lanes:1,pending:()=>0,collect:async()=>assert.fail('collection must not start'),consume:async()=>{assert.fail('reader must not start');},
  }),error=>error===reason);
});

test('abort during iterator input joins the pending next and closes its resource before rejecting',async()=>{
  const next=deferred<IteratorResult<number>>(),controller=new AbortController(),reason=new Error('stop input');
  let closed=false,settled=false;
  const source:AsyncIterable<number>={[Symbol.asyncIterator]:()=>({next:()=>next.promise,return:async()=>{closed=true;return {done:true,value:undefined};}})};
  const done=runRecoveryPipeline(source,controller.signal,{
    lanes:1,pending:()=>0,collect:async()=>assert.fail('late frame must not be collected'),consume:async()=>false,
  });
  const caught=done.catch(error=>{settled=true;assert.equal(error,reason);});
  await turn();controller.abort(reason);await turn();assert.equal(settled,false);assert.equal(closed,false);
  next.resolve({done:false,value:1});await caught;assert.equal(closed,true);
});

test('iterator failure joins an active reader and preserves the input error over cleanup errors',async()=>{
  const held=deferred(),queue:number[]=[],failure=new Error('input failed'),cleanupError=new Error('cleanup failed');
  let next=0,closed=false,settled=false;
  const source:AsyncIterable<number>={[Symbol.asyncIterator]:()=>({
    next:async()=>{if(next++)throw failure;return {done:false,value:1};},
    return:async()=>{closed=true;throw cleanupError;},
  })};
  const done=runRecoveryPipeline(source,new AbortController().signal,{
    lanes:1,pending:()=>queue.length,collect:async value=>{queue.push(value);},
    consume:async()=>{if(!queue.length)return false;queue.shift();await held.promise;return true;},
  });
  const caught=done.catch(error=>{settled=true;assert.equal(error,failure);});
  await turn();assert.equal(closed,true);assert.equal(settled,false);held.resolve();await caught;
});

test('queued work is rechecked after a delayed input finishes decoding',async()=>{
  const next=deferred(),held=deferred(),queue:number[]=[];let collected=0,first=true;
  async function* source(){yield 1;await next.promise;yield 2;}
  const done=runRecoveryPipeline(source(),new AbortController().signal,{
    lanes:1,highWaterMark:2,pending:()=>queue.length,
    collect:async value=>{collected++;queue.push(value);},
    consume:async()=>{if(!queue.length)return false;queue.shift();if(first){first=false;await held.promise;}return true;},
  });
  await turn();queue.push(3,4);next.resolve();await turn();assert.equal(collected,1);
  held.resolve();await done;assert.equal(collected,2);assert.equal(queue.length,0);
});
