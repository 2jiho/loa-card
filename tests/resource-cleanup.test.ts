import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initializeOwnedResource,onceDisposer,settleDisposals} from '../src/features/card-scanner/resource-cleanup';

function deferred<T=void>(){
  let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const turn=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};

test('independent cleanup starts every action after sync failure and joins deferred work before reporting errors',async()=>{
  const held=deferred(),syncError=new Error('detector cleanup'),asyncError=new Error('primary reader cleanup');
  const started:string[]=[];let settled=false;
  const work=settleDisposals([
    ()=>{started.push('detector');throw syncError;},
    ()=>{started.push('primary');return Promise.reject(asyncError);},
    async()=>{started.push('extra');await held.promise;started.push('extra finished');},
    ()=>{started.push('last');},
  ]).then(errors=>{settled=true;return errors;});
  assert.deepEqual(started,['detector','primary','extra','last']);
  await turn();assert.equal(settled,false,'a rejected primary must not let pending extra cleanup escape');
  held.resolve();assert.deepEqual(await work,[syncError,asyncError]);
  assert.deepEqual(started,['detector','primary','extra','last','extra finished']);
});

test('empty cleanup succeeds and undefined thrown values remain visible failures',async()=>{
  assert.deepEqual(await settleDisposals([]),[]);
  assert.deepEqual(await settleDisposals([()=>{throw undefined;}]),[undefined]);
});

test('one owned object shares one pending termination promise while other resources terminate independently',async()=>{
  const held=deferred(),first={},second={};let terminations=0;
  const dispose=onceDisposer((value:object)=>{terminations++;return value===first?held.promise:undefined;});
  const a=dispose(first),b=dispose(first),other=dispose(second);
  assert.equal(a,b);assert.notEqual(a,other);assert.equal(terminations,2);
  let firstFinished=false;void a.then(()=>{firstFinished=true;});
  await other;assert.equal(firstFinished,false);
  held.resolve();await a;assert.equal(dispose(first),a);assert.equal(terminations,2);
});

test('reentrant termination sees the already published ownership promise',async()=>{
  const resource={};let calls=0,reentrant:Promise<void>|undefined;
  const dispose=onceDisposer((value:object)=>{calls++;reentrant=dispose(value);});
  const original=dispose(resource);
  assert.equal(reentrant,original);assert.equal(calls,1);
  await original;assert.equal(dispose(resource),original);assert.equal(calls,1);
});

test('synchronous termination failure is one shared rejection without retrying the same object',async()=>{
  const resource={},failure=new Error('terminate failed');let calls=0;
  const dispose=onceDisposer(()=>{calls++;throw failure;});
  const first=dispose(resource),second=dispose(resource);
  assert.equal(first,second);await assert.rejects(first,error=>error===failure);
  assert.equal(dispose(resource),first);assert.equal(calls,1);
});

test('successful owned initialization publishes only after setup and retains ownership for its caller',async()=>{
  const resource={},setup=deferred();let disposals=0,finished=false;
  const initialized=initializeOwnedResource(async()=>resource,()=>setup.promise,()=>{disposals++;},{isClosed:()=>false});
  void initialized.then(()=>{finished=true;});await turn();assert.equal(finished,false);
  setup.resolve();assert.equal(await initialized,resource);assert.equal(disposals,0);
});

test('setup failure awaits termination and preserves the original failure identity',async()=>{
  const resource={},cleanup=deferred(),failure=new Error('setParameters failed');
  let terminated=0,observed=false,reported:unknown;
  const initialized=initializeOwnedResource(async()=>resource,()=>{throw failure;},value=>{
    assert.equal(value,resource);terminated++;return cleanup.promise;
  },{isClosed:()=>false});
  const outcome=initialized.then(()=>assert.fail('failed setup cannot publish a resource'),error=>{observed=true;reported=error;});
  await turn();assert.equal(terminated,1);assert.equal(observed,false);
  cleanup.resolve();await outcome;assert.equal(reported,failure);
});

test('cleanup failure is observable while a throwing error observer cannot mask setup failure',async()=>{
  const failure=new Error('setup failed'),cleanupFailure=new Error('terminate failed');
  const observed:unknown[]=[];
  const initialized=initializeOwnedResource(async()=>({}),()=>{throw failure;},()=>{throw cleanupFailure;},{
    isClosed:()=>false,onCleanupError:error=>{observed.push(error);throw new Error('observer failed');},
  });
  await assert.rejects(initialized,error=>error===failure);assert.deepEqual(observed,[cleanupFailure]);
});

test('owner closure while creation is pending skips setup and releases the late object exactly once',async()=>{
  const creation=deferred<object>(),resource={},closedError=new Error('owner closed');
  let closed=false,setups=0,disposals=0;
  const terminate=onceDisposer(()=>{disposals++;});
  const initialized=initializeOwnedResource(()=>creation.promise,()=>{setups++;},terminate,{
    isClosed:()=>closed,closedError:()=>closedError,
  });
  closed=true;creation.resolve(resource);
  await assert.rejects(initialized,error=>error===closedError);
  await terminate(resource);assert.equal(setups,0);assert.equal(disposals,1);
});

test('owner closure during setup waits for setup to settle and then joins disposal before rejecting',async()=>{
  const setup=deferred(),cleanup=deferred(),resource={},closedError=new Error('closed during setup');
  let closed=false,started=false,disposed=false,settled=false;
  const initialized=initializeOwnedResource(async()=>resource,()=>{started=true;return setup.promise;},()=>{
    disposed=true;return cleanup.promise;
  },{isClosed:()=>closed,closedError:()=>closedError});
  const observed=initialized.then(()=>assert.fail('closed owner cannot receive resource'),error=>{settled=true;assert.equal(error,closedError);});
  await turn();assert.equal(started,true);closed=true;assert.equal(disposed,false);
  setup.resolve();await turn();assert.equal(disposed,true);assert.equal(settled,false);
  cleanup.resolve();await observed;
});

test('rejected creation has no allocated resource to configure or terminate',async()=>{
  const failure=new Error('createWorker failed');let setups=0,disposals=0,reports=0;
  const initialized=initializeOwnedResource(()=>Promise.reject(failure),()=>{setups++;},()=>{disposals++;},{
    isClosed:()=>false,onCleanupError:()=>{reports++;},
  });
  await assert.rejects(initialized,error=>error===failure);
  assert.equal(setups,0);assert.equal(disposals,0);assert.equal(reports,0);
});

test('setup failure, invalidation and final cleanup can share one termination attempt',async()=>{
  const resource={},setup=deferred(),cleanup=deferred(),failure=new Error('configuration rejected');let calls=0;
  const terminate=onceDisposer(()=>{calls++;return cleanup.promise;});
  const initialized=initializeOwnedResource(async()=>resource,()=>setup.promise,terminate,{isClosed:()=>false});
  const outcome=assert.rejects(initialized,error=>error===failure);
  await turn();const invalidated=terminate(resource);setup.reject(failure);await turn();
  assert.equal(calls,1);assert.equal(terminate(resource),invalidated);
  cleanup.resolve();await Promise.all([invalidated,outcome]);assert.equal(calls,1);
});
