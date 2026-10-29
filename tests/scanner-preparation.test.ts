import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../src/features/card-scanner/scanner-name-configuration';
import type {PreparedScanner} from '../src/features/card-scanner/scanner-preparation';

const continued={version:1,rawResultPolicy:'continue'} as const;

test('contrast-enabled preparation passes the option to every reader and rejects a default claim',async()=>{
 await fakePreparation(async({prepare,module,state})=>{
  const configuration={version:1,rawResultPolicy:'resample',contrastNameFallback:true} as const;
  const pool=await prepare(()=>{},new AbortController().signal,configuration);
  assert.ok(state.options.length>0);
  assert.ok(state.options.every(option=>JSON.stringify(option)===JSON.stringify({nameRawResultPolicy:'resample',contrastNameFallback:true})));
  assert.throws(()=>module.claimPreparedScanner(pool,NORMAL_SCANNER_NAME_CONFIGURATION),/일치/);
  assert.ok(module.claimPreparedScanner(pool,configuration));
 });
});
type Resource={kind:string;disposals:number;dispose():Promise<void>;ready():Promise<void>};
let fixtureId=0;
async function fakePreparation(run:(fixture:{module:typeof import('../src/features/card-scanner/scanner-preparation');
  prepare:typeof import('../src/features/card-scanner/scanner-preparation').prepareScanner;
  state:{resources:Resource[];options:{nameRawResultPolicy:string}[];signals:AbortSignal[];readerFailure:number;
    acquisitionFailure:boolean;disposeFailure:string|null;visualUnavailable:boolean;detectorGate:Promise<void>|null}})=>Promise<void>,cores=8){
  const id=++fixtureId,bridgeKey=`__loaCardPrepareTest${id}`;
  const globals=globalThis as unknown as Record<string,unknown>,navigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const state={resources:[] as Resource[],options:[] as {nameRawResultPolicy:string}[],signals:[] as AbortSignal[],readerFailure:0,
    acquisitionFailure:false,disposeFailure:null as string|null,visualUnavailable:false,detectorGate:null as Promise<void>|null};
  const resource=(kind:string):Resource=>{
    const result:Resource={kind,disposals:0,async dispose(){result.disposals++;if(state.disposeFailure===kind)throw Error('cleanup '+kind);},
      async ready(){if(kind==='acquisition'&&state.acquisitionFailure)throw Error('acquisition setup failed');}};
    state.resources.push(result);return result;
  };
  globals[bridgeKey]={
    async detector(){const result=resource('detector');if(state.detectorGate)await state.detectorGate;return result;},
    async recognizer(_status:unknown,signal:AbortSignal,options:{nameRawResultPolicy:string}){
      state.options.push({...options});state.signals.push(signal);
      if(state.readerFailure===state.options.length)throw Error('reader setup failed');return resource('reader-'+state.options.length);
    },
    acquisition(signal:AbortSignal){state.signals.push(signal);return resource('acquisition');},
    visual(signal:AbortSignal){state.signals.push(signal);return state.visualUnavailable?undefined:resource('visual');},
  };
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{hardwareConcurrency:cores}});
  const moduleUrl=new URL(`../src/features/card-scanner/scanner-preparation.ts?test=ownership-${id}`,import.meta.url).href;
  const dependencies:Record<string,string>={'./detector':'detector','./recognizer':'recognizer','./acquisition-client':'acquisition','./visual-client':'visual'};
  const exports:Record<string,string>={detector:'createDetector',recognizer:'createRecognizer',acquisition:'createAcquisitionClient',visual:'createVisualClient'};
  const hooks=registerHooks({
    resolve(specifier,context,nextResolve){
      if(context.parentURL===moduleUrl&&dependencies[specifier])return {url:`loacard-prepare-test:${id}:${dependencies[specifier]}`,shortCircuit:true};
      return nextResolve(specifier,context);
    },
    load(url,context,nextLoad){
      const prefix=`loacard-prepare-test:${id}:`;
      if(url.startsWith(prefix)){const kind=url.slice(prefix.length);return {format:'module',shortCircuit:true,
        source:`export function ${exports[kind]}(...args){return globalThis[${JSON.stringify(bridgeKey)}][${JSON.stringify(kind)}](...args);}`};}
      return nextLoad(url,context);
    },
  });
  let module:typeof import('../src/features/card-scanner/scanner-preparation')|undefined;
  const pools:PreparedScanner[]=[];
  try{
    module=await import(moduleUrl);
    const owned=module;
    const prepare:typeof owned.prepareScanner=async(...args)=>{const pool=await owned.prepareScanner(...args);pools.push(pool);return pool;};
    await run({module:owned,prepare,state});
  }finally{
    if(module)await Promise.allSettled(pools.map(pool=>module!.disposePreparedScanner(pool)));
    hooks.deregister();delete globals[bridgeKey];
    if(navigator)Object.defineProperty(globalThis,'navigator',navigator);else Reflect.deleteProperty(globalThis,'navigator');
  }
}

for(const [cores,readers,visuals] of [[1,1,1],[4,2,1],[8,4,2]])test(`prepared ${cores}-core lanes all use one snapshotted configuration`,async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    let release!:()=>void;state.detectorGate=new Promise<void>(resolve=>{release=resolve;});
    const input={version:1,rawResultPolicy:'continue'} as {version:1;rawResultPolicy:'resample'|'continue'};
    const preparing=prepare(()=>{},new AbortController().signal,input);input.rawResultPolicy='resample';release();
    const pool=await preparing;
    assert.equal(pool.readers.length,readers);assert.equal(pool.visuals.length,visuals);
    assert.deepEqual(state.options,Array.from({length:readers},()=>({nameRawResultPolicy:'continue'})));
    const configuration=module.preparedScannerConfiguration(pool);assert.deepEqual(configuration,continued);assert.ok(Object.isFrozen(configuration));
    assert.notEqual(configuration,input);await module.disposePreparedScanner(pool);
    assert.ok(state.resources.every(value=>value.disposals===1));
  },cores);
});

test('ordinary preparation keeps the normal policy and invalid or pre-aborted input creates no resource',async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    let reads=0;const invalid={version:1,get rawResultPolicy(){reads++;throw Error('getter');}};
    await assert.rejects(prepare(()=>{},new AbortController().signal,invalid as never),TypeError);
    const aborted=new AbortController();aborted.abort();await assert.rejects(prepare(()=>{},aborted.signal),{name:'AbortError'});
    assert.equal(reads,0);assert.equal(state.resources.length,0);
    const pool=await prepare(()=>{},new AbortController().signal);
    assert.deepEqual(module.preparedScannerConfiguration(pool),NORMAL_SCANNER_NAME_CONFIGURATION);
    assert.ok(state.options.every(value=>value.nameRawResultPolicy==='resample'));
  });
});

test('claim validates configuration without consuming a mismatched pool and transfers it only once',async()=>{
  await fakePreparation(async({prepare,module})=>{
    const pool=await prepare(()=>{},new AbortController().signal,continued);
    assert.throws(()=>module.claimPreparedScanner(pool,NORMAL_SCANNER_NAME_CONFIGURATION),/일치/);
    const claimed=module.claimPreparedScanner(pool,continued);
    assert.equal(claimed.detector,pool.detector);assert.notEqual(claimed.readers,pool.readers);assert.deepEqual(claimed.readers,pool.readers);
    assert.notEqual(claimed.visuals,pool.visuals);assert.ok(Object.isFrozen(claimed)&&Object.isFrozen(claimed.readers)&&Object.isFrozen(claimed.visuals));
    assert.throws(()=>module.claimPreparedScanner(pool,continued),/한 번/);assert.throws(()=>module.claimPreparedScanner(claimed,continued),/한 번/);
    const first=module.disposePreparedScanner(pool);assert.equal(module.disposePreparedScanner(claimed),first);assert.equal(claimed.dispose(),first);await first;
  });
});

test('unknown and forged objects are rejected without reading getters, and safe cleanup is a no-op',async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    const pool=await prepare(()=>{},new AbortController().signal);let reads=0;
    const hostile=new Proxy({}, {get(){reads++;throw Error('get');},ownKeys(){reads++;throw Error('keys');},getPrototypeOf(){reads++;throw Error('prototype');}});
    for(const unknown of [null,undefined,{},hostile,{...pool}]){
      assert.equal(module.preparedScannerConfiguration(unknown),null);
      assert.throws(()=>module.claimPreparedScanner(unknown,NORMAL_SCANNER_NAME_CONFIGURATION));
      module.cancelPreparedScanner(unknown);await module.disposePreparedScanner(unknown);
    }
    assert.equal(reads,0);assert.ok(state.resources.every(value=>value.disposals===0));
  });
});

test('mixed reader arrays fail claim while cleanup releases only the original owned sessions',async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    const first=await prepare(()=>{},new AbortController().signal),second=await prepare(()=>{},new AbortController().signal);
    const original=first.readers[0],borrowed=second.readers[0];(first.readers as unknown[])[0]=borrowed;
    assert.equal(module.preparedScannerConfiguration(first),null);assert.throws(()=>module.claimPreparedScanner(first,NORMAL_SCANNER_NAME_CONFIGURATION));
    await module.disposePreparedScanner(first);
    assert.equal((original as unknown as Resource).disposals,1);assert.equal((borrowed as unknown as Resource).disposals,0);
    assert.ok(state.resources.some(value=>value.disposals===0));await module.disposePreparedScanner(second);
    assert.ok(state.resources.every(value=>value.disposals===1));
  });
});

test('tampered public getters and resource methods cannot redirect known cleanup',async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    const pool=await prepare(()=>{},new AbortController().signal),reader=pool.readers[0];let reads=0;
    Object.defineProperty(reader,'dispose',{configurable:true,get(){reads++;throw Error('reader getter');}});
    Object.defineProperty(pool,'dispose',{configurable:true,get(){reads++;throw Error('pool getter');}});
    Object.defineProperty(pool,'readers',{configurable:true,get(){reads++;throw Error('array getter');}});
    assert.equal(module.preparedScannerConfiguration(pool),null);assert.throws(()=>module.claimPreparedScanner(pool,NORMAL_SCANNER_NAME_CONFIGURATION));
    module.cancelPreparedScanner(pool);await module.disposePreparedScanner(pool);
    assert.equal(reads,0);assert.ok(state.resources.every(value=>value.disposals===1));
  });
});

test('claimed top-level snapshot survives later changes to the original containers',async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    const pool=await prepare(()=>{},new AbortController().signal),claimed=module.claimPreparedScanner(pool,NORMAL_SCANNER_NAME_CONFIGURATION);
    const readers=[...claimed.readers],visuals=[...claimed.visuals],detector=claimed.detector;
    (pool.readers as unknown[]).length=0;(pool.visuals as unknown[]).length=0;
    Object.defineProperty(pool,'detector',{value:{},configurable:true});
    assert.deepEqual(claimed.readers,readers);assert.deepEqual(claimed.visuals,visuals);assert.equal(claimed.detector,detector);
    assert.deepEqual(module.preparedScannerConfiguration(claimed),NORMAL_SCANNER_NAME_CONFIGURATION);
    await module.disposePreparedScanner(claimed);assert.ok(state.resources.every(value=>value.disposals===1));
  });
});

test('cancellation or disposal before claim makes a known pool unavailable, with idempotent cleanup',async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    state.visualUnavailable=true;const pool=await prepare(()=>{},new AbortController().signal);
    assert.ok(pool.visuals.every(value=>value===undefined));module.cancelPreparedScanner(pool);module.cancelPreparedScanner(pool);
    assert.ok(state.signals.every(value=>value.aborted));assert.equal(module.preparedScannerConfiguration(pool),null);
    assert.throws(()=>module.claimPreparedScanner(pool,NORMAL_SCANNER_NAME_CONFIGURATION));
    const first=module.disposePreparedScanner(pool);assert.equal(module.disposePreparedScanner(pool),first);await first;
    assert.ok(state.resources.every(value=>value.disposals===1));
    const next=await prepare(()=>{},new AbortController().signal);await module.disposePreparedScanner(next);
    assert.equal(module.preparedScannerConfiguration(next),null);assert.throws(()=>module.claimPreparedScanner(next,NORMAL_SCANNER_NAME_CONFIGURATION));
  });
});

test('unclaimed-only cleanup from a rejected competing consumer cannot cancel or dispose a transferred owner',async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    const pool=await prepare(()=>{},new AbortController().signal),claimed=module.claimPreparedScanner(pool,NORMAL_SCANNER_NAME_CONFIGURATION);
    assert.throws(()=>module.claimPreparedScanner(pool,NORMAL_SCANNER_NAME_CONFIGURATION),/한 번/);
    for(const alias of [pool,claimed]){
      module.cancelUnclaimedPreparedScanner(alias);await module.disposeUnclaimedPreparedScanner(alias);
    }
    assert.ok(state.signals.every(value=>!value.aborted));assert.ok(state.resources.every(value=>value.disposals===0));
    assert.deepEqual(module.preparedScannerConfiguration(claimed),NORMAL_SCANNER_NAME_CONFIGURATION);
    const released=module.disposePreparedScanner(claimed);await released;
    assert.ok(state.resources.every(value=>value.disposals===1));
  });
});

test('preflight cleanup still releases an unclaimed pool after configuration mismatch or invalid configuration',async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    for(const invalid of [continued,{version:99}]){
      const before=state.resources.length,pool=await prepare(()=>{},new AbortController().signal);
      assert.throws(()=>module.claimPreparedScanner(pool,invalid));
      module.cancelUnclaimedPreparedScanner(pool);
      const first=module.disposeUnclaimedPreparedScanner(pool);assert.equal(module.disposeUnclaimedPreparedScanner(pool),first);
      await first;assert.ok(state.resources.slice(before).every(value=>value.disposals===1));
    }
    let reads=0;const unknown=new Proxy({}, {get(){reads++;throw Error('getter');},getPrototypeOf(){reads++;throw Error('prototype');}});
    module.cancelUnclaimedPreparedScanner(unknown);await module.disposeUnclaimedPreparedScanner(unknown);assert.equal(reads,0);
  });
});

test('preparation failure joins every allocated cleanup and preserves the original setup error',async()=>{
  await fakePreparation(async({prepare,state})=>{
    state.acquisitionFailure=true;state.disposeFailure='reader-1';
    await assert.rejects(prepare(()=>{},new AbortController().signal,continued),/acquisition setup failed/);
    assert.ok(state.resources.length>0);assert.ok(state.resources.every(value=>value.disposals===1));
  });
  await fakePreparation(async({prepare,state})=>{
    state.readerFailure=2;await assert.rejects(prepare(()=>{},new AbortController().signal),/reader setup failed/);
    assert.deepEqual(state.resources.map(value=>value.kind),['detector','reader-1']);
    assert.ok(state.resources.every(value=>value.disposals===1));
  });
});

test('failed known cleanup is memoized and does not skip other resources',async()=>{
  await fakePreparation(async({prepare,module,state})=>{
    const pool=await prepare(()=>{},new AbortController().signal);state.disposeFailure='detector';
    const first=module.disposePreparedScanner(pool);await assert.rejects(first,AggregateError);
    assert.equal(module.disposePreparedScanner(pool),first);await assert.rejects(module.disposePreparedScanner(pool),AggregateError);
    assert.ok(state.resources.every(value=>value.disposals===1));
  });
});
