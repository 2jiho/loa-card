import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CardReadBudget,CardReadInterrupted,CardReadTimeout,isIncompleteCardRead} from '../src/features/card-scanner/recognition/card-read-budget';
import {acquireBudgetedOcrWorker,OcrLeasePool,OcrResourceUnavailable} from '../src/features/card-scanner/recognition/ocr-worker-leases';

const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

async function occupied(){
 const work=deferred<void>(),started=deferred<void>(),disposed=deferred<void>();let creates=0;
 const pool=new OcrLeasePool(async()=>({id:++creates}),async()=>{await disposed.promise;},1);
 const lease=await pool.acquire();
 const active=lease.request(async()=>{started.resolve();await work.promise;return 'late';});
 const rejected=active.then(()=>null,error=>error);await started.promise;
 const retired=lease.invalidate().catch(()=>{});
 assert.ok(await rejected instanceof CardReadInterrupted);
 return {pool,work,disposed,retired,get creates(){return creates;}};
}

test('budgeted wait resumes only after outstanding work and worker disposal finish',async()=>{
 const h=await occupied();const waiting=acquireBudgetedOcrWorker(h.pool,new CardReadBudget(1000),undefined,()=>{});
 assert.equal(h.pool.stats.capacityWaiters,1);assert.equal(h.creates,1);
 h.work.resolve();await tick();assert.equal(h.creates,1,'settled OCR is not finished cleanup');
 h.disposed.resolve();const lease=await waiting;assert.equal(h.creates,2);
 assert.equal(await lease.request(worker=>worker.id),2);
 assert.equal(h.pool.stats.capacityWaiters,0);await h.retired;await h.pool.close();
});

test('exhausted budget cancels the capacity waiter without creating a late worker',async()=>{
 const h=await occupied(),budget=new CardReadBudget(20);
 await assert.rejects(acquireBudgetedOcrWorker(h.pool,budget,undefined,()=>{}),error=>
  error instanceof CardReadTimeout&&budget.ownsTimeout(error)&&isIncompleteCardRead(error));
 assert.equal(h.pool.stats.capacityWaiters,0);assert.equal(h.creates,1);
 h.work.resolve();h.disposed.resolve();await h.retired;await tick();
 assert.equal(h.creates,1,'retirement after timeout cannot start a new attempt');await h.pool.close();
});

test('two waiters recheck capacity and share a new generation without exceeding the limit',async()=>{
 const h=await occupied();
 const a=acquireBudgetedOcrWorker(h.pool,new CardReadBudget(1000),undefined,()=>{});
 const b=acquireBudgetedOcrWorker(h.pool,new CardReadBudget(1000),undefined,()=>{});
 assert.equal(h.pool.stats.capacityWaiters,2);h.work.resolve();h.disposed.resolve();
 const [first,second]=await Promise.all([a,b]);assert.equal(h.creates,2);
 assert.deepEqual(await Promise.all([first.request(w=>w.id),second.request(w=>w.id)]),[2,2]);
 assert.equal(h.pool.stats.capacityWaiters,0);await h.retired;await h.pool.close();
});

test('abort, closure and cleanup failure wake capacity waiters without creating workers',async()=>{
 for(const reason of ['abort','close','cleanup'] as const){
  const h=await occupied(),signal=new AbortController();
  const pending=acquireBudgetedOcrWorker(h.pool,new CardReadBudget(1000),signal.signal,()=>{});
  const observed=pending.then(()=>null,error=>error);
  let closing:Promise<void>|undefined;
  if(reason==='abort')signal.abort(new Error('cancelled'));
  if(reason==='close')closing=h.pool.close();
  if(reason==='cleanup')h.pool.reportCleanupFailure(new Error('dispose failed'));
  const error=await observed;
  if(reason==='abort')assert.match(String(error),/cancelled/);
  if(reason==='close')assert.match(String(error),/OCR 종료/);
  if(reason==='cleanup')assert.ok(error instanceof OcrResourceUnavailable&&error.reason==='cleanup');
  assert.equal(h.pool.stats.capacityWaiters,0);assert.equal(h.creates,1);
  h.work.resolve();h.disposed.resolve();await h.retired;
  if(closing)await closing;else if(reason==='cleanup')await assert.rejects(h.pool.close(),AggregateError);else await h.pool.close();
 }
});

test('metadata without a card budget retains fail-fast capacity behavior',async()=>{
 const h=await occupied();
 await assert.rejects(acquireBudgetedOcrWorker(h.pool,undefined,undefined,()=>{}),error=>
  error instanceof OcrResourceUnavailable&&error.reason==='capacity');
 assert.equal(h.pool.stats.capacityWaiters,0);h.work.resolve();h.disposed.resolve();await h.retired;await h.pool.close();
});
