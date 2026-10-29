import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {beginReproduction,loadReproduction,loadScanDiagnosticSummary,createScanDiagnosticSummary,clearReproduction,createReproductionBundle,openReproduction,replaySettings,compareReproduction,
 listReproductionSessions,loadReproductionSession,loadSessionDiagnosticSummary} from '../src/features/card-scanner/scan-reproduction';
import type {ReproductionFile} from '../src/features/card-scanner/scan-reproduction';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../src/features/card-scanner/scanner-name-configuration';
import {MAX_UNRESOLVED_FIELD_CHANGES} from '../src/features/card-scanner/current-scan-fields';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';
const file=():ReproductionFile=>({video:new Blob(['webm-content'],{type:'video/webm;codecs=vp8'}),metadata:{
  version:1,createdAt:'2026-10-17T00:00:00Z',browser:'test',catalog:'test',build:'test',completed:true,warnings:[],
  duration:2,type:'video/webm;codecs=vp8',bytes:12,seed:[],result:{expected:1,read:1,unidentified:0,experience:null,cards:[{id:'1',name:'카드',awakening:1,extraCopies:2,review:[]}]},
}});
test('single file keeps source bytes, starting settings and original results without full-video reads',async()=>{
 const value=file();value.video.arrayBuffer=()=>{throw Error('must not read full video');};
 const bundle=createReproductionBundle(value),loaded=await openReproduction(bundle,new AbortController().signal);
 assert.equal(await loaded.video.text(),'webm-content');assert.deepEqual(loaded.metadata,value.metadata);
 assert.equal(replaySettings(loaded).source,'screen');assert.equal(replaySettings(loaded).frames.length,0);
});
test('corrupt headers, sizes, settings and appended data are rejected',async()=>{
 const bundle=createReproductionBundle(file());
 await assert.rejects(openReproduction(bundle.slice(0,-1),new AbortController().signal),/잘렸/);
 await assert.rejects(openReproduction(new Blob([bundle,'extra']),new AbortController().signal),/데이터/);
 await assert.rejects(openReproduction(new Blob(['LOACARD-REPLAY1\n']),new AbortController().signal),/잘렸/);
 const invalid=file();invalid.metadata.duration=-1;assert.throws(()=>createReproductionBundle(invalid),/정보/);
 const seed=file();seed.metadata.seed=[{name:'wrong'} as never];assert.throws(()=>createReproductionBundle(seed),/목록/);
 const bad=file();bad.metadata.result!.cards[0].extraCopies=999;assert.throws(()=>createReproductionBundle(bad),/비교 결과/);
});
test('cancelled import never begins replay',async()=>{
 const abort=new AbortController();abort.abort();await assert.rejects(openReproduction(createReproductionBundle(file()),abort.signal),{name:'AbortError'});
});

test('canonical source-use bundles require v4 so older readers cannot silently replay backup frames as acquisitions',async()=>{
 const value=file();value.metadata.version=4;value.exact=new Blob(['canonical']);
 value.metadata.exact={frames:1,events:1,dropped:0,bytes:value.exact.size,peakQueuedBytes:0,peakWorkingBytes:0,
  readbackMs:0,encodeMs:0,complete:true,error:'',canonical:true};
 const loaded=await openReproduction(createReproductionBundle(value),new AbortController().signal);
 assert.equal(loaded.metadata.version,4);assert.equal(loaded.metadata.exact?.canonical,true);
 value.metadata.version=3;assert.throws(()=>createReproductionBundle(value),/무손실/);
 value.metadata.version=4;delete value.metadata.exact.canonical;assert.throws(()=>createReproductionBundle(value),/공통 원본/);
});

test('cancelled storage operations leave the saved diagnostic intact',async()=>{
 const capture=beginReproduction([],{browser:'test',catalog:'test',build:'test'});
 await capture.finish(undefined,false);
 const abort=new AbortController();abort.abort();
 await assert.rejects(loadReproduction(abort.signal),{name:'AbortError'});
 await assert.rejects(loadScanDiagnosticSummary(abort.signal),{name:'AbortError'});
 assert.throws(()=>clearReproduction(abort.signal),{name:'AbortError'});
 assert.ok(await loadScanDiagnosticSummary());
});

test('exact recorder is disposed even when preview cleanup fails',async()=>{
 let disposed=false;
 const exact={finish:async()=>{throw Error('exact unavailable');},dispose:async()=>{disposed=true;}} as unknown as NonNullable<Parameters<typeof beginReproduction>[2]>['exact'];
 const capture=beginReproduction([],{browser:'test',catalog:'test',build:'test'},{record:true,exact});
 capture.options.continuous!({blob:file().video,duration:2,dispose:async()=>{throw Error('preview cleanup');}});
 await assert.rejects(capture.finish(undefined,true),/preview cleanup/);
 assert.equal(disposed,true);
});
test('comparison distinguishes null from zero and tracks missing and changed fields',()=>{
 const before=file().metadata.result!;
 const after={...before,cards:[{...before.cards[0],extraCopies:null},{id:'2',name:'추가',awakening:0,extraCopies:0,review:[]}]};
 assert.deepEqual(compareReproduction(before,after),{added:['추가'],missing:[],changed:['카드']});
 assert.deepEqual(compareReproduction(after,{...before,cards:[]}),{added:[],missing:['카드','추가'],changed:[]});
});
test('each run survives out-of-order completion and deletion blocks late writes without replacing another session',async()=>{
 await clearReproduction();let disposed=0;
 const env={browser:'test',catalog:'test',build:'test'};
 const first=beginReproduction([],env,{record:true}),second=beginReproduction([],env,{record:true});
 first.options.continuous!({blob:file().video,duration:2,dispose:async()=>{disposed++;}});
 second.options.continuous!({blob:new Blob(['latest'],{type:'video/webm'}),duration:3,dispose:async()=>{disposed++;}});
 await second.finish(undefined,true);await first.finish(undefined,false);
 assert.equal(await (await loadReproductionSession(second.id))!.video.text(),'latest');
 assert.equal(await (await loadReproductionSession(first.id))!.video.text(),'webm-content');
 assert.deepEqual(new Set((await listReproductionSessions()).map(item=>item.id)),new Set([first.id,second.id]));assert.equal(disposed,2);
 const third=beginReproduction([],env,{record:true});third.options.continuous!({blob:file().video,duration:2});
 await clearReproduction();assert.equal(await third.finish(undefined,true),undefined);assert.equal(await loadReproduction(),undefined);
});
test('recording failures keep a failed session and diagnostic without fake completed input',async()=>{
 await clearReproduction();
 const capture=beginReproduction([],{browser:'test',catalog:'test',build:'test'},{record:true});
 assert.equal(await capture.finish(undefined,false),undefined);assert.equal(await loadReproduction(),undefined);
 const index=(await listReproductionSessions())[0];assert.equal(index.id,capture.id);assert.equal(index.status,'failed');
 assert.equal(index.hasInput,false);assert.equal((await loadSessionDiagnosticSummary(capture.id))!.completed,false);
});

test('deletion during exact finalization never reports a successfully saved file',async()=>{
 let release!:()=>void,entered!:()=>void;
 const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const finishGate=new Promise<void>(resolve=>{release=resolve;});
 const exact={finish:async()=>{entered();await finishGate;return undefined;},dispose:async()=>{}} as unknown as NonNullable<Parameters<typeof beginReproduction>[2]>['exact'];
 const capture=beginReproduction([],{browser:'test',catalog:'test',build:'test'},{record:true,exact});
 capture.options.continuous!({blob:file().video,duration:2});
 const finalizing=capture.finish(undefined,true);
 await waiting;await clearReproduction();release();
 assert.equal(await finalizing,undefined);
 assert.equal(await loadReproduction(),undefined);assert.equal(await loadScanDiagnosticSummary(),undefined);
});

test('ordinary diagnostics start synchronously without a recorder or captured video and store only a summary',async()=>{
 const capture=beginReproduction([],{browser:'test',catalog:'test',build:'test'});
 assert.equal('then' in capture,false);
 assert.deepEqual(capture.options,{nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION});
 await capture.finish(undefined,false);
 assert.equal(await loadReproduction(),undefined);
 const summary=await loadScanDiagnosticSummary();
 assert.equal(summary?.completed,false);assert.deepEqual(summary?.images,[]);
 assert.equal('seed' in summary!,false);
});

test('recording off persists bounded failure evidence without input or a fabricated replay',async()=>{
 const store=createReproductionSessionStore({dbName:`summary-only-${crypto.randomUUID()}`});
 const state={status:'장수 확인 필요',expected:1,currentRunRead:0,
  cards:[{id:'1',name:'카드',awakening:0,extraCopies:null,review:['장수 확인'],image:'data:image/png;base64,AAAA',time:2}],
  unidentified:Array.from({length:40},(_,i)=>({image:`data:image/png;base64,${'A'.repeat(40_000)}${i}`,reason:'가림',time:i,pending:false})),
  unresolvedFieldChanges:1,
 } as unknown as NonNullable<Parameters<typeof createScanDiagnosticSummary>[0]>;
 const capture=beginReproduction([],{browser:'test',catalog:'test',build:'test'},{record:false,store});
 assert.equal(capture.options.exact,undefined);assert.equal(capture.options.continuous,undefined);
 assert.equal(await capture.finish(state,false),undefined);
 const saved=(await store.getSession(capture.id))!;
 assert.equal(saved.video.size,0);assert.equal(saved.exact?.size??0,0);
 assert.equal(saved.metadata,undefined);
 const summary=saved.summary as ReturnType<typeof createScanDiagnosticSummary>;
 assert.equal(summary.completed,false);assert.equal(summary.unresolvedFieldChanges,1);
 assert.equal(summary.result?.cards[0].extraCopies,null);
 assert.ok(summary.images.length>0&&summary.images.length<=32);
 assert.ok(summary.images.reduce((sum,row)=>sum+row.image.length,0)<=1_048_576);
 assert.equal(summary.unidentifiedObservations?.length,40);
});

test('diagnostic crop bounds exclude source rasters and trace ledgers while preserving unresolved values',()=>{
 const small='data:image/jpeg;base64,AAAA';
 const oversized='data:image/png;base64,'+'A'.repeat(300_000);
 const state={status:'확인 필요',expected:1,currentRunRead:0,
   cards:[{id:'1',name:'카드',awakening:0,extraCopies:null,review:['장수 확인'],image:small,time:1}],
   unidentified:Array.from({length:30},(_,i)=>({image:`data:image/jpeg;base64,${'A'.repeat(90_000)}${i}`,reason:'가림',time:i,pending:false})),
   captureDiagnostics:{samples:[{image:oversized,reason:'가림',time:1,accepted:false}]},ledger:{traces:Array(1000).fill({secret:'raw'})},
 } as unknown as Parameters<typeof createScanDiagnosticSummary>[0];
 const summary=createScanDiagnosticSummary(state,true);
 assert.ok(summary.images.length<=32);
 assert.ok(summary.images.reduce((n,row)=>n+row.image.length,0)<=1_048_576);
 assert.ok(summary.images.every(row=>row.image!==oversized));
 assert.equal(summary.result?.cards[0].extraCopies,null);
 assert.equal('ledger' in summary,false);assert.equal('captureDiagnostics' in summary,false);
});

test('diagnostic image omissions are explicit without retaining rejected pixels or counting duplicates as loss',()=>{
 const small='data:image/png;base64,AAAA',large='data:image/png;base64,'+'A'.repeat(300_000);
 const state={status:'확인 필요',expected:0,currentRunRead:0,cards:[],unidentified:[],
   captureDiagnostics:{samples:[small,small,large,'unavailable'].map(image=>({image,reason:'가림',time:1,accepted:false}))},
 } as unknown as Parameters<typeof createScanDiagnosticSummary>[0];
 const summary=createScanDiagnosticSummary(state,false);
 assert.equal(summary.images.length,1);
 assert.deepEqual(summary.imageRetention,{candidates:4,duplicates:1,limitRejected:1,invalid:1,encodedCharacters:small.length});
 assert.ok(summary.warnings.some(message=>message.includes('1건이 저장 한도로')));
 assert.ok(summary.warnings.some(message=>message.includes('1건의 형식')));
 assert.equal(JSON.stringify(summary).includes(large),false);
});

test('diagnostics retain bounded changed-field debt without inventing card issues or hiding invalid metadata',()=>{
 const state={status:'최신 관측 확인 필요',expected:394,currentRunRead:394,cards:[],unidentified:[],unresolvedFieldChanges:MAX_UNRESOLVED_FIELD_CHANGES} as unknown as NonNullable<Parameters<typeof createScanDiagnosticSummary>[0]>;
 const summary=createScanDiagnosticSummary(state,true);
 assert.equal(summary.unresolvedFieldChanges,MAX_UNRESOLVED_FIELD_CHANGES);
 assert.equal(summary.completed,true,'execution completion remains separate from inventory proof');
 assert.deepEqual(summary.fieldIssues,[]);assert.deepEqual(summary.result?.cards,[]);assert.deepEqual(summary.images,[]);
 assert.equal(createScanDiagnosticSummary({...state,unresolvedFieldChanges:0},true).completed,true);
 for(const invalid of [null,-1,.5,NaN,Infinity,MAX_UNRESOLVED_FIELD_CHANGES+1]){
   const malformed=createScanDiagnosticSummary({...state,unresolvedFieldChanges:invalid} as typeof state,true);
   assert.equal(Object.hasOwn(malformed,'unresolvedFieldChanges'),false);
   assert.equal(malformed.unresolvedFieldChangesUnavailable,true);
   assert.match(malformed.warnings.join(' '),/최신 필드 변경 진단/);
 }
 const accessor=Object.defineProperty({...state},'unresolvedFieldChanges',{get(){throw Error('must not invoke getter');}});
 assert.equal(createScanDiagnosticSummary(accessor,true).unresolvedFieldChangesUnavailable,true);
});

test('all fourteen failed crops keep recognition origins and separate previews within the fixed image byte budget',()=>{
 const failures=Array.from({length:14},(_,index)=>({group:index+1,captureOrder:index+1,time:1,pending:false,reason:'이름 확인 필요',
  image:`data:image/webp;base64,PREVIEW${index}`,recognitionImage:`data:image/png;base64,ACTUAL${index}`,
  source:{sessionId:'scan',frameId:10+index,observationId:`obs-${index}`,captureOrder:index+1,captureTime:1,phase:'recovery',slot:index},
  nameAttempts:[{text:'카드',confidence:0,engine:'paddle',variant:'gray',reason:'OCR 신뢰도 부족',candidates:[{id:'candidate',name:'후보',score:.4}]}],
 }));
 const state={status:'확인 필요',expected:14,currentRunRead:0,cards:[],unidentified:failures} as unknown as Parameters<typeof createScanDiagnosticSummary>[0];
 const summary=createScanDiagnosticSummary(state,true);
 assert.equal(summary.images.length,28);assert.equal(summary.unidentifiedObservations?.length,14);assert.equal(summary.unidentifiedOmitted,0);
 assert.ok(summary.images.reduce((total,image)=>total+image.image.length,0)<=1_048_576);
 assert.ok(summary.images.slice(0,14).every(image=>image.source==='recognition'));
 for(const [index,observation]of summary.unidentifiedObservations!.entries()){
  assert.equal(observation.group,index+1);assert.equal(observation.source?.observationId,`obs-${index}`);
  assert.equal(observation.recognitionImageIndex,index);assert.equal(observation.retainedImageIndex,index+14);
  assert.equal(summary.images[observation.recognitionImageIndex!].image,failures[index].recognitionImage);
  assert.equal(observation.nameAttempts?.[0].confidence,0);assert.equal(observation.nameAttempts?.[0].reason,'OCR 신뢰도 부족');
 }
 assert.doesNotMatch(JSON.stringify(summary.unidentifiedObservations),/data:image/);
});

test('a missing recognition image never loses the failed observation metadata or borrows another same-time image',()=>{
 const image='data:image/webp;base64,AAAA',oversized='data:image/png;base64,'+'B'.repeat(300_000);
 const state={status:'확인 필요',expected:2,currentRunRead:0,cards:[],unidentified:[
  {group:1,captureOrder:1,time:1,pending:false,image,recognitionImage:oversized},
  {group:2,captureOrder:2,time:1,pending:false,image:'data:image/webp;base64,BBBB'},
 ]} as unknown as Parameters<typeof createScanDiagnosticSummary>[0];
 const summary=createScanDiagnosticSummary(state,false);
 assert.equal(summary.unidentifiedObservations?.length,2);assert.equal(summary.unidentifiedOmitted,0);
 assert.equal(summary.unidentifiedObservations![0].recognitionImageIndex,null);
 assert.equal(summary.unidentifiedObservations![1].recognitionImageIndex,null);
 assert.notEqual(summary.unidentifiedObservations![0].retainedImageIndex,summary.unidentifiedObservations![1].retainedImageIndex);
 assert.equal(summary.unidentifiedObservations![1].nameAttempts,null);
 assert.ok(summary.images.every(row=>row.image!==oversized));
});

test('diagnostics preserve latest failed field evidence even when an older valid zero remains',()=>{
 const oldImage='data:image/jpeg;base64,b2xk',latestImage='data:image/jpeg;base64,bmV3';
 const state={status:'1종 판독 확인 필요',expected:1,currentRunRead:0,
   cards:[{id:'1',name:'카드',awakening:0,extraCopies:0,review:['최신 각성·장수 확인'],image:oldImage,time:1}],
   pendingFields:[{id:'1',name:'카드',image:latestImage,time:2,captureOrder:20,
     reason:'최신 각성·장수 확인',countReason:'숫자 영역 가림',stable:false,borderAlignment:.7}],
   unidentified:Array.from({length:20},(_,i)=>({image:`data:image/jpeg;base64,e${i}`,reason:'이름 미확인',time:i,pending:false})),
 } as unknown as Parameters<typeof createScanDiagnosticSummary>[0];
 const summary=createScanDiagnosticSummary(state,true);
 assert.equal(summary.result?.read,0);
 assert.equal(summary.result?.cards[0].extraCopies,0);
 assert.equal(summary.images[0].image,latestImage);
 assert.equal(summary.images[0].time,2);
 assert.match(summary.images[0].reason,/숫자 영역 가림/);
 assert.deepEqual(summary.fieldIssues,[{id:'1',name:'카드',time:2,captureOrder:20,
   reason:'최신 각성·장수 확인',countReason:'숫자 영역 가림',stable:false,borderAlignment:.7}]);
 assert.ok(summary.images.length<=32);
 assert.equal('image' in summary.fieldIssues![0],false);
 assert.equal(state!.cards[0].image,oldImage);
});

test('field diagnostics stay bounded independently of source record size',()=>{
 const oversized='data:image/png;base64,'+'A'.repeat(300_000);
 const state={status:'확인 필요',expected:1,currentRunRead:0,cards:[],unidentified:[],
   pendingFields:Array.from({length:1200},(_,i)=>({id:String(i),name:'카드',image:oversized,time:i,
     reason:'R'.repeat(2000),countReason:'C'.repeat(2000)})),
 } as unknown as Parameters<typeof createScanDiagnosticSummary>[0];
 const summary=createScanDiagnosticSummary(state,true);
 assert.equal(summary.fieldIssues?.length,1000);
 assert.equal(summary.fieldIssues![0].reason.length,300);
 assert.equal(summary.fieldIssues![0].countReason!.length,300);
 assert.equal(summary.images.length,0);
});

test('diagnostics prefer lossless recognition crops and retain numeric proof without embedding image fields',()=>{
 const preview='data:image/jpeg;base64,cHJldmlldw==',raw='data:image/png;base64,cmF3';
 const countDiagnostics={maximum:15,reason:'추가 장수 영역 가림 또는 불명확',iconPresent:false,
   patternOcrAgreed:false,ocrConfirmedValue:0,reliability:'unconfirmed',
   pattern:{value:null,candidate:1,score:.28,gap:.009,reason:'숫자 획과 외곽선 대비 부족'},
   readings:[{engine:'PP-OCRv6 숫자 영역',text:'+1',confidence:69,value:1}],image:'unwanted',trace:['unwanted']};
 const state={status:'확인 필요',expected:1,currentRunRead:0,cards:[],unidentified:[],
   pendingFields:[{id:'1',name:'하누마탄',image:preview,recognitionImage:raw,time:1,reason:'최신 각성·장수 확인',countDiagnostics}],
 } as unknown as Parameters<typeof createScanDiagnosticSummary>[0];
 const summary=createScanDiagnosticSummary(state,true);
 assert.equal(summary.images[0].image,raw);assert.equal(summary.images[0].source,'recognition');
 const field=summary.fieldIssues![0];
 assert.equal(field.countDiagnostics?.iconPresent,false);
 assert.deepEqual(field.countDiagnostics?.pattern,countDiagnostics.pattern);
 assert.deepEqual(field.countDiagnostics?.readings,countDiagnostics.readings);
 assert.equal(field.countDiagnostics?.ocrConfirmedValue,0);
 assert.equal('image' in field,false);assert.equal('recognitionImage' in field,false);
 assert.equal('image' in field.countDiagnostics!,false);assert.equal('trace' in field.countDiagnostics!,false);
 assert.equal(state!.pendingFields![0].image,preview);
 state!.pendingFields![0].recognitionImage='data:image/png;base64,'+'A'.repeat(300_000);
 const fallback=createScanDiagnosticSummary(state,true);
 assert.equal(fallback.images[0].image,preview);assert.equal(fallback.images[0].source,'preview');
});

test('numeric diagnostics have an independent UTF-8 metadata cap and report omitted identities',()=>{
 const state={status:'확인 필요',expected:1,currentRunRead:0,cards:[],unidentified:[],
   pendingFields:Array.from({length:1200},(_,i)=>({id:String(i),name:'이름'.repeat(100),image:'',time:i,
     reason:'가'.repeat(1000),countReason:'나'.repeat(1000),countDiagnostics:{maximum:15,reason:'다'.repeat(1000),
       pattern:{value:null,candidate:1,score:.3,gap:.01,reason:'라'.repeat(1000)},
       readings:Array.from({length:100},()=>({engine:'마'.repeat(1000),text:'바'.repeat(1000),confidence:90,value:1}))}})),
 } as unknown as Parameters<typeof createScanDiagnosticSummary>[0];
 const summary=createScanDiagnosticSummary(state,true);
 assert.ok(summary.fieldIssues!.length>0&&summary.fieldIssues!.length<1000);
 assert.ok(new TextEncoder().encode(JSON.stringify(summary.fieldIssues)).byteLength<=1_048_576);
 assert.equal(summary.fieldIssuesOmitted,1200-summary.fieldIssues!.length);
 assert.equal(summary.fieldIssues![0].countDiagnostics?.readings.length,12);
 assert.equal(summary.images.length,0);
});

test('real JPEG thumbnails in starting inventory survive export and import',async()=>{
 const value=file();value.metadata.seed=[{id:'1',name:'카드',image:'data:image/jpeg;base64,AAAA',awakening:0,extraCopies:15,review:[],confidence:1,observations:1,time:0} as never];
 const loaded=await openReproduction(createReproductionBundle(value),new AbortController().signal);
 assert.equal(loaded.metadata.seed[0].image,value.metadata.seed[0].image);
});

test('v2 lossless payload survives export/import independently of preview video',async()=>{
 const value=file();value.metadata.version=2;value.exact=new Blob(['lossless']);value.metadata.signature='test-hash';value.metadata.exact={frames:2,events:3,dropped:0,bytes:8,peakQueuedBytes:4,peakWorkingBytes:8,readbackMs:1,encodeMs:2,complete:true,error:''};
 value.exact.arrayBuffer=()=>{throw Error('whole archive must not be read');};
 const loaded=await openReproduction(createReproductionBundle(value),new AbortController().signal);
 assert.equal(await loaded.exact!.text(),'lossless');assert.equal(await loaded.video.text(),'webm-content');assert.deepEqual(loaded.metadata,value.metadata);
 value.metadata.exact.bytes++;assert.throws(()=>createReproductionBundle(value),/용량/);
});
