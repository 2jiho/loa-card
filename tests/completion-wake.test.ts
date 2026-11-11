import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompletionWake} from '../src/features/card-scanner/session/completion-wake';

test('an idle boundary wakes the waiting reader once and coalesces repeated hints',async()=>{
  const wake=new CompletionWake(),controller=new AbortController();
  let finished=false;
  const waiting=wake.wait(controller.signal,1000).then(()=>{finished=true;});
  await Promise.resolve();
  assert.equal(finished,false);
  wake.request();wake.request();
  await waiting;
  assert.equal(finished,true);
  assert.equal(wake.consume(),true);
  assert.equal(wake.consume(),false);
  controller.abort();
});

test('a hint arriving while the reader is busy remains available without running another reader',async()=>{
  const wake=new CompletionWake(),signal=new AbortController().signal;
  let finishFirst!:()=>void;
  const work=new Promise<void>(resolve=>{finishFirst=resolve;});
  let checks=0,active=0,peak=0;
  const reader=(async()=>{
    for(let i=0;i<2;i++) {
      await wake.wait(signal,1000);
      assert.equal(wake.consume(),true);
      active++;peak=Math.max(peak,active);checks++;
      if(i===0)await work;
      active--;
    }
  })();
  wake.request();
  await Promise.resolve();
  assert.equal(checks,1);
  wake.request();wake.request();
  assert.equal(checks,1,'a hint does not itself run the check');
  finishFirst();await reader;
  assert.equal(checks,2);assert.equal(peak,1);
  assert.equal(wake.consume(),false);
});

test('abort rejects the waiter and leaves no registered listener or stale waiter',async()=>{
  const wake=new CompletionWake(),controller=new AbortController(),signal=controller.signal;
  let listeners=0;
  const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
  signal.addEventListener=((type: string,...args: Parameters<AbortSignal['addEventListener']> extends [string,...infer R]?R:never)=>{
    if(type==='abort')listeners++;return add(type,...args);
  }) as AbortSignal['addEventListener'];
  signal.removeEventListener=((type: string,...args: Parameters<AbortSignal['removeEventListener']> extends [string,...infer R]?R:never)=>{
    if(type==='abort')listeners--;return remove(type,...args);
  }) as AbortSignal['removeEventListener'];
  const waiting=wake.wait(signal,1000);
  assert.equal(listeners,1);
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(listeners,0);
  wake.request();
  assert.equal(wake.consume(),true);
  assert.throws(()=>wake.wait(signal));
});

test('timeout releases its waiter and a later wake is not lost',async()=>{
  const wake=new CompletionWake(),signal=new AbortController().signal;
  await wake.wait(signal,1);
  assert.equal(wake.consume(),false);
  wake.request();
  await wake.wait(signal,1000);
  assert.equal(wake.consume(),true);
  assert.equal(wake.consume(),false);
});
