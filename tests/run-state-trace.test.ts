import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {RunStateTrace,parseRunStateTrace,replayRunStateTrace,MAX_RUN_STATE_TRACE_BYTES,MAX_RUN_STATE_TRACE_BLOB_BYTES,
 MAX_RUN_STATE_TRACE_RAW_BYTES,MAX_RUN_STATE_TRACE_PENDING_BYTES,MAX_RUN_STATE_TRACE_EVENTS} from '../dev/run-state-trace';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';
import {recordScanGrid,hashScanGridReplay,scanGridReplaySnapshot} from '../src/features/card-scanner/scan-grid-command';
import {hashObservationExecution} from '../src/features/card-scanner/observation-execution';
import type {ObservationFact} from '../src/features/card-scanner/observation-execution';
import {InventoryEvidence,hashInventoryEvidence,serializeInventorySeed} from '../src/features/card-scanner/inventory-evidence';
import type {InventoryEvent,InventorySource} from '../src/features/card-scanner/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';
import {InputDecisionReplay} from '../src/features/card-scanner/live-input-decision-replay';
import {UnknownLifecycle,hashUnknownLifecycle} from '../src/features/card-scanner/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../src/features/card-scanner/unknown-lifecycle-types';
import type {UnknownSeed,UnknownUpsert} from '../src/features/card-scanner/unknown-lifecycle-types';
import {RunStateCompression} from '../dev/run-state-compression';

const signal=()=>new AbortController().signal;
test('recording availability survives compression without creating recognition evidence',async()=>{
 const trace=new RunStateTrace();
 for(const [index,status] of (['active','disabled','failed'] as const).entries()){
  const fact={status,liveScreen:true};assert.equal(trace.record('recording-availability',fact,index),true);
  fact.liveScreen=false;
 }
 const blob=await trace.snapshotBlob(),parsed=await parseRunStateTrace(blob,signal());
 assert.deepEqual(parsed.events.map(event=>event.value),['active','disabled','failed'].map(status=>({status,liveScreen:true})));
 const replay=await replayRunStateTrace(blob,signal()),empty=await replayRunStateTrace(await new RunStateTrace().snapshotBlob(),signal());
 assert.equal(replay.complete,true);
 for(const key of ['grid','observations','inventory','input','unknownLifecycle','freshness'] as const)assert.deepEqual(replay[key],empty[key]);
});

test('malformed recording availability is rejected and marks the trace incomplete',async()=>{
 for(const value of [{status:'ready',liveScreen:true},{status:'failed',liveScreen:1},{status:'active'},
  {status:'disabled',liveScreen:true,confirmed:true}]){
  const trace=new RunStateTrace();assert.equal(trace.record('recording-availability',value,0),false);
  const parsed=await parseRunStateTrace(await trace.snapshotBlob(),signal());assert.equal(parsed.complete,false);assert.equal(parsed.dropped,1);
 }
});
const queued:ObservationFact={version:1,source:{sessionId:'test',frameId:2,observationId:'1',captureOrder:10,
 captureTime:3.25,phase:'input',slot:0},attemptId:0,kind:'queued'};
const json=(value:unknown)=>new Blob([JSON.stringify(value)]);
const chunk=(text:string,events=1)=>({bytes:Buffer.byteLength(text),events,data:gzipSync(text).toString('base64')});
const compressed=(chunks:ReturnType<typeof chunk>[])=>{
 const events=chunks.reduce((count,value)=>count+value.events,0);
 return {version:2,codec:'gzip',complete:true,dropped:0,events,chunkCount:chunks.length,lastSeq:events,chunks};
};
const inventorySource:InventorySource={...queued.source,frame:'frame-a'};
const inventoryCard:ScannedCard={id:'card-a',name:'테스트 카드',awakening:1,extraCopies:2,
 confidence:0.99,review:[],time:inventorySource.captureTime,observations:1,image:'data:image/png;base64,AAAA',
 captureOrder:inventorySource.captureOrder,countReliable:true,
 capturePosition:{frame:inventorySource.frame,slot:inventorySource.slot,stable:true,sort:null}};
const inventoryFacts:InventoryEvent[]=[
 {version:1,kind:'identity-accepted',source:inventorySource,id:inventoryCard.id},
 {version:1,kind:'name-confirmed',source:inventorySource,id:inventoryCard.id},
 {version:1,kind:'observation-recorded',source:inventorySource,card:inventoryCard,borderAlignment:0.99},
];

const unknownSeed:UnknownSeed={version:1,sessionId:queued.source.sessionId,origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS};
const unknownFact:UnknownUpsert={version:1,kind:'upsert',key:{kind:'group',sessionId:queued.source.sessionId,group:2},
 source:queued.source,captureOrder:queued.source.captureOrder,captureTime:queued.source.captureTime,
 pending:false,reason:'이름 확인 필요',location:{percent:20,column:1,row:2}};

test('clock anchors and backup deferrals preserve active state hashes while retaining their own facts and count',async()=>{
 const plain=new RunStateTrace(),augmented=new RunStateTrace();let clock=0;
 const record=(type:string,value:unknown)=>{assert.equal(plain.record(type,value,clock),true);assert.equal(augmented.record(type,value,clock++),true);};
 const anchor={version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:12345.678};
 assert.equal(augmented.record('scanner-clock',anchor,0.125),true);
 const diagnostic={version:1,reason:'source-capacity',captureTime:3.25,observedAtMs:1000,width:2560,height:1440,pendingBytes:14_745_600};
 const defer=()=>assert.equal(augmented.record('backup-capacity-deferral',diagnostic,clock),true);
 defer();
 const grid=recordScanGrid(new ScanGrid(),command=>record('grid-command',command));grid.begin(true);grid.geometry(55);
 record('observation-fact',queued);
 const inventory=new InventoryEvidence();record('inventory-seed',serializeInventorySeed([]));
 for(const fact of inventoryFacts){inventory.apply(fact);record('inventory-event',fact);}
 record('inventory-checkpoint',{complete:true,hash:await hashInventoryEvidence(inventory.snapshot())});defer();
 const input=new InputDecisionReplay(signal()),stamp={inputId:1,captureTime:3.25,observedAtMs:1000};
 for(const fact of [{kind:'consider',stamp,gates:{capturing:true,checkingCompletion:false},expected:'freeze'},
  {kind:'frozen',stamp,succeeded:true,freezeMs:2}]){input.admission(fact);record('input-admission',fact);}
 const decisions=[
  {version:1,seq:1,atMs:1002,kind:'offered',inputId:1,captureTime:3.25,observedAtMs:1000},
  {version:1,seq:2,atMs:1003,kind:'started',inputId:1,captureTime:3.25},
  {version:1,seq:3,atMs:1004,kind:'finished',inputId:1,captureTime:3.25,outcome:'completed'},
  {version:1,seq:4,atMs:1005,kind:'released',inputId:1,captureTime:3.25,reason:'normal',failed:false},
 ];
 for(const fact of decisions){input.pipeline(fact);record('input-decision',fact);
  if(fact.kind==='started'){const link={inputId:1,frameId:2,captureTime:3.25,phase:'input'};input.link(link);record('input-link',link);}}
 record('input-checkpoint',{complete:true,hash:(await input.summary()).hash});
 record('unknown-seed',unknownSeed);
 const unknown=new UnknownLifecycle(unknownSeed,{onEvent:fact=>record('unknown-event',fact)});unknown.apply(unknownFact);
 const snapshot=unknown.snapshot();record('unknown-checkpoint',{version:1,complete:true,events:snapshot.facts,hash:await hashUnknownLifecycle(snapshot)});defer();
 diagnostic.pendingBytes=0;anchor.originMs=999;
 const plainBlob=await plain.snapshotBlob(),augmentedBlob=await augmented.snapshotBlob(),parsed=await parseRunStateTrace(augmentedBlob,signal());
 const wire=JSON.parse(await augmentedBlob.text());assert.equal(wire.version,2);assert.equal(wire.codec,'gzip');assert.ok(wire.chunks.length);
 const anchors=parsed.events.filter(event=>event.type==='scanner-clock');assert.equal(anchors.length,1);
 assert.deepEqual(anchors[0],{seq:1,time:0.125,type:'scanner-clock',value:{version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:12345.678}});
 assert.ok(Object.isFrozen(anchors[0])&&Object.isFrozen(anchors[0].value));
 assert.equal((await parseRunStateTrace(plainBlob,signal())).events.some(event=>event.type==='scanner-clock'),false,
  'older traces without an anchor remain valid but contain no clock corroboration');
 const deferrals=parsed.events.filter(event=>event.type==='backup-capacity-deferral');assert.equal(deferrals.length,3);
 for(const event of deferrals){assert.equal(event.value.pendingBytes,14_745_600);assert.ok(Object.isFrozen(event.value));
  assert.deepEqual(Object.keys(event.value),['version','reason','captureTime','observedAtMs','width','height','pendingBytes']);}
 const a=await replayRunStateTrace(plainBlob,signal()),b=await replayRunStateTrace(augmentedBlob,signal());
 assert.equal(b.complete,true);assert.equal(b.events,a.events+4);
 for(const key of ['grid','inventory','input','unknownLifecycle']as const){assert.equal(a[key].supported,true);assert.deepEqual(b[key],a[key]);
  const hash=a[key].hash;assert.ok(hash);assert.match(hash,/^[a-f0-9]{64}$/);}
 assert.deepEqual(b.observations,a.observations);
});

test('a zero-origin clock-only trace retains diagnostics without manufacturing state support',async()=>{
 const trace=new RunStateTrace();
 assert.equal(trace.record('scanner-clock',{version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:0},2.5),true);
 const blob=await trace.snapshotBlob(),parsed=await parseRunStateTrace(blob,signal());
 assert.deepEqual(parsed.events,[{seq:1,time:2.5,type:'scanner-clock',value:{version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:0}}]);
 const empty=await replayRunStateTrace(await new RunStateTrace().snapshotBlob(),signal());
 const replay=await replayRunStateTrace(blob,signal());assert.equal(replay.events,1);assert.equal(replay.complete,true);
 for(const key of ['grid','observations','inventory','input','unknownLifecycle'] as const)assert.deepEqual(replay[key],empty[key]);
 const legacy={version:1,complete:true,dropped:0,events:parsed.events};
 assert.deepEqual((await parseRunStateTrace(json(legacy),signal())).events,parsed.events);
});

test('malformed clock diagnostics are rejected on capture and import instead of becoming a clock anchor',async()=>{
 const valid={version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:1000.25};
 for(const payload of [null,[],{},
  {...valid,version:2},{...valid,clock:'unix-ms'},{...valid,phase:'finalization'},
  {...valid,originMs:-1},{...valid,originMs:NaN},{...valid,originMs:Infinity},
  {...valid,originMs:null},{...valid,originMs:'1000.25'},{...valid,pixels:[]},
 ]){
  const trace=new RunStateTrace();assert.equal(trace.record('scanner-clock',payload,0),false);
  assert.equal(trace.stats.events,0);assert.equal(trace.stats.dropped,1);
  await assert.rejects(replayRunStateTrace(await trace.snapshotBlob(),signal()),/불완전/);
  await assert.rejects(parseRunStateTrace(json({version:1,complete:true,dropped:0,
   events:[{seq:1,time:0,type:'scanner-clock',value:payload}]}),signal()));
 }
});

test('clock diagnostic capture rejects getters, hidden extras and inherited fields without executing payload code',()=>{
 const valid={version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:1000};let reads=0;
 const getter={...valid};Object.defineProperty(getter,'originMs',{enumerable:true,get(){reads++;throw Error('must not execute getter');}});
 const hiddenExtra={...valid};Object.defineProperty(hiddenExtra,'pixels',{value:[],enumerable:false});
 const hiddenField={...valid};Object.defineProperty(hiddenField,'originMs',{value:1000,enumerable:false});
 const symbolExtra={...valid,[Symbol('extra')]:true};
 const serializer={...valid,toJSON(){reads++;throw Error('must not execute serializer');}};
 for(const payload of [getter,hiddenExtra,hiddenField,symbolExtra,serializer,Object.create(valid)]){
  const trace=new RunStateTrace();assert.equal(trace.record('scanner-clock',payload,0),false);
  assert.equal(trace.stats.events,0);assert.equal(trace.stats.dropped,1);assert.equal(reads,0);
 }
});

test('clock diagnostics consume the existing event and byte budgets',async()=>{
 const anchor={version:1,clock:'page-performance-now',phase:'input-and-recognition',originMs:1};
 const count=new RunStateTrace({maxEvents:1});assert.equal(count.record('scanner-clock',anchor,0),true);
 const bytes=count.stats.rawBytes;assert.equal(count.record('scanner-clock',anchor,1),false);
 assert.equal(count.stats.events,1);assert.equal(count.stats.rawBytes,bytes);assert.equal(count.stats.dropped,1);
 const tiny=new RunStateTrace({maxRawBytes:1});assert.equal(tiny.record('scanner-clock',anchor,0),false);
 assert.equal(tiny.stats.events,0);assert.equal(tiny.stats.rawBytes,0);assert.equal(tiny.stats.dropped,1);
 assert.equal((await parseRunStateTrace(await count.snapshotBlob(),signal())).events.length,1);
});

test('unknown lifecycle facts share immutable compressed recording and replay the original authority hash',async()=>{
 const trace=new RunStateTrace();trace.record('unknown-seed',unknownSeed,0);
 const core=new UnknownLifecycle(unknownSeed,{onEvent:fact=>{assert.equal(trace.record('unknown-event',fact,1),true);}});
 core.apply(unknownFact);core.apply({...unknownFact,pending:true});
 core.confirmName(unknownFact.key as Extract<UnknownUpsert['key'],{kind:'group'}>,'card-a',queued.source,[]);
 const snapshot=core.snapshot(),hash=await hashUnknownLifecycle(snapshot);
 assert.equal(trace.record('unknown-checkpoint',{version:1,complete:true,events:snapshot.facts,hash},2),true);
 const blob=await trace.snapshotBlob(),parsed=await parseRunStateTrace(blob,signal());
 assert.equal(parsed.events.filter(event=>event.type==='unknown-event').length,3,'covered and tied attempts are recorded too');
 const upsert=parsed.events.find(event=>event.type==='unknown-event'&&event.value.kind==='upsert');
 assert.ok(upsert?.type==='unknown-event'&&upsert.value.kind==='upsert');assert.ok(Object.isFrozen(upsert.value.source));
 const result=await replayRunStateTrace(blob,signal());
 assert.deepEqual(result.unknownLifecycle,{supported:true,events:3,active:0,pending:0,final:0,
  complete:true,hash,expectedHash:hash,matchesCapturedState:true});
 assert.equal(result.grid.supported,false);assert.equal(result.inventory.supported,false);
});

test('unknown trace loss, malformed facts and seed/order faults never manufacture equality',async()=>{
 const malformed=new RunStateTrace();assert.equal(malformed.record('unknown-event',{...unknownFact,image:'extra'},0),false);
 assert.equal(malformed.stats.dropped,1);await assert.rejects(replayRunStateTrace(await malformed.snapshotBlob(),signal()),/불완전/);
 const failed=new RunStateTrace();failed.record('unknown-seed',unknownSeed,0);
 assert.equal(failed.record('unknown-recording-error',{error:'fact-limit'},1),false);
 await assert.rejects(replayRunStateTrace(await failed.snapshotBlob(),signal()),/불완전/);
 const order=new RunStateTrace();order.record('unknown-event',unknownFact,0);order.record('unknown-seed',unknownSeed,1);
 await assert.rejects(replayRunStateTrace(await order.snapshotBlob(),signal()),/시작 상태/);
 const duplicate=new RunStateTrace();duplicate.record('unknown-seed',unknownSeed,0);duplicate.record('unknown-seed',unknownSeed,1);
 await assert.rejects(replayRunStateTrace(await duplicate.snapshotBlob(),signal()),/중복/);
 const legacy=await replayRunStateTrace(await new RunStateTrace().snapshotBlob(),signal());
 assert.equal(legacy.unknownLifecycle.supported,false);assert.equal(legacy.unknownLifecycle.matchesCapturedState,null);
});

test('interleaved live grid commands and lifecycle facts round trip to the same final hashes',async()=>{
 const trace=new RunStateTrace();let clock=0;
 const grid=recordScanGrid(new ScanGrid(fact=>trace.record('observation-fact',fact,clock++)),
  command=>trace.record('grid-command',command,clock++));
 grid.begin(true);grid.geometry(55);
 grid.group(0,1,1,true,1,queued.source);
 grid.group(1,2,2,true,1,{...queued.source,observationId:'2',slot:1,phase:'recovery',captureTime:1.5,captureOrder:5});
 grid.record(2);grid.identify(1,'a');
 const first=grid.start(1);grid.stage(1,'deferred');
 const retry=grid.start(1);grid.finish(1,'review',first);grid.finish(1,'read',retry);grid.finish(1,'review',first);
 grid.finish(2,'review');grid.finish(2,'read');
 grid.liveViewport(4);grid.placeLive([{id:'a',slot:30}],new Map([['a','read']]));
 const expectedGrid=await hashScanGridReplay(scanGridReplaySnapshot(grid));
 const expectedObservations=await hashObservationExecution(grid.executionSnapshot());
 const blob=await trace.snapshotBlob(),parsed=await parseRunStateTrace(blob,signal());
 const wire=JSON.parse(await blob.text());assert.equal(wire.version,2);assert.equal(wire.codec,'gzip');assert.ok(wire.chunks.length);
 assert.equal(parsed.complete,true);assert.equal(parsed.dropped,0);
 assert.ok(parsed.events.some(event=>event.type==='grid-command'));
 assert.ok(parsed.events.some(event=>event.type==='observation-fact'));
 const recovery=parsed.events.find(event=>event.type==='observation-fact'&&event.value.source.phase==='recovery');
 assert.ok(recovery?.type==='observation-fact');assert.equal(recovery.value.source.captureTime,1.5);
 const replay=await replayRunStateTrace(blob,signal());
 assert.equal(replay.grid.hash,expectedGrid);assert.equal(replay.observations.hash,expectedObservations);
 assert.equal(replay.observations.read,2);assert.equal(replay.complete,true);
 assert.equal('events' in replay.grid,false);assert.equal('states' in replay.observations,false);
 assert.deepEqual(await replayRunStateTrace(blob,signal()),replay);
});

test('recorder captures immutable JSON and previous Blobs do not change as recording continues',async()=>{
 const trace=new RunStateTrace();const fact=structuredClone(queued);
 trace.record('observation-fact',fact,1);const before=trace.snapshotBlob();
 (fact.source as {captureTime:number}).captureTime=999;
 trace.record('observation-fact',{...queued,kind:'read-started',attemptId:1},2);
 const early=await parseRunStateTrace(await before,signal()),later=await parseRunStateTrace(await trace.snapshotBlob(),signal());
 assert.equal(early.events.length,1);assert.equal(later.events.length,2);
 const event=early.events[0];assert.ok(event.type==='observation-fact');assert.equal(event.value.source.captureTime,3.25);
 assert.ok(Object.isFrozen(early));assert.ok(Object.isFrozen(early.events));assert.ok(Object.isFrozen(event.value.source));
 assert.equal((await replayRunStateTrace(await before,signal())).observations.waiting,1);
 assert.equal((await replayRunStateTrace(await trace.snapshotBlob(),signal())).observations.reading,1);
});

test('capture payloads are excluded and invalid state facts are explicitly incomplete',async()=>{
 const trace=new RunStateTrace();
 const pixels={get image(){throw Error('must not inspect source pixels');}};
 assert.equal(trace.record('frame',pixels,0),false);
 assert.deepEqual(trace.stats,{events:0,bytes:0,rawBytes:0,compressedBytes:0,pendingBytes:0,peakPendingBytes:0,dropped:0,complete:true,
  compression:{pendingBytes:0,peakPendingBytes:0,active:0,peakActive:0,workerStarts:0,workerTerminations:0,workerJobs:0,nativeJobs:0,disposed:false}});
 assert.equal(trace.record('observation-fact',{...queued,pixels:new Uint8Array(4)},1),false);
 assert.equal(trace.record('grid-command',{version:1,method:'unsupported',args:[]},2),false);
 assert.equal(trace.record('observation-fact',queued,NaN),false);
 assert.equal(trace.record('observation-fact',queued,3),true);
 assert.equal(trace.stats.dropped,3);assert.equal(trace.stats.complete,false);
 const file=await parseRunStateTrace(await trace.snapshotBlob(),signal());assert.equal(file.events[0].seq,4);
 await assert.rejects(replayRunStateTrace(await trace.snapshotBlob(),signal()),/불완전한 상태 기록/);
});

test('count and UTF-8 byte caps report drops without growing retained event data',async()=>{
 const count=new RunStateTrace({maxEvents:1});count.record('observation-fact',queued,0);
 const retained=count.stats.rawBytes;count.record('observation-fact',queued,1);
 assert.equal(count.stats.events,1);assert.equal(count.stats.rawBytes,retained);assert.equal(count.stats.dropped,1);
 const inaccessible={get version(){throw Error('full recorder must skip serialization');}};
 assert.equal(count.record('observation-fact',inaccessible,2),false);assert.equal(count.stats.dropped,2);
 const tiny=new RunStateTrace({maxRawBytes:1});assert.equal(tiny.record('observation-fact',queued,0),false);
 assert.equal(tiny.stats.rawBytes,0);assert.equal(tiny.stats.complete,false);
 const korean={...queued,source:{...queued.source,sessionId:'한글'}};
 const exact=new RunStateTrace();exact.record('observation-fact',korean,0);
 const boundary=new RunStateTrace({maxRawBytes:exact.stats.rawBytes-1});
 assert.equal(boundary.record('observation-fact',korean,0),false,'UTF-8 bytes, not UTF-16 characters, determine the limit');
 const full=new RunStateTrace();for(let i=0;i<20_000;i++)full.record('observation-fact',queued,i);
 assert.ok(full.stats.pendingBytes<=MAX_RUN_STATE_TRACE_PENDING_BYTES);assert.ok(full.stats.dropped>0);
 const blob=await full.snapshotBlob();assert.ok(blob.size<=MAX_RUN_STATE_TRACE_BLOB_BYTES);
 assert.equal(full.stats.pendingBytes,0);assert.ok(full.stats.compressedBytes<=MAX_RUN_STATE_TRACE_BYTES);
 await assert.rejects(replayRunStateTrace(blob,signal()),/불완전한 상태 기록/);
});

test('import rejects oversize, unsupported types, sequence gaps and malformed completeness',async()=>{
 const oversized=new Blob([new Uint8Array(MAX_RUN_STATE_TRACE_BLOB_BYTES+1)]);
 oversized.arrayBuffer=async()=>{throw Error('must reject size before reading');};
 await assert.rejects(parseRunStateTrace(oversized,signal()),/용량 한도/);
 const event={seq:1,time:0,type:'observation-fact',value:queued};
 const valid={version:1,complete:true,dropped:0,events:[event]};
 for(const value of [
  {...valid,version:2},{...valid,extra:true},{...valid,dropped:1},
  {...valid,events:[{...event,type:'pixels'}]}, {...valid,events:[{...event,seq:2}]},
  {...valid,events:[event,event]}, {...valid,events:[{...event,time:-1}]},
  {...valid,events:[{...event,value:{...queued,version:2}}]},
  {...valid,events:Array(100_001).fill(null)},
 ])await assert.rejects(parseRunStateTrace(json(value),signal()));
 await assert.rejects(parseRunStateTrace(new Blob([new Uint8Array([255])]),signal()));
});

test('aborted parsing and replay never publish a successful comparison',async()=>{
 const trace=new RunStateTrace();for(let i=0;i<1000;i++)trace.record('observation-fact',queued,i);
 const blob=await trace.snapshotBlob(),aborted=new AbortController();aborted.abort();
 await assert.rejects(parseRunStateTrace(blob,aborted.signal),{name:'AbortError'});
 await assert.rejects(replayRunStateTrace(blob,aborted.signal),{name:'AbortError'});
 const running=new AbortController(),timer=setTimeout(()=>running.abort(),0);
 try{await assert.rejects(replayRunStateTrace(blob,running.signal),{name:'AbortError'});}
 finally{clearTimeout(timer);}
});

test('an empty selected event boundary is unsupported rather than a manufactured grid replay',async()=>{
 const blob=await new RunStateTrace().snapshotBlob(),wire=JSON.parse(await blob.text());
 assert.deepEqual(wire,{version:2,codec:'gzip',complete:true,dropped:0,events:0,chunkCount:0,lastSeq:0,chunks:[]});
 const result=await replayRunStateTrace(blob,signal());
 assert.equal(result.complete,true);assert.equal(result.events,0);
 assert.deepEqual(result.grid,{supported:false,commands:0,hash:null});
 assert.equal(result.observations.supported,false);assert.equal(result.observations.hash,null);
 assert.deepEqual(result.inventory,{supported:false,events:0,cards:0,hash:null,expectedHash:null,matchesCapturedState:null});
});

test('inventory evidence shares the strict compressed trace and matches an independently captured final hash',async()=>{
 const trace=new RunStateTrace(),inventory=new InventoryEvidence();let time=0;
 assert.equal(trace.record('inventory-seed',serializeInventorySeed([]),time++),true);
 trace.record('observation-fact',queued,time++);
 for(const fact of inventoryFacts){inventory.apply(fact);assert.equal(trace.record('inventory-event',fact,time++),true);}
 // Accepted identity is already current evidence even before field recognition finishes.
 const pending:InventoryEvent={version:1,kind:'identity-accepted',source:{...inventorySource,observationId:'2',frameId:3,
  frame:'frame-b',captureOrder:20,captureTime:4},id:inventoryCard.id};
 inventory.apply(pending);trace.record('inventory-event',pending,time++);
 const expected=await hashInventoryEvidence(inventory.snapshot());
 assert.equal(trace.record('inventory-checkpoint',{complete:true,hash:expected},time++),true);
 const blob=await trace.snapshotBlob(),parsed=await parseRunStateTrace(blob,signal());
 assert.equal(JSON.stringify(parsed).includes('data:image/'),false);
 const observation=parsed.events.find(event=>event.type==='inventory-event'&&event.value.kind==='observation-recorded');
 assert.ok(observation?.type==='inventory-event'&&observation.value.kind==='observation-recorded');
 assert.equal(Object.hasOwn(observation.value.card,'image'),false);
 assert.equal(Object.isFrozen(observation.value.card),true);
 const result=await replayRunStateTrace(blob,signal());
 assert.deepEqual(result.inventory,{supported:true,events:4,cards:1,hash:expected,expectedHash:expected,matchesCapturedState:true});
 assert.equal(result.grid.supported,false);assert.equal(result.observations.supported,true);
 assert.deepEqual(await replayRunStateTrace(blob,signal()),result);
});

test('empty inventory seeds are supported while legacy records and checkpoint-only traces stay unverified',async()=>{
 const trace=new RunStateTrace();trace.record('inventory-seed',{version:1,cards:[]},0);
 const emptyHash=await hashInventoryEvidence(new InventoryEvidence().snapshot());
 const missing=await replayRunStateTrace(await trace.snapshotBlob(),signal());
 assert.deepEqual(missing.inventory,{supported:true,events:0,cards:0,hash:emptyHash,expectedHash:null,matchesCapturedState:null});
 trace.record('inventory-checkpoint',{complete:true,hash:emptyHash},1);
 assert.equal((await replayRunStateTrace(await trace.snapshotBlob(),signal())).inventory.matchesCapturedState,true);
 const checkpoint=new RunStateTrace();checkpoint.record('inventory-checkpoint',{complete:true,hash:emptyHash},0);
 const only=await replayRunStateTrace(await checkpoint.snapshotBlob(),signal());
 assert.equal(only.inventory.supported,false);assert.equal(only.inventory.hash,null);assert.equal(only.inventory.matchesCapturedState,null);
 const legacy=json({version:1,complete:true,dropped:0,events:[{seq:1,time:0,type:'observation-fact',value:queued}]});
 assert.equal((await replayRunStateTrace(legacy,signal())).inventory.supported,false);
});

test('inventory comparison reports mismatch and invalidates older checkpoints on failure or later evidence',async()=>{
 const trace=new RunStateTrace();trace.record('inventory-seed',{version:1,cards:[]},0);
 trace.record('inventory-checkpoint',{complete:true,hash:'0'.repeat(64)},1);
 assert.equal((await replayRunStateTrace(await trace.snapshotBlob(),signal())).inventory.matchesCapturedState,false);
 trace.record('inventory-checkpoint',{complete:false,error:'hash interrupted'},2);
 const failed=await replayRunStateTrace(await trace.snapshotBlob(),signal());
 assert.equal(failed.inventory.expectedHash,null);assert.equal(failed.inventory.matchesCapturedState,null);
 trace.record('inventory-checkpoint',{complete:true,hash:failed.inventory.hash},3);
 trace.record('inventory-event',inventoryFacts[0],4);
 const stale=await replayRunStateTrace(await trace.snapshotBlob(),signal());
 assert.equal(stale.inventory.expectedHash,null);assert.equal(stale.inventory.matchesCapturedState,null);
});

test('malformed inventory facts/checkpoints mark recording incomplete and invalid seed order fails replay',async()=>{
 const trace=new RunStateTrace();
 const invalid:[string,unknown][]=[
  ['inventory-seed',{version:2,cards:[]}],['inventory-event',{...inventoryFacts[0],version:2}],
  ['inventory-checkpoint',{hash:'0'.repeat(64)}],['inventory-checkpoint',{complete:true,hash:'A'.repeat(64)}],
  ['inventory-checkpoint',{complete:false,hash:'0'.repeat(64)}],['inventory-checkpoint',{complete:false,error:'x'.repeat(2001)}],
 ];
 for(const [type,value] of invalid)assert.equal(trace.record(type,value,0),false);
 assert.equal(trace.stats.dropped,invalid.length);assert.equal(trace.stats.complete,false);
 await assert.rejects(replayRunStateTrace(await trace.snapshotBlob(),signal()),/불완전한 상태 기록/);
 const noSeed=new RunStateTrace();noSeed.record('inventory-event',inventoryFacts[0],0);
 await assert.rejects(replayRunStateTrace(await noSeed.snapshotBlob(),signal()),/시작 상태 없이/);
 const duplicate=new RunStateTrace();for(let i=0;i<2;i++)duplicate.record('inventory-seed',{version:1,cards:[]},i);
 await assert.rejects(replayRunStateTrace(await duplicate.snapshotBlob(),signal()),/시작 상태가 중복/);
 const failure=new RunStateTrace();failure.record('inventory-seed',{version:1,cards:[]},0);
 assert.equal(failure.record('input-recording-error',{error:'decision omitted'},1),false);
 assert.equal(failure.stats.complete,false);assert.equal(failure.stats.dropped,1);
 await assert.rejects(replayRunStateTrace(await failure.snapshotBlob(),signal()),/불완전한 상태 기록/);
});

test('input admission, actual selection and worker links round trip through the same capped gzip event stream',async()=>{
 const trace=new RunStateTrace(),input=new InputDecisionReplay(signal());let time=0;
 const admission=[
  {kind:'consider',stamp:{inputId:1,captureTime:3.25,observedAtMs:1000},gates:{capturing:true,checkingCompletion:false},expected:'freeze'},
  {kind:'frozen',stamp:{inputId:1,captureTime:3.25,observedAtMs:1000},succeeded:true,freezeMs:2},
 ];
 for(const fact of admission){input.admission(fact);assert.equal(trace.record('input-admission',fact,time++),true);}
 const decisions=[
  {version:1,seq:1,atMs:1002,kind:'offered',inputId:1,captureTime:3.25,observedAtMs:1000},
  {version:1,seq:2,atMs:1003,kind:'started',inputId:1,captureTime:3.25},
  {version:1,seq:3,atMs:1004,kind:'finished',inputId:1,captureTime:3.25,outcome:'completed'},
  {version:1,seq:4,atMs:1005,kind:'released',inputId:1,captureTime:3.25,reason:'normal',failed:false},
 ];
 for(const fact of decisions){
  input.pipeline(fact);assert.equal(trace.record('input-decision',fact,time++),true);
  if(fact.kind==='started'){
   const link={inputId:1,frameId:2,captureTime:3.25,phase:'input'};
   input.link(link);assert.equal(trace.record('input-link',link,time++),true);
  }
 }
 const captured=await input.summary();trace.record('input-checkpoint',{complete:true,hash:captured.hash},time++);
 const blob=await trace.snapshotBlob(),parsed=await parseRunStateTrace(blob,signal());
 assert.equal(parsed.events.filter(event=>event.type==='input-decision').length,4);
 const replay=await replayRunStateTrace(blob,signal());
 assert.equal(replay.input.hash,captured.hash);assert.equal(replay.input.matchesCapturedState,true);
 assert.equal(replay.input.admission.facts,2);assert.equal(replay.input.pipeline.linked,1);
 assert.equal(replay.inventory.supported,false);assert.equal(replay.observations.supported,false);
 const legacy=await replayRunStateTrace(json({version:1,complete:true,dropped:0,events:[{seq:1,time:0,type:'observation-fact',value:queued}]}),signal());
 assert.equal(legacy.input.supported,false);assert.equal(legacy.input.hash,null);assert.equal(legacy.input.matchesCapturedState,null);
});

test('malformed input facts, decision versions, links and checkpoints are losses rather than ignored event types',async()=>{
 const trace=new RunStateTrace(),invalid:[string,unknown][]=[
  ['input-admission',{kind:'consider',stamp:{inputId:1,captureTime:0,observedAtMs:0},gates:{capturing:true,checkingCompletion:false},image:'pixels'}],
  ['input-decision',{version:2,seq:1,atMs:0,kind:'offered',inputId:1,captureTime:0,observedAtMs:0}],
  ['input-link',{inputId:1,frameId:0,captureTime:0,phase:'input'}],
  ['input-checkpoint',{complete:true,hash:'not-a-hash'}],
 ];
 for(const [type,value] of invalid)assert.equal(trace.record(type,value,0),false);
 assert.equal(trace.stats.dropped,invalid.length);assert.equal(trace.stats.complete,false);
 await assert.rejects(replayRunStateTrace(await trace.snapshotBlob(),signal()),/불완전한 상태 기록/);
});

test('101k events and 60 MiB of source JSON survive former archive caps without expanding the staging limit',async()=>{
 const trace=new RunStateTrace(),grid=new ScanGrid(),events=101_437;
 for(let offset=0;offset<events;offset+=500){
  for(let index=offset;index<Math.min(offset+500,events);index++){
   // Deterministic varying suffixes represent diagnostic text without using
   // private scan data. They prevent gzip from hiding the former 2 MiB cap.
   const reason='observed-card-field/'.repeat(23)+createHash('sha256').update(String(index)).digest('hex');
   const slot=index%40;
   assert.equal(trace.record('grid-command',{version:1,method:'cell',args:[slot,'unknown',reason,null]},index/60),true);
   grid.cell(slot,'unknown',reason);
  }
  // A batch can be captured synchronously; only the diagnostic flush waits.
  assert.ok(trace.stats.pendingBytes>0);
  await trace.snapshotBlob();
 }
 const blob=await trace.snapshotBlob(),stats=trace.stats;
 assert.equal(stats.events,events);assert.equal(stats.complete,true);assert.equal(stats.dropped,0);
 assert.ok(stats.rawBytes>60*1024*1024);assert.ok(stats.rawBytes<=MAX_RUN_STATE_TRACE_RAW_BYTES);
 assert.ok(stats.compressedBytes>2*1024*1024,'the recorded archive crosses the former compressed cap');
 assert.ok(stats.compressedBytes<MAX_RUN_STATE_TRACE_BYTES);assert.equal(stats.pendingBytes,0);
 assert.ok(stats.peakPendingBytes<=MAX_RUN_STATE_TRACE_PENDING_BYTES);assert.ok(blob.size<MAX_RUN_STATE_TRACE_BLOB_BYTES);
 const replay=await replayRunStateTrace(blob,signal());
 assert.equal(replay.events,events);assert.equal(replay.grid.commands,events);
 assert.equal(replay.grid.hash,await hashScanGridReplay(scanGridReplaySnapshot(grid)));
 assert.equal(replay.observations.supported,false);
});

test('a synchronous recognition burst above one MiB queues completely without awaiting compression',async()=>{
 const trace=new RunStateTrace();
 // Deliberately no yield/flush inside this burst: native compression cannot run
 // until capture returns. The old 1 MiB staging cap truncated this prefix.
 for(let index=0;index<5_000;index++)assert.equal(trace.record('observation-fact',queued,index/1000),true);
 const before=trace.stats;
 assert.equal(before.events,5_000);assert.equal(before.dropped,0);assert.equal(before.compressedBytes,0);
 assert.ok(before.pendingBytes>1024*1024);assert.ok(before.pendingBytes<=MAX_RUN_STATE_TRACE_PENDING_BYTES);
 const blob=await trace.snapshotBlob(),wire=JSON.parse(await blob.text());
 assert.equal(wire.complete,true);assert.equal(wire.events,5_000);assert.equal(wire.lastSeq,5_000);
 assert.ok(wire.chunkCount<=14,'128 KiB batches bound native stream setup overhead');
 assert.equal(trace.stats.pendingBytes,0);assert.equal(trace.stats.peakPendingBytes,before.pendingBytes);
 assert.ok(trace.stats.compressedBytes<=MAX_RUN_STATE_TRACE_BYTES);
 const replay=await replayRunStateTrace(blob,signal());assert.equal(replay.events,5_000);
 assert.equal(replay.observations.facts,5_000);assert.equal(replay.observations.observations,1);
});

test('compression failures, output limits and pending overflow are explicit without capture exceptions',async()=>{
 const output=new RunStateTrace({maxBytes:1});
 assert.equal(output.record('observation-fact',queued,0),true,'record only queues work and does not await native compression');
 const blob=await output.snapshotBlob();
 assert.equal(output.stats.complete,false);assert.equal(output.stats.dropped,1);assert.equal(output.stats.events,0);
 assert.equal(output.stats.pendingBytes,0);assert.equal(output.stats.compressedBytes,0);
 await assert.rejects(replayRunStateTrace(blob,signal()),/불완전한 상태 기록/);
 const native=globalThis.CompressionStream;
 try{
  globalThis.CompressionStream=class {constructor(){throw Error('native compression unavailable');}} as typeof CompressionStream;
  const failed=new RunStateTrace();assert.equal(failed.record('observation-fact',queued,0),true);
  const failure=JSON.parse(await (await failed.snapshotBlob()).text());
  assert.equal(failure.complete,false);assert.equal(failure.dropped,1);assert.deepEqual(failure.chunks,[]);
  assert.equal(failed.stats.pendingBytes,0);
 }finally{globalThis.CompressionStream=native;}
 const small=new RunStateTrace({maxPendingBytes:1});assert.equal(small.record('observation-fact',queued,0),false);
 assert.equal(small.stats.pendingBytes,0);assert.equal(small.stats.peakPendingBytes,0);
});

test('snapshot fixes its prefix before awaiting compression and ignores later overflow',async()=>{
 const trace=new RunStateTrace({maxEvents:1});trace.record('observation-fact',queued,0);
 const first=trace.snapshotBlob();assert.equal(trace.record('observation-fact',queued,1),false);
 const [before,after]=await Promise.all([first,trace.snapshotBlob()]);
 assert.equal((await replayRunStateTrace(before,signal())).events,1);
 const firstHeader=JSON.parse(await before.text()),secondHeader=JSON.parse(await after.text());
 assert.equal(firstHeader.complete,true);assert.equal(firstHeader.events,1);assert.equal(firstHeader.chunkCount,1);assert.equal(firstHeader.lastSeq,1);
 assert.equal(secondHeader.complete,false);assert.equal(secondHeader.events,1);assert.equal(secondHeader.chunkCount,1);assert.equal(secondHeader.lastSeq,2);
 await assert.rejects(replayRunStateTrace(after,signal()),/불완전한 상태 기록/);
});

test('compressed imports enforce raw byte/event bounds before inflation and stop zip bombs per chunk',async()=>{
 const line=JSON.stringify({seq:1,time:0,type:'observation-fact',value:queued})+'\n';
 const valid=chunk(line),original=compressed([valid]);
 assert.equal((await replayRunStateTrace(json(original),signal())).observations.waiting,1);
 const bomb=chunk('x'.repeat(2*1024*1024));
 await assert.rejects(parseRunStateTrace(json(compressed([{...bomb,bytes:1}])),signal()),/압축 해제 용량 한도/);
 await assert.rejects(parseRunStateTrace(json(compressed([{...valid,bytes:valid.bytes+1}])),signal()),/크기 불일치/);
 await assert.rejects(parseRunStateTrace(json(compressed([{...valid,events:2}])),signal()),/이벤트 수 불일치/);
 await assert.rejects(parseRunStateTrace(json(compressed([{...valid,data:'!!!!'}])),signal()),/압축 데이터/);
 await assert.rejects(parseRunStateTrace(json(compressed([{...valid,data:valid.data.slice(0,-8)}])),signal()));
 await assert.rejects(parseRunStateTrace(json(compressed([{...valid,bytes:MAX_RUN_STATE_TRACE_PENDING_BYTES+1}])),signal()),/청크 한도/);
 const excessiveChunks=Math.floor(MAX_RUN_STATE_TRACE_RAW_BYTES/MAX_RUN_STATE_TRACE_PENDING_BYTES)+1;
 await assert.rejects(parseRunStateTrace(json(compressed(Array(excessiveChunks).fill({...valid,bytes:MAX_RUN_STATE_TRACE_PENDING_BYTES}))),signal()),/용량 또는 이벤트 한도/);
 await assert.rejects(parseRunStateTrace(json(compressed([{...valid,events:MAX_RUN_STATE_TRACE_EVENTS},valid])),signal()),/이벤트.*(한도|불일치)/);
 await assert.rejects(parseRunStateTrace(json({...original,codec:'deflate'}),signal()),/버전 또는 한도/);
});

test('compressed event sequence validation spans chunks and retains source timestamps',async()=>{
 const event={seq:1,time:9,type:'observation-fact',value:queued};
 const older={...event,seq:2,time:1,value:{...queued,kind:'read-started',attemptId:1}};
 const first=chunk(JSON.stringify(event)+'\n'),second=chunk(JSON.stringify(older)+'\n');
 const parsed=await parseRunStateTrace(json(compressed([first,second])),signal());
 assert.deepEqual(parsed.events.map(value=>value.time),[9,1]);assert.equal(parsed.version,2);
 const replay=await replayRunStateTrace(json(compressed([first,second])),signal());assert.equal(replay.observations.reading,1);
 await assert.rejects(replayRunStateTrace(json(compressed([first,first])),signal()),/이벤트 순서/);
 const unknown=chunk(JSON.stringify({...older,type:'pixels'})+'\n');
 await assert.rejects(replayRunStateTrace(json(compressed([first,unknown])),signal()),/지원하지 않는/);
});

test('missing final no-op chunks are rejected even when the projected grid hash would be unchanged',async()=>{
 const trace=new RunStateTrace();let clock=0;
 const grid=recordScanGrid(new ScanGrid(),command=>trace.record('grid-command',command,clock++));
 grid.begin(true);grid.geometry(55);
 const prefix=trace.snapshotBlob();grid.geometry(55);
 const final=trace.snapshotBlob();
 const [prefixBlob,finalBlob]=await Promise.all([prefix,final]);
 const first=await replayRunStateTrace(prefixBlob,signal()),last=await replayRunStateTrace(finalBlob,signal());
 assert.equal(first.grid.hash,last.grid.hash,'the redundant final command leaves the same state');
 const early=JSON.parse(await prefixBlob.text()),full=JSON.parse(await finalBlob.text());
 assert.equal(early.events,2);assert.equal(early.lastSeq,2);assert.equal(early.chunkCount,1);
 assert.equal(full.events,3);assert.equal(full.lastSeq,3);assert.equal(full.chunkCount,2);
 full.chunks.pop();
 await assert.rejects(parseRunStateTrace(json(full),signal()),/전체 이벤트 또는 청크 수 불일치/);
 await assert.rejects(replayRunStateTrace(json(full),signal()),/전체 이벤트 또는 청크 수 불일치/);
 // Repairing just the chunk count cannot conceal lost events either.
 full.chunkCount=1;
 await assert.rejects(parseRunStateTrace(json(full),signal()),/전체 이벤트 수 불일치/);
 await assert.rejects(replayRunStateTrace(json(full),signal()),/전체 이벤트 수 불일치/);
});

test('compressed prefix totals reject malformed headers and decoded final sequence mismatches',async()=>{
 const event={seq:1,time:0,type:'observation-fact',value:queued};
 const valid=compressed([chunk(JSON.stringify(event)+'\n')]);
 for(const invalid of [
  {...valid,events:0},{...valid,events:2},{...valid,events:-1},{...valid,events:1.5},
  {...valid,chunkCount:0},{...valid,chunkCount:2},{...valid,chunkCount:NaN},
  {...valid,lastSeq:0},{...valid,lastSeq:2},{...valid,lastSeq:-1},
  {...valid,lastSeq:Number.MAX_SAFE_INTEGER+1},
  {...valid,complete:false,dropped:1},
 ]){
  await assert.rejects(parseRunStateTrace(json(invalid),signal()));
  await assert.rejects(replayRunStateTrace(json(invalid),signal()));
 }
 const aboveDeclared={...valid,complete:false,chunks:[chunk(JSON.stringify({...event,seq:2})+'\n')]};
 await assert.rejects(parseRunStateTrace(json(aboveDeclared),signal()),/마지막 순번 불일치/);
 const trace=new RunStateTrace(),empty=trace.snapshotBlob();trace.record('observation-fact',queued,0);
 const later=trace.snapshotBlob();
 const [emptyBlob,laterBlob]=await Promise.all([empty,later]);
 assert.equal((await replayRunStateTrace(emptyBlob,signal())).events,0);
 assert.equal(JSON.parse(await emptyBlob.text()).lastSeq,0);
 assert.equal((await replayRunStateTrace(laterBlob,signal())).events,1);
});

function delayedCompression(){
 const pending:{raw:Uint8Array<ArrayBuffer>;resolve:(bytes:Uint8Array<ArrayBuffer>)=>void;reject:(error:Error)=>void}[]=[];
 const compression=new RunStateCompression({nativeGzip:bytes=>new Promise((resolve,reject)=>pending.push({raw:bytes,resolve,reject}))});
 const finish=(index:number)=>pending[index].resolve(Uint8Array.from(gzipSync(pending[index].raw)));
 return {pending,compression,finish};
}
const compressionTick=()=>new Promise<void>(resolve=>queueMicrotask(resolve));

test('parallel completion keeps chunk order and reserves later results until earlier commits',async()=>{
 const delayed=delayedCompression(),trace=new RunStateTrace({compression:delayed.compression});
 try{
  trace.record('observation-fact',queued,0);const first=trace.snapshotBlob();
  trace.record('observation-fact',queued,1);const second=trace.snapshotBlob();
  trace.record('observation-fact',queued,2);const third=trace.snapshotBlob();
  const reserved=trace.stats.pendingBytes;await compressionTick();assert.equal(delayed.pending.length,2);
  delayed.finish(1);await compressionTick();await compressionTick();
  assert.equal(trace.stats.pendingBytes,reserved,'completed later output cannot bypass the staging bound');
  assert.equal(trace.stats.compressedBytes,0);assert.equal(delayed.pending.length,3);
  delayed.finish(2);delayed.finish(0);
  const [early,middle,last]=await Promise.all([first,second,third]);
  assert.deepEqual((await parseRunStateTrace(last,signal())).events.map(event=>event.seq),[1,2,3]);
  assert.equal((await parseRunStateTrace(early,signal())).events.length,1);
  assert.equal((await parseRunStateTrace(middle,signal())).events.length,2);
  assert.equal(trace.stats.pendingBytes,0);assert.equal(trace.stats.compression.peakActive,2);
 }finally{trace.dispose();}
});

test('aggregate compressed bytes are committed in prefix order after parallel awaits',async()=>{
 const delayed=delayedCompression(),trace=new RunStateTrace({maxBytes:300,compression:delayed.compression});
 try{
  trace.record('observation-fact',queued,0);const first=trace.snapshotBlob();
  trace.record('observation-fact',queued,1);const later=trace.snapshotBlob();await compressionTick();
  const sizes=delayed.pending.map(job=>gzipSync(job.raw).byteLength);
  assert.ok(sizes.every(bytes=>bytes<=300));assert.ok(sizes.reduce((a,b)=>a+b)>300);
  delayed.finish(1);await compressionTick();assert.equal(trace.stats.compressedBytes,0);
  delayed.finish(0);const [prefix,final]=await Promise.all([first,later]);
  assert.equal((await parseRunStateTrace(prefix,signal())).complete,true);
  const partial=await parseRunStateTrace(final,signal());assert.equal(partial.events.length,1);assert.equal(partial.dropped,1);
  assert.equal(trace.stats.compressedBytes,sizes[0]);assert.ok(trace.stats.compressedBytes<=300);
  assert.equal(trace.stats.pendingBytes,0);assert.equal(trace.stats.events,1);
 }finally{trace.dispose();}
});

test('future compression failure cannot invalidate an earlier in-flight snapshot prefix',async()=>{
 const delayed=delayedCompression(),trace=new RunStateTrace({compression:delayed.compression});
 try{
  trace.record('observation-fact',queued,0);const prefix=trace.snapshotBlob();
  trace.record('observation-fact',queued,1);const future=trace.snapshotBlob();await compressionTick();
  delayed.pending[1].reject(Error('later worker failed'));await compressionTick();delayed.finish(0);
  const [early,later]=await Promise.all([prefix,future]);
  assert.equal((await replayRunStateTrace(early,signal())).events,1);
  const partial=await parseRunStateTrace(later,signal());assert.equal(partial.complete,false);assert.equal(partial.dropped,1);
  assert.deepEqual(partial.events.map(event=>event.seq),[1]);assert.equal(trace.stats.pendingBytes,0);
 }finally{trace.dispose();}
});

test('trace disposal makes outstanding compression explicit partial state and stops later records',async()=>{
 const delayed=delayedCompression(),trace=new RunStateTrace({compression:delayed.compression});
 trace.record('observation-fact',queued,0);const snapshot=trace.snapshotBlob();await compressionTick();
 trace.dispose();assert.equal(trace.record('observation-fact',queued,1),false);
 const parsed=await parseRunStateTrace(await snapshot,signal());assert.equal(parsed.complete,false);assert.equal(parsed.dropped,1);
 delayed.finish(0);await compressionTick();assert.equal(trace.stats.pendingBytes,0);assert.equal(trace.stats.events,0);
 assert.equal(trace.stats.compression.disposed,true);assert.equal(trace.stats.dropped,2);
});
