import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {beginReproduction,createReproductionBundle,openReproduction,parseDevRecognitionOptions,
  replayDevRecognitionOptions,createReproductionSessionAccess} from '../src/features/card-scanner/reproduction/scan-reproduction';
import {devReplayRecognitionOptions,reproductionInput} from '../src/features/card-scanner/reproduction/reproduction-input';
import {createReproductionSessionStore,SESSION_LEASE_MS} from '../src/features/card-scanner/reproduction/reproduction-session-store';
import type {ReproductionFile} from '../src/features/card-scanner/reproduction/scan-reproduction';

const environment={browser:'test',catalog:'test',build:'test'};
const file=():ReproductionFile=>{const video=new Blob(['webm'],{type:'video/webm'});return {video,metadata:{version:3,
  createdAt:'2026-10-27T00:00:00Z',...environment,completed:false,warnings:[],duration:1,type:video.type,
  bytes:video.size,seed:[],result:null}};};
const state={status:'완료',expected:0,currentRunRead:0,cards:[],unidentified:[]} as never;
async function withStore(run:(store:ReturnType<typeof createReproductionSessionStore>,clock:{value:number})=>Promise<void>){
  const clock={value:Date.now()},dbName=`dev-options-${crypto.randomUUID()}`;
  const store=createReproductionSessionStore({dbName,ownerId:'dev-options-test',now:()=>clock.value});
  try{await run(store,clock);}finally{await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase(dbName);
    request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});}
}
test('DEV retry options survive a recorded session and bundle without enabling them in shared input options',async()=>{
  await withStore(async store=>{
    const options={version:1 as const,fractionalPortrait:true,grayNameFallback:false};
    const capture=beginReproduction([],environment,{record:true,store,devRecognitionOptions:options});
    options.fractionalPortrait=false;await capture.ready;capture.options.continuous!({blob:file().video,duration:1});
    const sealed=await capture.finish(state,true);assert.ok(sealed);
    const loaded=(await createReproductionSessionAccess(store).load(capture.id))!;
    const opened=await openReproduction(createReproductionBundle(loaded),AbortSignal.timeout(1000));
    const input=reproductionInput(opened,new AbortController().signal);
    assert.deepEqual(input.devRecognitionOptions,{version:1,fractionalPortrait:true,grayNameFallback:false});
    const decision=devReplayRecognitionOptions(input.options.nameConfiguration,input.devRecognitionOptions);
    assert.deepEqual(decision.recorded,input.devRecognitionOptions);
    assert.deepEqual(decision.applied,{fractionalPortrait:true,grayNameFallback:false});
    assert.equal(Object.hasOwn(input.options,'fractionalPortrait'),false);
    assert.equal(Object.hasOwn(input.options,'grayNameFallback'),false);
  });
});
test('old recordings and interrupted recordings retain unknown or explicit retry settings',async()=>{
  assert.equal(replayDevRecognitionOptions(file()),undefined);
  assert.deepEqual(devReplayRecognitionOptions({version:1,rawResultPolicy:'resample'},undefined),{
    recorded:null,applied:{fractionalPortrait:false,grayNameFallback:false},scope:'recognition-retries-only'});
  for(const present of [false,true])await withStore(async(store,clock)=>{
    const value={version:1 as const,fractionalPortrait:false,grayNameFallback:true};
    await store.beginSession({id:'interrupted',createdAt:new Date(clock.value).toISOString(),environment,record:true,
      initial:{seed:[],...(present?{devRecognitionOptions:value}:{})}});
    await store.appendChunk('interrupted','video',0,file().video);clock.value+=SESSION_LEASE_MS+1;
    await store.recoverInterrupted();
    const restored=(await createReproductionSessionAccess(store).load('interrupted'))!;
    assert.deepEqual(replayDevRecognitionOptions(restored),present?value:undefined);
  });
});
test('untrusted or conflicting settings fail closed',async()=>{
  for(const value of [null,{version:2,fractionalPortrait:false,grayNameFallback:false},
    {version:1,fractionalPortrait:true,grayNameFallback:true},
    {version:1,fractionalPortrait:false,grayNameFallback:false,other:true}])
    assert.throws(()=>parseDevRecognitionOptions(value));
  let called=false;const accessor={version:1,grayNameFallback:false,get fractionalPortrait(){called=true;return true;}};
  assert.throws(()=>parseDevRecognitionOptions(accessor));assert.equal(called,false);
  const active={version:1 as const,fractionalPortrait:false,grayNameFallback:true};
  assert.throws(()=>devReplayRecognitionOptions({version:1,rawResultPolicy:'continue'},active),/설정/);
  assert.throws(()=>devReplayRecognitionOptions({version:1,rawResultPolicy:'resample',contrastNameFallback:true},active),/설정/);
  for(const recorded of [undefined,active])
    assert.throws(()=>devReplayRecognitionOptions({version:1,rawResultPolicy:'resample'},recorded,
      {fractionalPortrait:true,grayNameFallback:false}),/URL/);
  await withStore(async store=>{
    const first={version:1 as const,fractionalPortrait:true,grayNameFallback:false};
    const second={version:1 as const,fractionalPortrait:false,grayNameFallback:true};
    await store.beginSession({id:'conflict',createdAt:new Date().toISOString(),environment,record:true,initial:{seed:[],devRecognitionOptions:first}});
    await store.appendChunk('conflict','video',0,file().video);
    await store.sealSession('conflict',{status:'partial',metadata:{...file().metadata,devRecognitionOptions:second}});
    await assert.rejects(createReproductionSessionAccess(store).load('conflict'),/설정/);
  });
});
