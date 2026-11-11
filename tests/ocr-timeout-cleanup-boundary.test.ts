import test from 'node:test';
import assert from 'node:assert/strict';
import {CardReadTimeout,isIncompleteCardRead} from '../src/features/card-scanner/recognition/card-read-budget';
import {awaitNonBudgetOcr} from '../src/features/card-scanner/recognition/ocr-nonbudget-timeout';
import {OcrLeasePool} from '../src/features/card-scanner/recognition/ocr-worker-leases';
import {guardScan,ScanStalledError} from '../src/features/card-scanner/ui/scan-watchdog';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';

const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

test('non-budget actual deadline returns unresolved, retires once, ignores late result',async()=>{
 const late=deferred<string>();let invalidated=0;
 await assert.rejects(awaitNonBudgetOcr(()=>late.promise,async()=>{invalidated++;},10),e=>e instanceof CardReadTimeout&&isIncompleteCardRead(e));
 assert.equal(invalidated,1);late.resolve('late');await tick();
 assert.equal(await awaitNonBudgetOcr(async()=> 'ok',async()=>{},50),'ok');
});

test('real pool pending operation: watchdog returns incomplete but actual settlement gates rescan until late work and disposal',async()=>{
 const late=deferred<string>(),started=deferred<void>(),disposed=deferred<void>();let released=0,disposeCalls=0,settled=false,returned=false;
 const pool=new OcrLeasePool(async()=>({}),async()=>{disposeCalls++;await disposed.promise;});
 const lease=await pool.acquire();const observed=lease.requestOwned(()=>({}),async()=>{started.resolve();return late.promise;},()=>{released++;});
 const observedResult=observed.then(()=>null,e=>e);await started.promise;const states:ScannerState[]=[];
 const ctrl=new AbortController();const limits={stall:200,cleanup:25,initialization:200,warning:10};
 const result=guardScan({signal:ctrl.signal,limits,intervalMs:5,update:s=>states.push(s),sharing:()=>false,cancelResources:()=>{},
  onRunSettled:()=>{settled=true;},run:async(_,publish,ready)=>{ready();publish({workPhase:'cleanup',cards:[],sampled:0,stable:0} as unknown as ScannerState);await pool.close();}})
  .finally(()=>{returned=true;});
 await assert.rejects(result,ScanStalledError);
 assert.equal(returned,true);assert.equal(settled,false);assert.equal(pool.stats.closed,true);assert.equal(released,0);
 assert.equal(disposeCalls,0);assert.throws(()=>pool.reserve(),/OCR 종료/);
 assert.equal(states.at(-1)?.interrupted,'stalled');assert.equal(states.at(-1)?.autoStopped,false);
 assert.ok(await observedResult instanceof Error);late.resolve('late');await tick();
 assert.equal(released,1);assert.equal(disposeCalls,1);assert.equal(settled,false);
 disposed.resolve();await tick();await tick();assert.equal(settled,true);
});


test('visible active read with an empty queue is not idle while sharing',async()=>{
 const controller=new AbortController(),settled=deferred<void>();let finish!:()=>void;
 const work=new Promise<void>(resolve=>{finish=resolve;});const states:ScannerState[]=[];
 const run=guardScan({signal:controller.signal,update:s=>states.push(s),sharing:()=>true,cancelResources:()=>{},onRunSettled:()=>settled.resolve(),
  limits:{stall:30,cleanup:40,initialization:100,warning:10},intervalMs:5,run:async(_,publish,ready)=>{
   ready();publish({workPhase:'capture',cards:[],queued:0,activeReadings:1,sampled:1,stable:1} as unknown as ScannerState);await work;
  }});
 await assert.rejects(run,ScanStalledError);assert.equal(states.at(-1)?.interrupted,'stalled');
 finish();await settled.promise;
});

test('sharing without queued or active reads remains idle beyond the progress deadline',async()=>{
 const controller=new AbortController(),started=deferred<void>(),done=deferred<void>();
 const run=guardScan({signal:controller.signal,update:()=>{},sharing:()=>true,cancelResources:()=>{},
  limits:{stall:20,cleanup:40,initialization:100,warning:10},intervalMs:5,run:async(_,publish,ready)=>{
   ready();publish({workPhase:'capture',cards:[],queued:0,activeReadings:0,sampled:1,stable:1} as unknown as ScannerState);started.resolve();await done.promise;
  }});
 await started.promise;await new Promise(resolve=>setTimeout(resolve,70));done.resolve();await run;
});
