import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderDispatches,ReaderWorkWake} from '../src/features/card-scanner/session/reader-work-wake';
import {LiveReaderSchedule,liveLanePlan} from '../src/features/card-scanner/session/live-scan-policy';
import {CandidateQueue} from '../src/features/card-scanner/acquisition/candidate-queue';
import {admitRetryCandidate} from '../src/features/card-scanner/session/retry-candidate';

test('an admitted capture wakes all idle readers without deciding which job they take',async()=>{
  const wake=new ReaderWorkWake(),signal=new AbortController().signal,version=wake.version;
  const waiting=Array.from({length:4},()=>wake.wait(signal,version,10_000));
  wake.request();
  await Promise.all(waiting);
  const plan=liveLanePlan(8),schedule=new LiveReaderSchedule();
  assert.equal(schedule.next(0,plan,{queued:1,short:0,full:0,live:true}),'fast');
  assert.equal(schedule.next(2,plan,{queued:1,short:0,full:0,live:true}),undefined);
  wake.dispose();
});

test('a retained retry wakes the appropriate lane and keeps short/full priority',async()=>{
  const wake=new ReaderWorkWake(),signal=new AbortController().signal;
  const waiting=wake.wait(signal,wake.version,10_000);
  wake.request();await waiting;
  const plan=liveLanePlan(8),jobs={queued:0,short:1,full:1,live:true};
  assert.equal(new LiveReaderSchedule().next(2,plan,jobs),'short');
  assert.equal(new LiveReaderSchedule().next(3,plan,jobs),'full');
  wake.dispose();
});

test('a notification between queue inspection and waiter registration is not lost',async()=>{
  const wake=new ReaderWorkWake(),signal=new AbortController().signal,seen=wake.version;
  wake.request();
  await wake.wait(signal,seen,10_000);
  wake.dispose();
});

test('abort rejects all waiters and already aborted signals reject immediately',async()=>{
  const wake=new ReaderWorkWake(),abort=new AbortController(),seen=wake.version;
  const waiting=[wake.wait(abort.signal,seen,10_000),wake.wait(abort.signal,seen,10_000)];
  abort.abort();
  for(const result of await Promise.allSettled(waiting))assert.equal(result.status,'rejected');
  assert.throws(()=>wake.wait(abort.signal,seen),{name:'AbortError'});
  wake.dispose();
});

test('dispose releases waiting readers and subsequent waits; requests after disposal do nothing',async()=>{
  const wake=new ReaderWorkWake(),signal=new AbortController().signal,seen=wake.version;
  const waiting=[wake.wait(signal,seen,10_000),wake.wait(signal,seen,10_000)];
  wake.dispose();await Promise.all(waiting);
  wake.request();assert.equal(wake.version,seen);
  await wake.wait(signal,seen,10_000);
});

test('a missed external lifecycle change still progresses via bounded polling fallback',async()=>{
  const wake=new ReaderWorkWake();
  await wake.wait(new AbortController().signal,wake.version,5);
  wake.dispose();
});

test('after capture ends an idle lane remains until an in-flight crop has queued and completed its retry',{timeout:2000},async()=>{
  const wake=new ReaderWorkWake(),signal=new AbortController().signal;
  const active=new ReaderDispatches(()=>wake.request()),plan=liveLanePlan(4);
  const candidate={group:1,order:7,stable:true,borderAlignment:1,needsIdentity:true,
    source:{sessionId:'session',frameId:1,observationId:'1',captureOrder:7,captureTime:1,phase:'input' as const,slot:0,frame:'1'}};
  const queue=new CandidateQueue<typeof candidate>(4,()=>{}),retries:typeof candidate[]=[];
  assert.equal(queue.pushDetailed(candidate),'queued');
  let allowCrop!:()=>void,started!:()=>void,retryTaken!:()=>void;
  const cropGate=new Promise<void>(resolve=>{allowCrop=resolve;});
  const cropStarted=new Promise<void>(resolve=>{started=resolve;});
  const retryObserved=new Promise<void>(resolve=>{retryTaken=resolve;});
  const results:{lane:number;order:number}[]=[];
  const run=async(index:number)=>{
    const schedule=new LiveReaderSchedule();
    while(queue.length||retries.length||active.active){
      const version=wake.version;
      const job=schedule.next(index,plan,{queued:queue.length,short:retries.length,full:0,live:false});
      if(!job){await wake.wait(signal,version,100);continue;}
      const finish=active.start();
      try{
        if(job==='fast'){
          const item=queue.shift();assert.ok(item);started();await cropGate;
          assert.equal(admitRetryCandidate(retries,item,4,()=>{}),'queued');wake.request();
          await retryObserved;
        }else{
          const item=retries.shift();assert.ok(item);results.push({lane:index,order:item.order});retryTaken();
        }
      }finally{finish();}
    }
  };
  const first=run(0),second=run(1);
  await cropStarted;
  assert.equal(active.active,1);
  allowCrop();await Promise.all([first,second]);
  assert.deepEqual(results,[{lane:1,order:7}]);
  assert.equal(active.active,0);assert.equal(retries.length,0);wake.dispose();
});

test('failed and cancelled dispatches settle once and wake an idle joining reader',{timeout:2000},async()=>{
  for(const cancelled of [false,true]){
    const wake=new ReaderWorkWake(),abort=new AbortController();
    const active=new ReaderDispatches(()=>wake.request());
    const finish=active.start(),seen=wake.version;
    const waiting=wake.wait(new AbortController().signal,seen,1000);
    const dispatch=(async()=>{try{
      if(cancelled){abort.abort();abort.signal.throwIfAborted();}
      throw Error('reader failed');
    }finally{finish();finish();}})();
    await assert.rejects(dispatch);await waiting;
    assert.equal(active.active,0);wake.dispose();
  }
});
