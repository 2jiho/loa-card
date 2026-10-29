import {test} from 'node:test';
import assert from 'node:assert/strict';
import {entryParts,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import {MAX_SCROLL_CAPTURE_FACT_BYTES,parseScrollCaptureFact,parseInventoryHeaderFact} from '../src/features/card-scanner/scroll-capture-diagnostic';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';
import {recordScanGrid,hashScanGridReplay,scanGridReplaySnapshot} from '../src/features/card-scanner/scan-grid-command';
import {InventoryEvidence,serializeInventorySeed,hashInventoryEvidence} from '../src/features/card-scanner/inventory-evidence';
import {InputDecisionReplay} from '../src/features/card-scanner/live-input-decision-replay';
import {UnknownLifecycle,hashUnknownLifecycle} from '../src/features/card-scanner/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../src/features/card-scanner/unknown-lifecycle-types';

const signal=()=>new AbortController().signal;
const source={sessionId:'exact-scroll',processingFrame:9,acquisitionFrameId:7,canonicalSourceFrameId:3,
 observationFrameId:'exact-scroll/8',inputId:11,captureTime:2.5,phase:'input' as const,sourceWidth:1920,sourceHeight:1080};
const scroll=()=>({version:1 as const,source:{...source},state:'measured' as const,
 bar:{x:1700,y:100,width:16,height:942},geometry:{position:.75,pageSpan:4/43},headerFactId:1});
const header=()=>({version:1 as const,factId:1,source:{...source,processingFrame:1,acquisitionFrameId:1,
 canonicalSourceFrameId:1,observationFrameId:'exact-scroll/1',inputId:1,captureTime:0},purpose:'initial' as const,
 headerBox:{x:400,y:80,width:500,height:40},owned:393,capacity:450});
function file(values:{type:string;value:unknown}[]){return new Blob(values.flatMap((value,index)=>entryParts({kind:'event',seq:index+1,time:index/100,...value})));}

test('exact named scroll/header diagnostics validate their strict values and retain unrelated legacy event handling',async()=>{
 const values=[{type:'inventory-header-read',value:header()},{type:'scroll-capture',value:scroll()},
  {type:'legacy-custom-metadata',value:{legacy:true,arbitrary:'unchanged'}}];
 const summary=await executionSummary(file(values),signal(),{complete:true,dropped:0,frames:0,events:values.length});
 assert.equal(summary.events,3);assert.equal(summary.recordingComplete,true);
 assert.deepEqual({...summary.kinds},{'inventory-header-read':1,'scroll-capture':1,'legacy-custom-metadata':1});
 assert.equal(summary.cards.length,0);
 for(const name of ['grid','inventory','input','unknownLifecycle']as const)assert.equal(summary[name].supported,false);
});

test('imported malformed named diagnostics fail exact verification instead of becoming generic trusted metadata',async()=>{
 const bad=[
  {type:'scroll-capture',value:{...scroll(),geometry:{position:.75,pageSpan:0}}},
  {type:'scroll-capture',value:{...scroll(),source:{...source,canonicalSourceFrameId:undefined}}},
  {type:'scroll-capture',value:{...scroll(),source:{...source,observationFrameId:8}}},
  {type:'scroll-capture',value:{...scroll(),state:'queue-full',geometry:scroll().geometry}},
  {type:'scroll-capture',value:{...scroll(),state:'unreadable',geometry:{position:0,pageSpan:4/51}}},
  {type:'scroll-capture',value:{...scroll(),pixels:new Uint8Array([1,2,3])}},
  {type:'inventory-header-read',value:{...header(),capacity:null}},
  {type:'inventory-header-read',value:{...header(),owned:451}},
  {type:'inventory-header-read',value:{...header(),source:{...source,processingFrame:0}}},
  {type:'inventory-header-read',value:{...header(),candidate:'invented-name'}},
 ];
 for(const event of bad)await assert.rejects(executionSummary(file([event]),signal(),{complete:true,dropped:0,frames:0,events:1}),/Invalid scroll\/header capture diagnostic/);
});

test('exact diagnostics accept maximal bounded shapes and reject overbudget added payload without relaxing generic header limits',async()=>{
 const maximal=scroll();maximal.source.sessionId='\ud800'.repeat(160);
 const accepted=parseScrollCaptureFact(maximal),acceptedHeader=parseInventoryHeaderFact({...header(),source:maximal.source});
 for(const value of [accepted,acceptedHeader])assert.ok(new TextEncoder().encode(JSON.stringify(value)).byteLength<=MAX_SCROLL_CAPTURE_FACT_BYTES);
 const values=[{type:'scroll-capture',value:accepted},{type:'inventory-header-read',value:acceptedHeader}];
 assert.equal((await executionSummary(file(values),signal(),{complete:true,dropped:0,frames:0,events:2})).events,2);
 const oversized={...scroll(),image:'x'.repeat(MAX_SCROLL_CAPTURE_FACT_BYTES)};
 // The fixed whitelist rejects this added payload. This does not claim to
 // reach bounded()'s byte guard with an otherwise valid schema: current scalar
 // and identifier limits already keep every admitted shape below that guard.
 assert.ok(new TextEncoder().encode(JSON.stringify(oversized)).byteLength>MAX_SCROLL_CAPTURE_FACT_BYTES);
 await assert.rejects(executionSummary(file([{type:'scroll-capture',value:oversized}]),signal()),/Invalid scroll\/header capture diagnostic/);
});

async function stateEvents():Promise<{type:string;value:unknown}[]>{
 const events:{type:string;value:unknown}[]=[],emit=(type:string,value:unknown)=>{events.push({type,value});};
 const grid=recordScanGrid(new ScanGrid(),command=>emit('grid-command',command));grid.begin(true);grid.geometry(55);
 emit('grid-checkpoint',{complete:true,hash:await hashScanGridReplay(scanGridReplaySnapshot(grid))});
 const inventory=new InventoryEvidence();emit('inventory-seed',serializeInventorySeed([]));
 emit('inventory-checkpoint',{complete:true,hash:await hashInventoryEvidence(inventory.snapshot())});
 const input=new InputDecisionReplay(signal()),stamp={inputId:1,captureTime:2.5,observedAtMs:1000};
 for(const fact of [{kind:'consider',stamp,gates:{capturing:true,checkingCompletion:false},expected:'freeze'},
  {kind:'frozen',stamp,succeeded:true,freezeMs:2}]){input.admission(fact);emit('input-admission',fact);}
 const decisions=[
  {version:1,seq:1,atMs:1002,kind:'offered',inputId:1,captureTime:2.5,observedAtMs:1000},
  {version:1,seq:2,atMs:1003,kind:'started',inputId:1,captureTime:2.5},
  {version:1,seq:3,atMs:1004,kind:'finished',inputId:1,captureTime:2.5,outcome:'completed'},
  {version:1,seq:4,atMs:1005,kind:'released',inputId:1,captureTime:2.5,reason:'normal',failed:false},
 ];
 for(const fact of decisions){input.pipeline(fact);emit('input-decision',fact);if(fact.kind==='started'){
  const link={inputId:1,frameId:7,captureTime:2.5,phase:'input'};input.link(link);emit('input-link',link);}}
 emit('input-checkpoint',{complete:true,hash:(await input.summary()).hash});
 const seed={version:1 as const,sessionId:'exact-scroll',origin:'scan' as const,limits:UNKNOWN_LIFECYCLE_LIMITS};
 emit('unknown-seed',seed);const unknown=new UnknownLifecycle(seed),snapshot=unknown.snapshot();
 emit('unknown-checkpoint',{version:1,complete:true,events:snapshot.facts,hash:await hashUnknownLifecycle(snapshot)});
 return events;
}

test('actual exact event replay ignores valid scroll/header facts for all four supported state hashes',async()=>{
 const base=await stateEvents(),extras=[{type:'scroll-capture',value:parseScrollCaptureFact(scroll())},
  {type:'inventory-header-read',value:parseInventoryHeaderFact(header())}];
 // The header is deliberately recorded after a frame referencing its ID. The
 // diagnostic parser/reducers do not invent chronology, freshness, or state.
 const augmented=[base[0],...extras,...base.slice(1)];
 const replay=async(values:typeof base)=>executionSummary(file(values),signal(),{complete:true,dropped:0,frames:0,events:values.length});
 const a=await replay(base),b=await replay(augmented);
 assert.equal(b.events,a.events+2);assert.equal(b.recordingComplete,true);
 for(const name of ['grid','inventory','input','unknownLifecycle']as const){assert.equal(a[name].supported,true);assert.equal(a[name].matchesCapturedState,true);
  assert.deepEqual(b[name],a[name]);assert.match(a[name].hash!,/^[a-f0-9]{64}$/);}
 assert.deepEqual(b.cards,a.cards);assert.deepEqual(b.observations,a.observations);
});
