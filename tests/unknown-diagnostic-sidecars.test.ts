import assert from 'node:assert/strict';
import {test} from 'node:test';
import {UnknownLifecycle,hashUnknownLifecycle} from '../src/features/card-scanner/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../src/features/card-scanner/unknown-lifecycle-types';
import type {UnknownUpsert,UnknownEntry} from '../src/features/card-scanner/unknown-lifecycle-types';
import {UnknownDiagnosticSidecars} from '../src/features/card-scanner/unknown-diagnostic-sidecars';
import type {PortraitDiagnostics} from '../src/features/card-scanner/portrait-diagnostics';

const seed={version:1 as const,sessionId:'scan',origin:'scan' as const,limits:UNKNOWN_LIFECYCLE_LIMITS};
const failure=(group:number,order:number,pending=false):UnknownUpsert=>({version:1,kind:'upsert',
  key:{kind:'group',sessionId:'scan',group},source:{sessionId:'scan',frameId:order,observationId:String(order),
    captureOrder:order,captureTime:order,phase:'input',slot:group%40},captureOrder:order,captureTime:order,
  pending,reason:'이름 확인 필요',location:{percent:50,column:1,row:20}});
const effectEntry=(core:UnknownLifecycle,fact:UnknownUpsert):UnknownEntry=>{
  const entry=core.apply(fact).upserted;assert.ok(entry);return entry;
};
const images=(key:string)=>({pixelKey:key,preview:()=>`preview-${key}`,recognition:()=>`crop-${key}`});

test('image failure and eviction leave lifecycle metadata and hash unchanged',async()=>{
  const core=new UnknownLifecycle(seed),sidecars=new UnknownDiagnosticSidecars({entries:1,previewBytes:20,
    recognitionEntries:1,recognitionBytes:20,metadataBytes:100});
  const first=effectEntry(core,failure(1,10)),second=effectEntry(core,failure(2,20));
  const hash=await hashUnknownLifecycle(core.snapshot());
  sidecars.remember(first,images('a'));
  sidecars.remember(second,{pixelKey:'b',preview:()=>{throw Error('encoder');},recognition:()=>{throw Error('encoder');}});
  const projected=sidecars.project(core.active());
  assert.equal(projected.length,2);assert.ok(projected.every(row=>row.image===''));
  assert.equal(projected[1].captureOrder,20);assert.equal(projected[1].reason,'이름 확인 필요');
  assert.equal(await hashUnknownLifecycle(core.snapshot()),hash);
});

test('stale or covered candidates never invoke sidecar encoders',()=>{
  const core=new UnknownLifecycle(seed),sidecars=new UnknownDiagnosticSidecars();let encoded=0;
  const remember=(fact:UnknownUpsert)=>{const effect=core.apply(fact);if(effect.upserted)sidecars.remember(effect.upserted,
    {pixelKey:String(fact.captureOrder),preview:()=>{encoded++;return 'preview';},recognition:()=>{encoded++;return 'crop';}});};
  remember(failure(1,30));remember(failure(1,20));remember(failure(1,30,true));
  core.confirmName({kind:'group',sessionId:'scan',group:2},'card',failure(2,40).source!,[]);
  remember(failure(2,30));assert.equal(encoded,2);
  assert.equal(sidecars.project(core.active())[0].captureOrder,30);
});

test('old retirement and encoding errors cannot replace a newer diagnostic version',()=>{
  const core=new UnknownLifecycle(seed),sidecars=new UnknownDiagnosticSidecars();
  const old=effectEntry(core,failure(1,10));sidecars.remember(old,images('old'));
  const latest=effectEntry(core,failure(1,30));sidecars.remember(latest,images('new'));
  sidecars.retire([old]);assert.equal(sidecars.project(core.active())[0].recognitionImage,'crop-new');
  const pending=effectEntry(core,failure(2,40,true));sidecars.remember(pending,images('pending'));
  const final=effectEntry(core,failure(2,40));sidecars.remember(final,{pixelKey:'different',
    preview:()=>{throw Error('encoder');},recognition:()=>{throw Error('encoder');}});
  assert.equal(sidecars.project(core.active())[1].image,'');
  const effect=core.confirmName({kind:'group',sessionId:'scan',group:1},'card',failure(1,30).source!,[]);
  assert.ok(effect);sidecars.retire(effect.retiredVersions);
  assert.equal(core.active().length,1);assert.equal(sidecars.project(core.active())[0].group,2);
});

test('OCR sidecars are bounded detached diagnostics and never an identity proof',()=>{
  const core=new UnknownLifecycle(seed),sidecars=new UnknownDiagnosticSidecars();
  const entry=effectEntry(core,failure(1,1));
  const attempts=Array.from({length:30},()=>({text:'unknown',confidence:1,engine:'ocr',variant:'raw',reason:'failed',
    candidates:Array.from({length:5},()=>({id:'candidate',name:'candidate',score:.1}))}));
  sidecars.remember(entry,{...images('a'),nameAttempts:attempts});attempts[0].text='mutated';
  const first=sidecars.project(core.active());assert.equal(first[0].nameAttempts?.length,24);
  assert.equal(first[0].nameAttempts?.[0].candidates.length,3);
  first[0].nameAttempts![0].candidates[0].id='mutated';
  const second=sidecars.project(core.active());assert.equal(second[0].nameAttempts?.[0].text,'unknown');
  assert.equal(second[0].nameAttempts?.[0].candidates[0].id,'candidate');assert.equal(core.active().length,1);
});

const portraitCalls=()=>[{source:'computed' as const,mode:'visual' as const,diagnostic:{version:1 as const,coordinateSpace:'gray-grid-24x32' as const,
  outcome:'unavailable' as const,reason:'insufficient-identities' as const,fractionalRegistration:false,referenceIdentities:0,text:null,stages:[]}}];
const nameAttempts=()=>[{text:'unknown',confidence:40,engine:'ocr',variant:'raw',reason:'failed',candidates:[{id:'candidate',name:'candidate',score:.1}]}];

test('portrait sidecars distinguish missing, explicitly no calls and rejected data without touching warning authority',async()=>{
  const core=new UnknownLifecycle(seed),sidecars=new UnknownDiagnosticSidecars(),entry=effectEntry(core,failure(1,1));
  const hash=await hashUnknownLifecycle(core.snapshot());
  sidecars.remember(entry,images('legacy'));assert.equal(sidecars.project(core.active())[0].portraitDiagnostics,null);
  sidecars.remember(entry,{...images('empty'),portraitDiagnostics:[]});assert.deepEqual(sidecars.project(core.active())[0].portraitDiagnostics,[]);
  for(const value of [null,{},[...portraitCalls(),...portraitCalls(),...portraitCalls(),...portraitCalls()]]){
    sidecars.remember(entry,{...images('invalid'),nameAttempts:nameAttempts(),portraitDiagnostics:value as PortraitDiagnostics});
    const result=sidecars.project(core.active())[0];assert.equal(result.portraitDiagnostics,null);
    assert.deepEqual(result.nameAttempts,nameAttempts());assert.equal(result.reason,'이름 확인 필요');assert.equal(result.pending,false);
  }
  assert.equal(await hashUnknownLifecycle(core.snapshot()),hash);assert.equal(core.active().length,1);
});

test('portrait snapshots own their data and stay tied to the exact unknown version',()=>{
  const core=new UnknownLifecycle(seed),sidecars=new UnknownDiagnosticSidecars(),old=effectEntry(core,failure(1,10));
  const calls=portraitCalls();sidecars.remember(old,{...images('old'),portraitDiagnostics:calls});calls[0].diagnostic.referenceIdentities=5;
  assert.equal(sidecars.project([old])[0].portraitDiagnostics?.[0].diagnostic.referenceIdentities,0);
  const current=effectEntry(core,failure(1,20));sidecars.remember(current,{...images('current'),portraitDiagnostics:[]});
  assert.equal(sidecars.project([old])[0].portraitDiagnostics,null);
  sidecars.retire([old]);assert.deepEqual(sidecars.project(core.active())[0].portraitDiagnostics,[]);
  const newer=effectEntry(core,failure(1,30));sidecars.remember(newer,images('no-diagnostic'));
  assert.equal(sidecars.project(core.active())[0].portraitDiagnostics,null);
});

test('portrait bytes share the existing metadata budget and never displace this entry OCR attempts',()=>{
  const core=new UnknownLifecycle(seed),entry=effectEntry(core,failure(1,1)),attempts=nameAttempts();
  const metadataBytes=new TextEncoder().encode(JSON.stringify(attempts)).byteLength;
  const limited=new UnknownDiagnosticSidecars({entries:128,previewBytes:2*1024*1024,recognitionEntries:32,recognitionBytes:1024*1024,metadataBytes});
  limited.remember(entry,{...images('name-first'),nameAttempts:attempts,portraitDiagnostics:portraitCalls()});
  assert.deepEqual(limited.project([entry])[0].nameAttempts,attempts);assert.equal(limited.project([entry])[0].portraitDiagnostics,null);
  const singleBytes=new TextEncoder().encode(JSON.stringify(portraitCalls())).byteLength;
  const shared=new UnknownDiagnosticSidecars({entries:128,previewBytes:2*1024*1024,recognitionEntries:32,recognitionBytes:1024*1024,metadataBytes:singleBytes});
  const second=effectEntry(core,failure(2,2));shared.remember(entry,{...images('first'),portraitDiagnostics:portraitCalls()});
  shared.remember(second,{...images('second'),portraitDiagnostics:portraitCalls()});
  const rows=shared.project(core.active());assert.equal(rows[0].portraitDiagnostics,null);assert.equal(rows[1].portraitDiagnostics?.length,1);
  assert.equal(rows.length,2);
});

test('portrait getters and malicious payloads cannot execute or remove valid OCR metadata',()=>{
  const core=new UnknownLifecycle(seed),sidecars=new UnknownDiagnosticSidecars(),entry=effectEntry(core,failure(1,1));let invoked=0;
  const diagnostic={...images('getter'),nameAttempts:nameAttempts(),get portraitDiagnostics(){invoked++;throw Error('not data');}};
  assert.doesNotThrow(()=>sidecars.remember(entry,diagnostic));assert.equal(invoked,0);
  const projected=sidecars.project([entry])[0];assert.equal(projected.portraitDiagnostics,null);assert.deepEqual(projected.nameAttempts,nameAttempts());
  const cyclic=portraitCalls() as unknown as unknown[];cyclic[0]=cyclic;
  assert.doesNotThrow(()=>sidecars.remember(entry,{...images('cycle'),nameAttempts:nameAttempts(),portraitDiagnostics:cyclic as PortraitDiagnostics}));
  assert.deepEqual(sidecars.project([entry])[0].nameAttempts,nameAttempts());assert.equal(core.active().length,1);
});
