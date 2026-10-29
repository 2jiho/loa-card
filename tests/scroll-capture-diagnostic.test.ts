import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {parseScrollCaptureFact,parseInventoryHeaderFact,MAX_SCROLL_CAPTURE_FACT_BYTES,
 SCROLL_CAPTURE_SAMPLE_WIDTH,SCROLL_CAPTURE_SAMPLE_HEIGHT,MIN_SCROLL_CAPTURE_PAGE_SPAN,MAX_SCROLL_CAPTURE_PAGE_SPAN} from '../src/features/card-scanner/scroll-capture-diagnostic';
import {readScrollGeometry} from '../src/features/card-scanner/scroll-position';
import {RunStateTrace,parseRunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';
import {recordScanGrid,hashScanGridReplay,scanGridReplaySnapshot} from '../src/features/card-scanner/scan-grid-command';
import {InventoryEvidence,serializeInventorySeed,hashInventoryEvidence} from '../src/features/card-scanner/inventory-evidence';
import type {InventoryEvent,InventorySource} from '../src/features/card-scanner/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';
import type {ObservationFact} from '../src/features/card-scanner/observation-execution';
import {InputDecisionReplay} from '../src/features/card-scanner/live-input-decision-replay';
import {UnknownLifecycle,hashUnknownLifecycle} from '../src/features/card-scanner/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../src/features/card-scanner/unknown-lifecycle-types';
import type {UnknownSeed,UnknownUpsert} from '../src/features/card-scanner/unknown-lifecycle-types';
import {entryParts,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import type {ExactEvent} from '../src/features/card-scanner/exact-recording-codec';
import {sourceObservationFrame} from '../src/features/card-scanner/saved-acquisition';

const signal=()=>new AbortController().signal;
const json=(value:unknown)=>new Blob([JSON.stringify(value)]);
function source(){return {sessionId:'capture-session',processingFrame:11,acquisitionFrameId:7,canonicalSourceFrameId:3 as number|null,
 observationFrameId:'opaque-observation/29',inputId:101 as number|null,captureTime:1.25,phase:'input' as const,sourceWidth:1920,sourceHeight:1080};}
function scroll(){return {version:1 as const,source:source(),state:'measured' as const,
 bar:{x:1800,y:50,width:16,height:942},geometry:{position:.8123456789,pageSpan:4/43},headerFactId:31 as number|null};}
function header(){return {version:1 as const,factId:31,source:source(),purpose:'initial' as const,
 headerBox:{x:100,y:40,width:850,height:40},owned:393,capacity:450};}
function deeplyFrozen(value:unknown):void{
 if(!value||typeof value!=='object')return;assert.equal(Object.isFrozen(value),true);
 for(const child of Object.values(value))deeplyFrozen(child);
}

test('scroll diagnostics retain unquantized43-range geometry and distinct capture identities',()=>{
 const input=scroll(),parsed=parseScrollCaptureFact(input);
 assert.deepEqual(parsed,input);assert.equal(parsed.geometry?.pageSpan,4/43);assert.equal(parsed.geometry?.position,.8123456789);
 assert.deepEqual([parsed.source.processingFrame,parsed.source.acquisitionFrameId,parsed.source.canonicalSourceFrameId,
  parsed.source.observationFrameId,parsed.source.inputId],[11,7,3,'opaque-observation/29',101]);
 assert.deepEqual(Object.keys(parsed),['version','source','state','bar','geometry','headerFactId']);
 for(const authority of ['row','top','totalRows','capacity','expected','cardId'])assert.equal(Object.hasOwn(parsed,authority),false);
});

test('zero thumb position and capture time stay distinct from unavailable measurement and IDs',()=>{
 const input={...scroll(),source:{...source(),captureTime:0,canonicalSourceFrameId:null,inputId:null},geometry:{position:0,pageSpan:4/51},headerFactId:null};
 const zero=parseScrollCaptureFact(input),unreadable=parseScrollCaptureFact({...input,state:'unreadable',geometry:null});
 assert.equal(zero.geometry?.position,0);assert.equal(zero.source.captureTime,0);assert.equal(zero.source.canonicalSourceFrameId,null);
 assert.equal(zero.source.inputId,null);assert.equal(zero.headerFactId,null);assert.equal(unreadable.geometry,null);
 assert.equal(parseScrollCaptureFact({...input,geometry:{position:1,pageSpan:4/51}}).geometry?.position,1);
 for(const key of ['canonicalSourceFrameId','inputId']as const)for(const value of [undefined,0,-1,1.5])
  assert.throws(()=>parseScrollCaptureFact({...input,source:{...input.source,[key]:value}}));
 for(const value of [undefined,0,-1,1.5])assert.throws(()=>parseScrollCaptureFact({...input,headerFactId:value}));
});

test('measurement state explains missing geometry without inventing a row or raw position',()=>{
 const input=scroll();
 assert.equal(parseScrollCaptureFact({...input,state:'unreadable',geometry:null}).state,'unreadable');
 const clipped=parseScrollCaptureFact({...input,state:'out-of-bounds',bar:{...input.bar,x:-.25},geometry:null});
 assert.equal(clipped.bar?.x,-.25);assert.equal(clipped.geometry,null);
 const missing=parseScrollCaptureFact({...input,state:'not-located',bar:null,geometry:null});
 assert.equal(missing.bar,null);assert.equal(missing.geometry,null);
 for(const patch of [{state:'measured',geometry:null},{state:'measured',bar:null},
  {state:'measured',bar:{...input.bar,x:-1}},{state:'unreadable',bar:{...input.bar,x:-1},geometry:null},
  {state:'unreadable',geometry:input.geometry},{state:'out-of-bounds',bar:input.bar,geometry:null},
  {state:'out-of-bounds',bar:{...input.bar,x:-1},geometry:input.geometry},
  {state:'not-located',bar:input.bar,geometry:null},{state:'not-located',bar:null,geometry:input.geometry}])
  assert.throws(()=>parseScrollCaptureFact({...input,...patch}));
});

test('opaque observation aliases preserve actual sourceObservationFrame strings without deriving numeric identities',()=>{
 for(const alias of [sourceObservationFrame('session/name',undefined,7),sourceObservationFrame('session/name',123,7),'legacy-opaque-alias','7']){
  const input={...source(),observationFrameId:alias};
  assert.equal(parseScrollCaptureFact({...scroll(),source:input}).source.observationFrameId,alias);
  assert.equal(parseInventoryHeaderFact({...header(),source:input}).source.observationFrameId,alias);
 }
 for(const alias of [7,0,null,undefined,'','x'.repeat(161),'bad\nalias']){
  assert.throws(()=>parseScrollCaptureFact({...scroll(),source:{...source(),observationFrameId:alias}}));
  assert.throws(()=>parseInventoryHeaderFact({...header(),source:{...source(),observationFrameId:alias}}));
 }
});

test('queue-full retains an actual box without asserting that the scrollbar was measured or in bounds',()=>{
 for(const bar of [scroll().bar,{...scroll().bar,x:-.25}]){
  const value=parseScrollCaptureFact({...scroll(),state:'queue-full',bar,geometry:null});
  assert.equal(value.state,'queue-full');assert.deepEqual(value.bar,bar);assert.equal(value.geometry,null);
 }
 for(const patch of [{bar:null,geometry:null},{bar:scroll().bar,geometry:scroll().geometry}])
  assert.throws(()=>parseScrollCaptureFact({...scroll(),state:'queue-full',...patch}));
});

test('page-span limits match the actual16x942 strip recipe rather than an inventory row count',()=>{
 assert.equal(SCROLL_CAPTURE_SAMPLE_WIDTH,16);assert.equal(SCROLL_CAPTURE_SAMPLE_HEIGHT,942);
 const measured=(thumb:number)=>{
  const rgba=new Uint8ClampedArray(16*942*4);
  for(const y of [20,20+thumb])for(let x=0;x<16;x++)rgba.set([180,140,20,255],(y*16+x)*4);
  return readScrollGeometry(rgba,16,942);
 };
 const minimum=measured(38),maximum=measured(282);assert.ok(minimum);assert.ok(maximum);
 assert.equal(minimum.pageSpan,MIN_SCROLL_CAPTURE_PAGE_SPAN);assert.equal(maximum.pageSpan,MAX_SCROLL_CAPTURE_PAGE_SPAN);
 for(const geometry of [minimum,maximum,{position:.5,pageSpan:4/43},{position:.5,pageSpan:4/51}])
  assert.deepEqual(parseScrollCaptureFact({...scroll(),geometry}).geometry,geometry);
 for(const pageSpan of [MIN_SCROLL_CAPTURE_PAGE_SPAN-1e-9,MAX_SCROLL_CAPTURE_PAGE_SPAN+1e-9,0,-1,NaN,Infinity,1])
  assert.throws(()=>parseScrollCaptureFact({...scroll(),geometry:{position:0,pageSpan}}));
});

test('successful header observations retain their own asynchronous source and non-authoritative reference',()=>{
 const old={...header(),source:{...source(),processingFrame:2,acquisitionFrameId:4,canonicalSourceFrameId:null,
  observationFrameId:'old-source/1',inputId:null,captureTime:.25},purpose:'ended-capture'};
 const parsed=parseInventoryHeaderFact(old);
 const later=parseScrollCaptureFact({...scroll(),source:{...source(),captureTime:20},headerFactId:parsed.factId});
 assert.deepEqual(parsed.source,old.source);assert.equal(parsed.source.captureTime,.25);
 assert.equal(later.source.captureTime,20);assert.equal(later.headerFactId,31);
 assert.equal(parsed.headerBox.x,100);assert.equal(parsed.owned,393);assert.equal(parsed.capacity,450);
 assert.equal(Object.hasOwn(later,'owned'),false);assert.equal(Object.hasOwn(later,'capacity'),false);
 assert.equal(Object.hasOwn(parsed,'fresh'),false);assert.equal(Object.hasOwn(parsed,'currentFrame'),false);
 for(const purpose of ['initial','auto-completion','ended-capture'])assert.equal(parseInventoryHeaderFact({...old,purpose}).purpose,purpose);
});

test('explicit diagnostic header values keep the current parser range without inferring game capacity',()=>{
 assert.equal(parseInventoryHeaderFact({...header(),owned:0,capacity:450}).owned,0);
 assert.equal(parseInventoryHeaderFact({...header(),owned:2000,capacity:2000}).capacity,2000);
 assert.equal(parseInventoryHeaderFact({...header(),owned:393,capacity:451}).capacity,451);
 for(const patch of [{owned:null},{owned:undefined},{capacity:null},{owned:-1},{owned:1.5},{owned:451,capacity:450},
  {owned:2001,capacity:2001},{capacity:0},{capacity:2001},{capacity:Infinity},{purpose:'failed'},
  {factId:0},{factId:NaN},{headerBox:{x:0,y:0,width:0,height:10}}])assert.throws(()=>parseInventoryHeaderFact({...header(),...patch}));
});

test('fact parsers detach and deeply freeze all borrowed nested objects',()=>{
 const input=scroll(),observed=header(),a=parseScrollCaptureFact(input),b=parseInventoryHeaderFact(observed);
 input.source.captureTime=999;input.bar.x=0;input.geometry.position=0;input.headerFactId=null;
 observed.source.processingFrame=1;observed.headerBox.x=0;observed.owned=0;
 assert.equal(a.source.captureTime,1.25);assert.equal(a.bar?.x,1800);assert.equal(a.geometry?.position,.8123456789);assert.equal(a.headerFactId,31);
 assert.equal(b.source.processingFrame,11);assert.equal(b.headerBox.x,100);assert.equal(b.owned,393);
 assert.notEqual(a.source,input.source);assert.notEqual(a.bar,input.bar);assert.notEqual(b.headerBox,observed.headerBox);
 deeplyFrozen(a);deeplyFrozen(b);assert.throws(()=>Object.assign(a.source,{captureTime:0}),TypeError);
 const nullPrototype=Object.assign(Object.create(null),scroll());assert.deepEqual(parseScrollCaptureFact(nullPrototype),parseScrollCaptureFact(scroll()));
});

test('strict scalar bounds reject malformed dimensions coordinates identities and geometry',()=>{
 const sourcePatches=[{sessionId:''},{sessionId:'x'.repeat(161)},{sessionId:'bad\nidentifier'},{sessionId:'bad\u0085id'},
  {processingFrame:0},{processingFrame:1.1},{acquisitionFrameId:-1},{observationFrameId:0},{inputId:NaN},
  {canonicalSourceFrameId:Number.MAX_SAFE_INTEGER+1},{captureTime:-1},{captureTime:Infinity},{captureTime:NaN},
  {phase:'backup'},{sourceWidth:0},{sourceHeight:1.5},{sourceWidth:65_537,sourceHeight:1},{sourceWidth:65_536,sourceHeight:513}];
 for(const patch of sourcePatches){assert.throws(()=>parseScrollCaptureFact({...scroll(),source:{...source(),...patch}}));
  assert.throws(()=>parseInventoryHeaderFact({...header(),source:{...source(),...patch}}));}
 for(const geometry of [{position:-1e-6,pageSpan:4/51},{position:1.00001,pageSpan:4/51},{position:NaN,pageSpan:4/51},
  {position:Infinity,pageSpan:4/51},{position:'0',pageSpan:4/51}])assert.throws(()=>parseScrollCaptureFact({...scroll(),geometry}));
 for(const bar of [{x:NaN,y:0,width:16,height:20},{x:0,y:Infinity,width:16,height:20},{x:0,y:0,width:0,height:20},
  {x:0,y:0,width:16,height:-1},{x:-65_537,y:0,width:1,height:1}])assert.throws(()=>parseScrollCaptureFact({...scroll(),bar}));
 for(const patch of [{version:'1'},{state:'pending'},{state:undefined},{geometry:undefined},{bar:undefined}])
  assert.throws(()=>parseScrollCaptureFact({...scroll(),...patch}));
});

test('largest supported raster and safe integer identities remain bounded metadata',()=>{
 const maximum={...source(),sessionId:'\ud800'.repeat(160),sourceWidth:65_536,sourceHeight:512,
  processingFrame:Number.MAX_SAFE_INTEGER,acquisitionFrameId:Number.MAX_SAFE_INTEGER,
  canonicalSourceFrameId:Number.MAX_SAFE_INTEGER,observationFrameId:'\ud800'.repeat(160),inputId:Number.MAX_SAFE_INTEGER,
  captureTime:Number.MAX_VALUE};
 const a=parseScrollCaptureFact({...scroll(),source:maximum,bar:{x:0,y:0,width:16,height:512}});
 const b=parseInventoryHeaderFact({...header(),source:maximum,headerBox:{x:-65_536,y:-65_536,width:65_536,height:65_536},factId:Number.MAX_SAFE_INTEGER});
 assert.equal(MAX_SCROLL_CAPTURE_FACT_BYTES,4096);
 for(const value of [a,b])assert.ok(new TextEncoder().encode(JSON.stringify(value)).byteLength<=MAX_SCROLL_CAPTURE_FACT_BYTES);
 assert.throws(()=>parseScrollCaptureFact({...scroll(),source:{...maximum,sessionId:maximum.sessionId+'x'}}));
 assert.throws(()=>parseScrollCaptureFact({...scroll(),padding:'x'.repeat(4096)}));
});

test('unknown fields pixels binary arrays and executable properties are rejected without execution',()=>{
 for(const extra of ['pixels','image','dataUri','layout','cards','expected','row','toJSON']){
  const value=extra==='pixels'?new Uint8Array(1):extra==='cards'?[]:'injected';
  assert.throws(()=>parseScrollCaptureFact({...scroll(),[extra]:value}));assert.throws(()=>parseInventoryHeaderFact({...header(),[extra]:value}));
 }
 assert.throws(()=>parseScrollCaptureFact({...scroll(),source:{...source(),pixels:new ArrayBuffer(1)}}));
 assert.throws(()=>parseScrollCaptureFact({...scroll(),geometry:{...scroll().geometry,rows:47}}));
 assert.throws(()=>parseInventoryHeaderFact({...header(),headerBox:{...header().headerBox,capacity:550}}));
 for(const value of [[],new Date(),Object.assign(new Date(),scroll()),new Uint8Array(1)])assert.throws(()=>parseScrollCaptureFact(value));
 const symbol=scroll();Object.defineProperty(symbol,Symbol('pixels'),{value:new Uint8Array(1)});assert.throws(()=>parseScrollCaptureFact(symbol));
 const hidden=scroll();Object.defineProperty(hidden,'pixels',{value:new Uint8Array(1)});assert.throws(()=>parseScrollCaptureFact(hidden));
 let called=0;
 const accessor=scroll();Object.defineProperty(accessor,'source',{enumerable:true,get(){called++;return source();}});
 assert.throws(()=>parseScrollCaptureFact(accessor));
 const nested=scroll();Object.defineProperty(nested.geometry,'position',{enumerable:true,get(){called++;return 0;}});
 assert.throws(()=>parseScrollCaptureFact(nested));
 const headerAccessor=header();Object.defineProperty(headerAccessor.headerBox,'x',{enumerable:true,get(){called++;return 0;}});
 assert.throws(()=>parseInventoryHeaderFact(headerAccessor));
 const jsonMethod={...scroll(),toJSON(){called++;return scroll();}};assert.throws(()=>parseScrollCaptureFact(jsonMethod));
 assert.equal(called,0);
});

test('compressed trace preserves raw facts and delayed source chronology without sorting or current-frame assumptions',async()=>{
 const trace=new RunStateTrace();try{
  const current=scroll(),old=header(),late={...header(),factId:2,source:{...source(),captureTime:.125,processingFrame:1}};
  assert.equal(trace.record('inventory-header-read',old,1),true);assert.equal(trace.record('scroll-capture',current,2),true);
  assert.equal(trace.record('inventory-header-read',late,3),true);
  old.source.captureTime=100;current.geometry.pageSpan=4/51;
  const parsed=await parseRunStateTrace(await trace.snapshotBlob(),signal());assert.equal(parsed.complete,true);
  assert.deepEqual(parsed.events.map(e=>e.type),['inventory-header-read','scroll-capture','inventory-header-read']);
  const [first,second,last]=parsed.events;
  assert.equal(first.type,'inventory-header-read');assert.equal(second.type,'scroll-capture');assert.equal(last.type,'inventory-header-read');
  if(first.type!=='inventory-header-read'||second.type!=='scroll-capture'||last.type!=='inventory-header-read')throw Error('Expected diagnostic facts');
  assert.equal(first.value.source.captureTime,1.25);assert.equal(second.value.geometry?.pageSpan,4/43);assert.equal(second.value.headerFactId,31);
  assert.equal(last.value.factId,2);assert.equal(last.value.source.captureTime,.125);assert.ok(last.seq>first.seq);
  for(const e of parsed.events)deeplyFrozen(e.value);
 }finally{trace.dispose();}
});

type Fact={type:string;value:unknown};
async function supportedFacts(){
 const facts:Fact[]=[],record=(type:string,value:unknown)=>facts.push({type,value});
 const queued:ObservationFact={version:1,source:{sessionId:'test',frameId:2,observationId:'1',captureOrder:10,captureTime:3.25,phase:'input',slot:0},attemptId:0,kind:'queued'};
 const grid=recordScanGrid(new ScanGrid(),command=>record('grid-command',command));grid.begin(true);grid.geometry(55);record('observation-fact',queued);
 const inventorySource:InventorySource={...queued.source,frame:'frame-a'};
 const card:ScannedCard={id:'card-a',name:'테스트 카드',awakening:1,extraCopies:2,confidence:.99,review:[],image:'',time:3.25,
  observations:1,captureOrder:10,countReliable:true,capturePosition:{frame:'frame-a',slot:0,stable:true,sort:null}};
 const inventory=new InventoryEvidence();record('inventory-seed',serializeInventorySeed([]));
 const inventoryEvents:InventoryEvent[]=[{version:1,kind:'identity-accepted',source:inventorySource,id:'card-a'},
  {version:1,kind:'name-confirmed',source:inventorySource,id:'card-a'},
  {version:1,kind:'observation-recorded',source:inventorySource,card,borderAlignment:.99}];
 for(const value of inventoryEvents){inventory.apply(value);record('inventory-event',value);}
 record('inventory-checkpoint',{complete:true,hash:await hashInventoryEvidence(inventory.snapshot())});
 const input=new InputDecisionReplay(signal()),stamp={inputId:1,captureTime:3.25,observedAtMs:1000};
 for(const value of [{kind:'consider',stamp,gates:{capturing:true,checkingCompletion:false},expected:'freeze'},
  {kind:'frozen',stamp,succeeded:true,freezeMs:2}]){input.admission(value);record('input-admission',value);}
 for(const value of [{version:1,seq:1,atMs:1002,kind:'offered',inputId:1,captureTime:3.25,observedAtMs:1000},
  {version:1,seq:2,atMs:1003,kind:'started',inputId:1,captureTime:3.25},
  {version:1,seq:3,atMs:1004,kind:'finished',inputId:1,captureTime:3.25,outcome:'completed'},
  {version:1,seq:4,atMs:1005,kind:'released',inputId:1,captureTime:3.25,reason:'normal',failed:false}]){
  input.pipeline(value);record('input-decision',value);if(value.kind==='started'){
   const link={inputId:1,frameId:2,captureTime:3.25,phase:'input'};input.link(link);record('input-link',link);}
 }
 record('input-checkpoint',{complete:true,hash:(await input.summary()).hash});
 const seed:UnknownSeed={version:1,sessionId:'test',origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS};record('unknown-seed',seed);
 const unknown=new UnknownLifecycle(seed,{onEvent:value=>record('unknown-event',value)});
 const value:UnknownUpsert={version:1,kind:'upsert',key:{kind:'group',sessionId:'test',group:2},source:queued.source,
  captureOrder:10,captureTime:3.25,pending:false,reason:'이름 확인 필요',location:null};unknown.apply(value);
 const snapshot=unknown.snapshot();record('unknown-checkpoint',{version:1,complete:true,events:snapshot.facts,hash:await hashUnknownLifecycle(snapshot)});
 return {facts,gridHash:await hashScanGridReplay(scanGridReplaySnapshot(grid))};
}

test('diagnostics do not alter four supported reducer hashes or observation state',async()=>{
 const plain=new RunStateTrace(),augmented=new RunStateTrace();try{
  const {facts,gridHash}=await supportedFacts();let at=0;
  const diagnostics=()=>{assert.equal(augmented.record('scroll-capture',scroll(),at),true);assert.equal(augmented.record('inventory-header-read',header(),at),true);};
  diagnostics();for(const fact of facts){assert.equal(plain.record(fact.type,fact.value,at),true);assert.equal(augmented.record(fact.type,fact.value,at++),true);}diagnostics();
  const before=await replayRunStateTrace(await plain.snapshotBlob(),signal()),after=await replayRunStateTrace(await augmented.snapshotBlob(),signal());
  assert.equal(after.events,before.events+4);assert.equal(before.grid.hash,gridHash);
  for(const key of ['grid','inventory','input','unknownLifecycle']as const){assert.equal(before[key].supported,true);assert.deepEqual(after[key],before[key]);assert.match(before[key].hash!,/^[a-f0-9]{64}$/);}
  assert.deepEqual(after.observations,before.observations);assert.equal(after.input.settled,true);
 }finally{plain.dispose();augmented.dispose();}
});

test('generic exact events retain diagnostics while four captured state hashes remain unchanged',async()=>{
 const {facts,gridHash}=await supportedFacts(),base:Fact[]=[...facts,{type:'grid-checkpoint',value:{complete:true,hash:gridHash}}];
 const augmented=[{type:'scroll-capture',value:parseScrollCaptureFact(scroll())},...base,{type:'inventory-header-read',value:parseInventoryHeaderFact(header())}];
 const run=async(values:Fact[])=>{
  const events:ExactEvent[]=values.map(({type,value},i)=>({kind:'event',seq:i+1,time:i/100,type,value}));
  return executionSummary(new Blob(events.flatMap(event=>entryParts(event))),signal(),{complete:true,dropped:0,events:events.length,frames:0});
 };
 const before=await run(base),after=await run(augmented);
 assert.equal(after.events,before.events+2);assert.equal(after.recordingComplete,true);
 assert.equal(after.kinds['scroll-capture'],1);assert.equal(after.kinds['inventory-header-read'],1);
 for(const key of ['grid','inventory','input','unknownLifecycle']as const){assert.equal(before[key].supported,true);assert.equal(before[key].matchesCapturedState,true);assert.deepEqual(after[key],before[key]);}
 assert.deepEqual(after.cards,before.cards);assert.deepEqual(after.observations,before.observations);
});

test('malformed diagnostic recording is partial and cannot manufacture full-state equality',async()=>{
 for(const [type,value]of [['scroll-capture',{...scroll(),geometry:{position:0,pageSpan:NaN}}],
  ['inventory-header-read',{...header(),capacity:null}],['capture-recording-error',{error:'diagnostic callback failed'}]]as const){
  const trace=new RunStateTrace();try{
   assert.equal(trace.record(type,value,0),false);assert.equal(trace.stats.complete,false);assert.equal(trace.stats.dropped,1);
   const blob=await trace.snapshotBlob(),parsed=await parseRunStateTrace(blob,signal());
   assert.equal(parsed.complete,false);assert.equal(parsed.dropped,1);assert.equal(parsed.events.length,0);
   await assert.rejects(replayRunStateTrace(blob,signal()),/불완전/);
  }finally{trace.dispose();}
 }
});

test('malformed externally supplied compressed diagnostics fail strict decoding',async()=>{
 for(const [type,value]of [['scroll-capture',{...scroll(),capacity:550}],['inventory-header-read',{...header(),source:{...source(),inputId:0}}]]){
  const text=JSON.stringify({seq:1,time:0,type,value})+'\n',chunk={bytes:Buffer.byteLength(text),events:1,data:gzipSync(text).toString('base64')};
  await assert.rejects(parseRunStateTrace(json({version:2,codec:'gzip',complete:true,dropped:0,events:1,chunkCount:1,lastSeq:1,chunks:[chunk]}),signal()),/Invalid scroll\/header/);
 }
});

test('legacy traces remain unchanged and never acquire synthetic scroll or header facts',async()=>{
 const trace=new RunStateTrace();try{
  assert.equal(trace.record('grid-command',{version:1,method:'begin',args:[true]},0),true);
  const parsed=await parseRunStateTrace(await trace.snapshotBlob(),signal());assert.equal(parsed.events.length,1);assert.equal(parsed.events[0].type,'grid-command');
  const replay=await replayRunStateTrace(await trace.snapshotBlob(),signal());assert.equal(replay.grid.supported,true);
  for(const key of ['inventory','input','unknownLifecycle']as const)assert.equal(replay[key].supported,false);
 }finally{trace.dispose();}
});
