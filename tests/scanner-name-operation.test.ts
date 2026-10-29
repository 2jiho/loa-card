import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {guardScan} from '../src/features/card-scanner/scan-watchdog';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../src/features/card-scanner/scanner-name-configuration';
import type {PreparedScanner} from '../src/features/card-scanner/scanner-preparation';
import type {ScannerState} from '../src/features/card-scanner/scanner';

const continued={version:1,rawResultPolicy:'continue'} as const;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const snapshot=():ScannerState=>({status:'준비',percent:0,sampled:0,stable:0,expected:null,capacity:null,cards:[],located:false,
  unreadable:0,queued:0,droppedFrames:0,unidentified:[]});
type Resource={kind:string;disposals:number;dispose():Promise<void>;ready():Promise<void>};
let sequence=0;

/** Real preparation ownership/claim/release code, with model-free resource
 * factories. Real guardScan drives cancellation and actual-settlement timing. */
async function fixture(work:(value:{create:typeof import('../src/features/card-scanner/scanner-name-operation').createScannerNameOperation;
  prepare:()=>Promise<PreparedScanner>;preparation:typeof import('../src/features/card-scanner/scanner-preparation');
  state:{resources:Resource[];signals:AbortSignal[];cleanupGate:ReturnType<typeof deferred>|null;cleanupFailure:string|null;finished:number}})=>Promise<void>){
  const id=++sequence,key=`__scannerNameOperation${id}`,globals=globalThis as unknown as Record<string,unknown>;
  const previousNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const state={resources:[] as Resource[],signals:[] as AbortSignal[],cleanupGate:null as ReturnType<typeof deferred>|null,cleanupFailure:null as string|null,finished:0};
  const resource=(kind:string)=>{
    const value:Resource={kind,disposals:0,async dispose(){
      value.disposals++;
      try{if(state.cleanupGate)await state.cleanupGate.promise;if(state.cleanupFailure===kind)throw Error(`dispose ${kind}`);}
      finally{state.finished++;}
    },async ready(){}};
    state.resources.push(value);return value;
  };
  globals[key]={detector:async()=>resource('detector'),recognizer:async(_status:unknown,signal:AbortSignal)=>{
    state.signals.push(signal);return resource('reader');},acquisition:(signal:AbortSignal)=>{
    state.signals.push(signal);return resource('acquisition');},visual:(signal:AbortSignal)=>{
    state.signals.push(signal);return resource('visual');}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{hardwareConcurrency:1}});
  const operationUrl=new URL(`../src/features/card-scanner/scanner-name-operation.ts?operation-test=${id}`,import.meta.url).href;
  const preparationUrl=new URL(`../src/features/card-scanner/scanner-preparation.ts?operation-test=${id}`,import.meta.url).href;
  const dependencies:Record<string,string>={'./detector':'detector','./recognizer':'recognizer','./acquisition-client':'acquisition','./visual-client':'visual'};
  const names:Record<string,string>={detector:'createDetector',recognizer:'createRecognizer',acquisition:'createAcquisitionClient',visual:'createVisualClient'};
  const hooks=registerHooks({resolve(specifier,context,next){
    if(context.parentURL===operationUrl&&specifier==='./scanner-preparation')return {url:preparationUrl,shortCircuit:true};
    if(context.parentURL===preparationUrl&&dependencies[specifier])return {url:`scanner-operation-fake:${id}:${dependencies[specifier]}`,shortCircuit:true};
    return next(specifier,context);
  },load(url,context,next){
    const prefix=`scanner-operation-fake:${id}:`;
    if(url.startsWith(prefix)){const kind=url.slice(prefix.length);return {format:'module',shortCircuit:true,
      source:`export function ${names[kind]}(...args){return globalThis[${JSON.stringify(key)}][${JSON.stringify(kind)}](...args);}`};}
    return next(url,context);
  }});
  const pools:PreparedScanner[]=[];
  let preparation:typeof import('../src/features/card-scanner/scanner-preparation')|undefined;
  try{
    const operation=await import(operationUrl);preparation=await import(preparationUrl);const owned=preparation;
    await work({create:operation.createScannerNameOperation,preparation:owned,state,prepare:async()=>{
      const pool=await owned.prepareScanner(()=>{},new AbortController().signal);pools.push(pool);return pool;
    }});
  }finally{
    state.cleanupGate?.resolve();
    if(preparation)await Promise.allSettled(pools.map(pool=>preparation!.disposePreparedScanner(pool)));
    hooks.deregister();delete globals[key];
    if(previousNavigator)Object.defineProperty(globalThis,'navigator',previousNavigator);else Reflect.deleteProperty(globalThis,'navigator');
  }
}

test('normal effective configuration and claimed resources settle once after captured cleanup',async()=>{
  await fixture(async({create,prepare,state})=>{
    const pool=await prepare(),order:string[]=[];
    const operation=create({prepared:pool,development:false,input:{},run:async(_signal,configuration,claimed)=>{
      assert.deepEqual(configuration,NORMAL_SCANNER_NAME_CONFIGURATION);assert.equal(Object.isFrozen(configuration),true);
      assert.notEqual(claimed,pool);assert.equal(claimed?.detector,pool.detector);order.push('run');
    },onSettled:()=>{assert.equal(state.finished,state.resources.length);order.push('settled');}});
    await guardScan({signal:new AbortController().signal,update:()=>{},sharing:()=>false,
      run:signal=>operation.run(signal),cancelResources:operation.cancel,onRunSettled:operation.settled});
    operation.settled();await turn();order.push('returned');
    assert.deepEqual(order,['run','settled','returned']);assert.ok(state.resources.every(resource=>resource.disposals===1));
  });
});

test('an initial publish/update exception before an inner cleanup block still releases the claimed pool',async()=>{
  await fixture(async({create,prepare,state})=>{
    const pool=await prepare(),primary=Error('initial update failed');let publish!:(value:ScannerState)=>void,updates=0,settled=0;
    const operation=create({prepared:pool,development:false,input:{},run:async()=>{publish(snapshot());},onSettled:()=>{settled++;}});
    await assert.rejects(guardScan({signal:new AbortController().signal,sharing:()=>false,
      update:()=>{if(updates++===0)throw primary;},run:(signal,next)=>{publish=next;return operation.run(signal);},
      cancelResources:operation.cancel,onRunSettled:operation.settled}),error=>error===primary);
    await turn();assert.equal(settled,1);assert.ok(state.resources.every(resource=>resource.disposals===1));
  });
});

test('configuration mismatch and invalid configuration dispose only the unclaimed preparation and never enter the runner',async()=>{
  await fixture(async({create,prepare,state})=>{
    for(const configuration of [continued,{version:99,rawResultPolicy:'resample'}]){
      const before=state.resources.length,pool=await prepare();let runs=0,settled=0;
      const operation=create({prepared:pool,configuration,development:false,input:{},run:async()=>{runs++;},onSettled:()=>{settled++;}});
      await assert.rejects(guardScan({signal:new AbortController().signal,update:()=>{},sharing:()=>false,
        run:signal=>operation.run(signal),cancelResources:operation.cancel,onRunSettled:operation.settled}));
      await turn();assert.equal(runs,0);assert.equal(settled,1);
      assert.ok(state.resources.slice(before).every(resource=>resource.disposals===1));
    }
  });
});

test('a competing rejected claim and a pre-aborted competing caller leave the active owner untouched',async()=>{
  await fixture(async({create,prepare,state})=>{
    const pool=await prepare(),entered=deferred(),finish=deferred();
    const first=create({prepared:pool,development:false,input:{},run:async()=>{entered.resolve();await finish.promise;}});
    const active=guardScan({signal:new AbortController().signal,update:()=>{},sharing:()=>false,
      run:signal=>first.run(signal),cancelResources:first.cancel,onRunSettled:first.settled});
    await entered.promise;
    for(const signal of [new AbortController().signal,AbortSignal.abort()]){
      const competing=create({prepared:pool,development:false,input:{},run:async()=>assert.fail('competing run started')});
      await assert.rejects(guardScan({signal,update:()=>{},sharing:()=>false,run:guardSignal=>competing.run(guardSignal),
        cancelResources:competing.cancel,onRunSettled:competing.settled}));
      assert.ok(state.resources.every(resource=>resource.disposals===0));assert.ok(state.signals.every(value=>!value.aborted));
    }
    finish.resolve();await active;assert.ok(state.resources.every(resource=>resource.disposals===1));
  });
});

test('pre-abort returns promptly while unclaimed cleanup is pending and notifies only after cleanup settles',async()=>{
  await fixture(async({create,prepare,state})=>{
    const pool=await prepare(),gate=deferred();state.cleanupGate=gate;let runs=0,settled=0;
    const operation=create({prepared:pool,development:false,input:{},run:async()=>{runs++;},onSettled:()=>{settled++;}});
    await assert.rejects(guardScan({signal:AbortSignal.abort(),update:()=>{},sharing:()=>false,
      run:signal=>operation.run(signal),cancelResources:operation.cancel,onRunSettled:operation.settled}),{name:'AbortError'});
    assert.equal(runs,0);assert.equal(settled,0);assert.equal(state.finished,0);
    operation.cancel();operation.settled();gate.resolve();await turn();
    assert.equal(settled,1);assert.equal(state.finished,state.resources.length);assert.ok(state.resources.every(resource=>resource.disposals===1));
  });
});

test('cancellation never frees active transferred resources, and late cleanup fences even an early settlement request',async()=>{
  await fixture(async({create,prepare,state})=>{
    const pool=await prepare(),entered=deferred(),finish=deferred(),cleanup=deferred(),controller=new AbortController();let settled=0;
    const operation=create({prepared:pool,development:false,input:{},run:async()=>{entered.resolve();await finish.promise;},onSettled:()=>{settled++;}});
    const active=guardScan({signal:controller.signal,update:()=>{},sharing:()=>false,
      run:signal=>operation.run(signal),cancelResources:operation.cancel,onRunSettled:operation.settled});
    await entered.promise;controller.abort();await assert.rejects(active,{name:'AbortError'});
    assert.ok(state.signals.every(value=>value.aborted));assert.ok(state.resources.every(resource=>resource.disposals===0));
    operation.settled();state.cleanupGate=cleanup;finish.resolve();await turn();
    assert.equal(settled,0);assert.equal(state.finished,0);assert.ok(state.resources.every(resource=>resource.disposals===1));
    cleanup.resolve();await turn();assert.equal(settled,1);assert.equal(state.finished,state.resources.length);
  });
});

test('primary failure survives a failed joined cleanup and observers cannot replace it',async()=>{
  await fixture(async({create,prepare,state})=>{
    const pool=await prepare(),primary=Error('primary recognition failed'),diagnostics:unknown[]=[];let settled=0;
    state.cleanupFailure='reader';
    const operation=create({prepared:pool,development:false,input:{},run:async()=>{throw primary;},
      diagnostic:error=>{diagnostics.push(error);throw Error('diagnostic observer');},onSettled:()=>{settled++;throw Error('settlement observer');}});
    await assert.rejects(guardScan({signal:new AbortController().signal,update:()=>{},sharing:()=>false,
      run:signal=>operation.run(signal),cancelResources:operation.cancel,onRunSettled:operation.settled}),error=>error===primary);
    await turn();assert.equal(settled,1);assert.equal(diagnostics.length,1);assert.ok(diagnostics[0] instanceof AggregateError);
    assert.equal(state.finished,state.resources.length);assert.ok(state.resources.every(resource=>resource.disposals===1));
  });
});

test('pre-abort cleanup rejection is observed and still releases settlement without an unhandled rejection',async()=>{
  await fixture(async({create,prepare,state})=>{
    const pool=await prepare();state.cleanupFailure='detector';let diagnostics=0,settled=0;
    const operation=create({prepared:pool,development:false,input:{},run:async()=>assert.fail('started'),
      diagnostic:async()=>{diagnostics++;throw Error('asynchronous diagnostic observer');},
      onSettled:async()=>{settled++;throw Error('asynchronous settlement observer');}});
    await assert.rejects(guardScan({signal:AbortSignal.abort(),update:()=>{},sharing:()=>false,
      run:signal=>operation.run(signal),cancelResources:operation.cancel,onRunSettled:operation.settled}),{name:'AbortError'});
    await turn();assert.equal(diagnostics,1);assert.equal(settled,1);assert.equal(state.finished,state.resources.length);
  });
});

test('a successful operation reports a cleanup failure and cannot be invoked again',async()=>{
  await fixture(async({create,prepare,state})=>{
    const pool=await prepare();state.cleanupFailure='detector';let runs=0;
    const operation=create({prepared:pool,development:false,input:{},run:async()=>{runs++;}});
    await assert.rejects(operation.run(new AbortController().signal),AggregateError);
    await assert.rejects(operation.run(new AbortController().signal),/한 번/);
    operation.settled();await turn();assert.equal(runs,1);assert.ok(state.resources.every(resource=>resource.disposals===1));
  });
});

test('DEV policy resolution and independent-input rejection happen before the runner or ownership transfer',async()=>{
  await fixture(async({create,prepare,state})=>{
    let actual:unknown;
    const allowed=create({legacyDevPolicy:'continue',development:true,input:{},run:async(_signal,configuration)=>{actual=configuration;}});
    await allowed.run(new AbortController().signal);allowed.settled();assert.deepEqual(actual,continued);
    const pool=await prepare();let runs=0;
    const blocked=create({prepared:pool,configuration:continued,development:false,input:{comparisonInput:true},run:async()=>{runs++;}});
    await assert.rejects(blocked.run(new AbortController().signal),/다른 입력 실험/);
    blocked.settled();await turn();assert.equal(runs,0);assert.ok(state.resources.every(resource=>resource.disposals===1));
  });
});
