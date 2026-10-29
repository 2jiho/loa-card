import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../src/features/card-scanner/scanner-name-configuration';
import type {PreparedScanner} from '../src/features/card-scanner/scanner-preparation';

const continued={version:1,rawResultPolicy:'continue'} as const;
type Resource={kind:string;disposals:number;dispose():Promise<void>;ready():Promise<void>};
let fixtureId=0;
async function matchingFixture(run:(fixture:{preparation:typeof import('../src/features/card-scanner/scanner-preparation');
  takeMatching:typeof import('../src/features/card-scanner/matching-scanner-preparation').takeMatchingPreparedScanner;
  prepare:typeof import('../src/features/card-scanner/scanner-preparation').prepareScanner;
  state:{resources:Resource[];onDispose:((kind:string)=>void)|null;block:((kind:string)=>Promise<void>)|null;failure:Error|null}})=>Promise<void>){
  const id=++fixtureId,bridgeKey=`__loaCardMatchingPreparation${id}`;
  const globals=globalThis as unknown as Record<string,unknown>,navigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const state={resources:[] as Resource[],onDispose:null as ((kind:string)=>void)|null,
    block:null as ((kind:string)=>Promise<void>)|null,failure:null as Error|null};
  const resource=(kind:string):Resource=>{
    const result:Resource={kind,disposals:0,async ready(){},async dispose(){
      result.disposals++;state.onDispose?.(kind);await state.block?.(kind);
      if(kind==='detector'&&state.failure)throw state.failure;
    }};state.resources.push(result);return result;
  };
  globals[bridgeKey]={detector:async()=>resource('detector'),recognizer:async()=>resource('reader'),
    acquisition:()=>resource('acquisition'),visual:()=>undefined};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{hardwareConcurrency:1}});
  const preparationUrl=new URL(`../src/features/card-scanner/scanner-preparation.ts?test=matching-${id}`,import.meta.url).href;
  const helperUrl=new URL(`../src/features/card-scanner/matching-scanner-preparation.ts?test=matching-${id}`,import.meta.url).href;
  const dependencies:Record<string,string>={'./detector':'detector','./recognizer':'recognizer','./acquisition-client':'acquisition','./visual-client':'visual'};
  const exports:Record<string,string>={detector:'createDetector',recognizer:'createRecognizer',acquisition:'createAcquisitionClient',visual:'createVisualClient'};
  const hooks=registerHooks({
    resolve(specifier,context,nextResolve){
      if(context.parentURL===helperUrl&&specifier==='./scanner-preparation')return {url:preparationUrl,shortCircuit:true};
      if(context.parentURL===preparationUrl&&dependencies[specifier])return {url:`loacard-matching-preparation:${id}:${dependencies[specifier]}`,shortCircuit:true};
      return nextResolve(specifier,context);
    },
    load(url,context,nextLoad){
      const prefix=`loacard-matching-preparation:${id}:`;
      if(url.startsWith(prefix)){const kind=url.slice(prefix.length);return {format:'module',shortCircuit:true,
        source:`export function ${exports[kind]}(...args){return globalThis[${JSON.stringify(bridgeKey)}][${JSON.stringify(kind)}](...args);}`};}
      return nextLoad(url,context);
    },
  });
  let preparation:typeof import('../src/features/card-scanner/scanner-preparation')|undefined;
  const pools:PreparedScanner[]=[];
  try{
    preparation=await import(preparationUrl);const owned=preparation;
    const helper=await import(helperUrl) as typeof import('../src/features/card-scanner/matching-scanner-preparation');
    const prepare:typeof owned.prepareScanner=async(...args)=>{const pool=await owned.prepareScanner(...args);pools.push(pool);return pool;};
    await run({preparation:owned,takeMatching:helper.takeMatchingPreparedScanner,prepare,state});
  }finally{
    if(preparation)await Promise.allSettled(pools.map(pool=>preparation!.disposePreparedScanner(pool)));
    hooks.deregister();delete globals[bridgeKey];
    if(navigator)Object.defineProperty(globalThis,'navigator',navigator);else Reflect.deleteProperty(globalThis,'navigator');
  }
}

test('matching registered pools are returned unchanged without disposal or claiming their ownership',async()=>{
  for(const configuration of [NORMAL_SCANNER_NAME_CONFIGURATION,continued])await matchingFixture(async({prepare,preparation,takeMatching,state})=>{
    const pool=await prepare(()=>{},new AbortController().signal,configuration);let takes=0;
    const result=await takeMatching(()=>{takes++;return pool;},configuration);
    assert.equal(result,pool);assert.equal(takes,1);assert.ok(state.resources.every(value=>value.disposals===0));
    assert.ok(preparation.claimPreparedScanner(result,configuration),'the scanner, rather than the slot helper, still owns the transfer');
  });
});

test('mismatched registered pools finish teardown before a cold fallback can begin',async()=>{
  await matchingFixture(async({prepare,takeMatching,state})=>{
    const pool=await prepare(()=>{},new AbortController().signal);let began!:()=>void,release!:()=>void,cold=false;
    const started=new Promise<void>(resolve=>{began=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    state.onDispose=kind=>{if(kind==='detector')began();};state.block=async kind=>{if(kind==='detector')await gate;};
    const operation=takeMatching(()=>pool,continued).then(result=>{cold=true;return result;});
    try{
      await started;await Promise.resolve();assert.equal(cold,false);assert.ok(state.resources.every(value=>value.disposals===1));
      release();assert.equal(await operation,undefined);assert.equal(cold,true);
    }finally{release();}
  });
});

test('a trusted old HMR handle is disposed without inspecting its obsolete resource shape',async()=>{
  await matchingFixture(async({takeMatching})=>{
    let reads=0,disposals=0,release!:()=>void,finished=false;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const old={get readers(){reads++;throw Error('obsolete resources must not be inspected');},dispose:async()=>{disposals++;await gate;}} as unknown as PreparedScanner;
    const operation=takeMatching(()=>old,continued).then(result=>{finished=true;return result;});
    try{
      await Promise.resolve();assert.equal(disposals,1);assert.equal(finished,false);assert.equal(reads,0);
      release();assert.equal(await operation,undefined);assert.equal(finished,true);assert.equal(reads,0);
    }finally{release();}
  });
});

test('cleanup rejection propagates and never authorizes an overlapping cold fallback',async()=>{
  await matchingFixture(async({prepare,takeMatching,state})=>{
    const pool=await prepare(()=>{},new AbortController().signal);state.failure=Error('detector teardown failed');let cold=false;
    const operation=takeMatching(()=>pool,continued).then(result=>{cold=true;return result;});
    await assert.rejects(operation,AggregateError);assert.equal(cold,false);
    assert.ok(state.resources.every(value=>value.disposals===1));
  });
});

test('invalid configuration is rejected before consuming the App-owned slot',async()=>{
  await matchingFixture(async({takeMatching,state})=>{
    let takes=0,reads=0;const configuration={version:1,get rawResultPolicy(){reads++;throw Error('getter');}};
    await assert.rejects(takeMatching(()=>{takes++;throw Error('must not take slot');},configuration as never),TypeError);
    await assert.rejects(takeMatching(()=>{takes++;return undefined;},{version:99} as never),TypeError);
    assert.equal(takes,0);assert.equal(reads,0);assert.equal(state.resources.length,0);
  });
});

test('an empty slot returns no preparation without allocating or disposing resources',async()=>{
  await matchingFixture(async({takeMatching,state})=>{
    let takes=0;assert.equal(await takeMatching(()=>{takes++;return undefined;},continued),undefined);
    assert.equal(takes,1);assert.equal(state.resources.length,0);
  });
});

test('the requested configuration is snapshotted before taking a slot with caller side effects',async()=>{
  await matchingFixture(async({prepare,takeMatching,state})=>{
    const pool=await prepare(()=>{},new AbortController().signal,continued);
    const configuration={version:1,rawResultPolicy:'continue'} as {version:1;rawResultPolicy:'resample'|'continue'};
    const result=await takeMatching(()=>{configuration.rawResultPolicy='resample';return pool;},configuration);
    assert.equal(result,pool);assert.equal(configuration.rawResultPolicy,'resample');
    assert.ok(state.resources.every(value=>value.disposals===0));
  });
});
