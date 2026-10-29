import test from 'node:test';
import assert from 'node:assert/strict';
import {CancellableOperation} from '../src/features/card-scanner/cancellable-operation';

test('diagnostic deadline aborts the work and returns even if browser IO ignores cancellation',async()=>{
 const task=new CancellableOperation(10,'진단 시간 초과');
 await assert.rejects(task.run(()=>new Promise(()=>{})),/진단 시간 초과/);
 assert.equal(task.signal.aborted,true);task.dispose();
});
test('closing or replacing diagnostics invalidates and cancels a task before late results arrive',async()=>{
 const first=new CancellableOperation(1000,'timeout');let resolve:(v:number)=>void=()=>{};
 const wait=first.run(()=>new Promise<number>(done=>{resolve=done;}));
 first.dispose();assert.equal(first.current,false);
 await assert.rejects(wait,/작업을 중지/);resolve(123);
 const next=new CancellableOperation(1000,'timeout');assert.equal(await next.run(async()=>456),456);
 assert.equal(next.current,true);next.dispose();
});
test('manual cancellation retains task ownership long enough to show a cancellation result',async()=>{
 const task=new CancellableOperation(1000,'timeout');const wait=task.run(()=>new Promise(()=>{}));
 task.cancel();await assert.rejects(wait,/작업을 중지/);assert.equal(task.current,true);task.dispose();
});
