import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {beginReproduction,createReproductionBundle,openReproduction,replaySettings,replayNameConfiguration,
  createReproductionSessionAccess,createScanDiagnosticSummary} from '../src/features/card-scanner/scan-reproduction';
import type {ReproductionFile} from '../src/features/card-scanner/scan-reproduction';
import {createReproductionSessionStore,SESSION_LEASE_MS,SessionStorageLimitError} from '../src/features/card-scanner/reproduction-session-store';
import {NORMAL_SCANNER_NAME_CONFIGURATION,parseScannerNameConfiguration} from '../src/features/card-scanner/scanner-name-configuration';

const environment={browser:'test',catalog:'test',build:'test'};
const continued=()=>parseScannerNameConfiguration({version:1,rawResultPolicy:'continue'});
const file=():ReproductionFile=>{
  const video=new Blob(['webm'],{type:'video/webm'});
  return {video,metadata:{version:3,createdAt:'2026-10-27T00:00:00Z',...environment,completed:false,warnings:[],
    duration:1,type:video.type,bytes:video.size,seed:[],result:null}};
};
const state=(extra:Record<string,unknown>={})=>({status:'완료',expected:0,currentRunRead:0,cards:[],unidentified:[],...extra}) as
  unknown as NonNullable<Parameters<typeof createScanDiagnosticSummary>[0]>;
const metric=(policy:'resample'|'continue'='continue')=>({scope:'korean-neural-name-request-await',policy,
  invocations:1,continued:0,quickAccepted:1,invocationFailures:0,requests:1,reusedRequests:0,failedRequests:0,wallAwaitMs:1,
  recipes:[{recipe:'raw-first-line',requests:1,reusedRequests:0,failedRequests:0,wallAwaitMs:1}]});
const request=<T>(value:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
async function fixture(work:(store:ReturnType<typeof createReproductionSessionStore>,clock:{value:number})=>Promise<void>) {
  const dbName=`reproduction-name-${crypto.randomUUID()}`,clock={value:10000};
  const store=createReproductionSessionStore({dbName,ownerId:'name-test',now:()=>clock.value});
  try{await work(store,clock);}finally{await request(indexedDB.deleteDatabase(dbName));}
}

test('a recorded configuration survives an actual bundle round trip and leaves DebugCapture settings unchanged',async()=>{
  const source=file();source.metadata.nameConfiguration=continued();
  const replay=await openReproduction(createReproductionBundle(source),AbortSignal.timeout(1000));
  assert.deepEqual(replayNameConfiguration(replay),{configuration:{version:1,rawResultPolicy:'continue'},recorded:true});
  assert.equal(Object.isFrozen(replay.metadata.nameConfiguration),true);
  const legacy=file();assert.deepEqual(replaySettings(replay),replaySettings(legacy));
  assert.equal('nameConfiguration' in replaySettings(replay),false);
});

test('contrast opt-in survives bundle encoding and replay without changing the default',async()=>{
 const source=file();const configuration=parseScannerNameConfiguration({version:1,rawResultPolicy:'resample',contrastNameFallback:true});
 source.metadata.nameConfiguration=configuration;
 const replay=await openReproduction(createReproductionBundle(source),AbortSignal.timeout(1000));
 assert.deepEqual(replayNameConfiguration(replay),{configuration,recorded:true});
 assert.deepEqual(NORMAL_SCANNER_NAME_CONFIGURATION,{version:1,rawResultPolicy:'resample'});
});

test('legacy absence stays unrecorded through loading, replay fallback and re-export; an explicit normal policy is recorded',async()=>{
  const legacy=file(),loaded=await openReproduction(createReproductionBundle(legacy),AbortSignal.timeout(1000));
  assert.deepEqual(replayNameConfiguration(loaded),{configuration:NORMAL_SCANNER_NAME_CONFIGURATION,recorded:false});
  assert.equal(Object.hasOwn(legacy.metadata,'nameConfiguration'),false);assert.equal(Object.hasOwn(loaded.metadata,'nameConfiguration'),false);
  const again=await openReproduction(createReproductionBundle(loaded),AbortSignal.timeout(1000));
  assert.equal(Object.hasOwn(again.metadata,'nameConfiguration'),false);
  const normal=file();normal.metadata.nameConfiguration=NORMAL_SCANNER_NAME_CONFIGURATION;
  assert.equal(replayNameConfiguration(await openReproduction(createReproductionBundle(normal),AbortSignal.timeout(1000))).recorded,true);
});

test('present invalid configuration values reject at bundle, replay and new-session boundaries without evaluating getters',()=>{
  const invalid:unknown[]=[undefined,null,{},[],{version:2,rawResultPolicy:'continue'},{version:1,rawResultPolicy:'other'},
    {version:1,rawResultPolicy:'continue',gray:true}];
  for(const value of invalid){
    const source=file();Object.defineProperty(source.metadata,'nameConfiguration',{value,enumerable:true});
    assert.throws(()=>createReproductionBundle(source));assert.throws(()=>replayNameConfiguration(source));
    assert.throws(()=>beginReproduction([],environment,{nameConfiguration:value as never}));
  }
  let getterCalls=0;
  const configuration=Object.defineProperty({version:1},'rawResultPolicy',{enumerable:true,get(){getterCalls++;return 'continue';}});
  const source=file();Object.defineProperty(source.metadata,'nameConfiguration',{enumerable:true,get(){getterCalls++;return configuration;}});
  assert.throws(()=>createReproductionBundle(source));assert.throws(()=>replayNameConfiguration(source));
  assert.throws(()=>beginReproduction([],environment,Object.defineProperty({},'nameConfiguration',{get(){getterCalls++;return configuration;}})));
  assert.throws(()=>beginReproduction([],environment,{nameConfiguration:configuration as never}));assert.equal(getterCalls,0);
});

test('opening a serialized present null/extra/version-invalid setting rejects instead of treating it as legacy',async()=>{
  for(const nameConfiguration of [null,{version:1,rawResultPolicy:'continue',gray:true},{version:99,rawResultPolicy:'resample'}]){
    const source=file(),metadata=new Blob([JSON.stringify({...source.metadata,nameConfiguration})]),length=new Uint8Array(4);
    new DataView(length.buffer).setUint32(0,metadata.size,true);
    await assert.rejects(openReproduction(new Blob(['LOACARD-REPLAY1\n',length,metadata,source.video]),AbortSignal.timeout(1000)));
  }
});

test('fresh sessions return only the frozen normal policy without recording flags and retain it in zero-input context',async()=>{
  await fixture(async store=>{
    const capture=beginReproduction([],environment,{store});await capture.ready;
    assert.deepEqual(capture.options,{nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION});
    assert.equal(Object.isFrozen(capture.options.nameConfiguration),true);
    assert.equal(await capture.finish(undefined,false),undefined);
    const details=(await store.getSessionDetails(capture.id))!;
    assert.deepEqual((details.initial as {nameConfiguration:unknown}).nameConfiguration,NORMAL_SCANNER_NAME_CONFIGURATION);
    assert.equal(Object.hasOwn(details.summary as object,'nameConfiguration'),false);
    assert.equal(await createReproductionSessionAccess(store).load(capture.id),undefined);
  });
});

test('explicit new-session policy is detached and survives initial journal, partial final seal, load and bundle',async()=>{
  await fixture(async store=>{
    const configuration={version:1 as const,rawResultPolicy:'continue' as 'continue'|'resample'};
    const capture=beginReproduction([],environment,{record:true,store,nameConfiguration:configuration});
    assert.equal(capture.options.recordingMode,'detailed');
    configuration.rawResultPolicy='resample';await capture.ready;
    capture.options.continuous!({blob:file().video,duration:1});
    const sealed=await capture.finish(state({nameConfiguration:continued()}),true);
    assert.ok(sealed);assert.equal(sealed.metadata.nameConfiguration?.rawResultPolicy,'continue');
    const initial=(await store.getSessionDetails(capture.id))!.initial as {nameConfiguration:{rawResultPolicy:string}};
    assert.equal(initial.nameConfiguration.rawResultPolicy,'continue');
    const loaded=(await createReproductionSessionAccess(store).load(capture.id))!;
    assert.deepEqual(replayNameConfiguration(await openReproduction(createReproductionBundle(loaded),AbortSignal.timeout(1000))),
      {configuration:{version:1,rawResultPolicy:'continue'},recorded:true});
  });
});

test('interrupted video-only recovery preserves an explicitly known policy while legacy context stays unknown',async()=>{
  for(const recorded of [true,false])await fixture(async(store,clock)=>{
    await store.beginSession({id:'interrupted',createdAt:new Date(clock.value).toISOString(),environment,record:true,
      initial:{seed:[],...(recorded?{nameConfiguration:continued()}:{})}});
    await store.appendChunk('interrupted','video',0,file().video);clock.value+=SESSION_LEASE_MS+1;
    await store.recoverInterrupted();
    const recovered=(await createReproductionSessionAccess(store).load('interrupted'))!;
    assert.equal(recovered.metadata.recordState,'partial');assert.equal(recovered.metadata.duration,0);
    assert.equal(replayNameConfiguration(recovered).recorded,recorded);
    assert.equal(replayNameConfiguration(recovered).configuration.rawResultPolicy,recorded?'continue':'resample');
    assert.equal(Object.hasOwn(recovered.metadata,'nameConfiguration'),recorded);
  });
});

test('an invalid recorded recovery policy rejects and conflicting initial/final policies cannot be silently selected',async()=>{
  await fixture(async store=>{
    await store.beginSession({id:'invalid',createdAt:new Date().toISOString(),environment,record:true,initial:{seed:[],nameConfiguration:null}});
    await store.appendChunk('invalid','video',0,file().video);
    await assert.rejects(createReproductionSessionAccess(store).load('invalid'));
    await store.beginSession({id:'conflict',createdAt:new Date().toISOString(),environment,record:true,initial:{seed:[],nameConfiguration:continued()}});
    await store.appendChunk('conflict','video',0,file().video);
    await store.sealSession('conflict',{status:'partial',metadata:{...file().metadata,nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION}});
    await assert.rejects(createReproductionSessionAccess(store).load('conflict'),/설정/);
  });
});

test('automatic diagnostics detach effective configuration and mixed valid reader metrics without inventing missing fields',()=>{
  const metrics=[metric('continue'),metric('resample')],configuration={version:1,rawResultPolicy:'continue'};
  const summary=createScanDiagnosticSummary(state({nameConfiguration:configuration,nameOcrMetrics:metrics}),false);
  configuration.rawResultPolicy='resample';metrics[0].requests=999;metrics[0].recipes[0].requests=999;
  assert.equal(summary.nameConfiguration?.rawResultPolicy,'continue');assert.equal(Object.isFrozen(summary.nameConfiguration),true);
  assert.deepEqual(summary.performance?.nameOcr?.map(value=>({policy:value.policy,requests:value.requests})),
    [{policy:'continue',requests:1},{policy:'resample',requests:1}]);
  const legacy=createScanDiagnosticSummary(state(),false);
  assert.equal(Object.hasOwn(legacy,'nameConfiguration'),false);assert.equal(Object.hasOwn(legacy.performance!,'nameOcr'),false);
  assert.equal(Object.hasOwn(legacy.performance!,'nameOcrUnavailable'),false);
});

test('invalid or over-budget optional metrics remain unavailable and preserve existing field/image evidence',()=>{
  const malformed=[{...metric(),requests:null},Array(33).fill(metric()),{...metric(),frames:['pixels']}];
  const reasons=['raw-first-line','raw-second-line','raw-full-label','gray-first-line',...Array.from({length:5},(_,grade)=>
    [`soft-grade-${grade}-original`,`soft-grade-${grade}-normalized`]).flat()];
  const recipes=reasons.map(recipe=>({recipe,requests:10**13,reusedRequests:10**13,failedRequests:10**13,wallAwaitMs:1e300}));
  const large=Array.from({length:32},()=>({...metric(),requests:14*10**13,reusedRequests:14*10**13,failedRequests:14*10**13,
    wallAwaitMs:14e300,recipes}));
  for(const metrics of [malformed[0],malformed[1],malformed[2],large]){
    const image='data:image/png;base64,AAAA';
    const summary=createScanDiagnosticSummary(state({nameOcrMetrics:Array.isArray(metrics)?metrics:[metrics],cards:[
      {id:'card',name:'카드',awakening:null,extraCopies:null,review:['장수 확인'],image,time:1}]}),false);
    assert.equal(summary.performance?.nameOcr,undefined);assert.equal(summary.performance?.nameOcrUnavailable,'invalid-or-over-limit');
    assert.equal(summary.images[0].image,image);assert.equal(summary.result?.cards[0].extraCopies,null);
  }
});

test('session-capacity fallback removes new metrics before displacing the existing diagnostic summary',async()=>{
  await fixture(async store=>{
    let attemptedWithMetrics=0;
    const limited={...store,sealSession:async(...args:Parameters<typeof store.sealSession>)=>{
      if((args[1].summary as {performance?:{nameOcr?:unknown}})?.performance?.nameOcr){attemptedWithMetrics++;throw new SessionStorageLimitError('small test capacity');}
      return store.sealSession(...args);
    }};
    const capture=beginReproduction([],environment,{store:limited});
    await capture.finish(state({nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION,nameOcrMetrics:[metric('resample')]}),true);
    const summary=(await store.getSessionDetails(capture.id))!.summary as ReturnType<typeof createScanDiagnosticSummary>;
    assert.equal(attemptedWithMetrics,1);assert.equal(summary.result?.expected,0);
    assert.equal(summary.performance?.nameOcr,undefined);assert.equal(summary.performance?.nameOcrUnavailable,'invalid-or-over-limit');
  });
});

test('optional metric accessors are not evaluated or copied into diagnostics',()=>{
  let calls=0;
  const readers:unknown[]=[];
  Object.defineProperty(readers,'0',{get(){calls++;return metric();},enumerable:true});
  const summary=createScanDiagnosticSummary(state({nameOcrMetrics:readers}),false);
  assert.equal(calls,0);assert.equal(summary.performance?.nameOcr,undefined);
  assert.equal(summary.performance?.nameOcrUnavailable,'invalid-or-over-limit');
});
