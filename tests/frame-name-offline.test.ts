import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeFrameNames} from '../src/features/card-scanner/recognition/frame-name-offline';
import {InventoryEvidence,hashInventoryEvidence} from '../src/features/card-scanner/session/inventory-evidence';

const source=(slot:number)=>({sessionId:'s',observationId:`${slot+1}`,frameId:7,captureOrder:100+slot,captureTime:1.25,phase:'input' as const,slot});
const receipt=(slot:number)=>({version:1,sessionId:'s',observationId:`${slot+1}`,processingFrame:9,
  acquisitionFrameId:7,canonicalSourceFrameId:null,captureTime:1.25,phase:'input',slot,pixelKey:`p${slot}`,
  sourceWidth:1920,sourceHeight:1080,cropWidth:120,cropHeight:180,
  nominalBox:{x:10,y:20,width:120,height:180},contentBox:{x:10,y:20,width:120,height:180},
  previewBox:{x:10,y:20,width:120,height:180},capture:{stable:true,stabilitySource:'settled-fields',
    complete:true,intact:true,labelVisible:true,borderAlignment:.9,borderSides:[1,1,1,1]},quality:{usable:true,reason:'',sharpness:10}});
function example(){
  const events:{seq:number;type:string;value:unknown}[]=[];
  const add=(type:string,value:unknown)=>events.push({seq:events.length+1,type,value});
  add('inventory-seed',{version:1,cards:[]});
  add('grid-command',{version:1,method:'begin',args:[true]});
  for(let slot=0;slot<40;slot++){
    add('acquisition-capture',receipt(slot));
    add('grid-command',{version:1,method:'group',args:[slot,slot,slot+1,true,null,source(slot)]});
  }
  add('grid-command',{version:1,method:'record',args:[9]});
  add('inventory-event',{version:1,kind:'identity-accepted',source:{...source(0),frame:'f'},id:'a'});
  add('inventory-event',{version:1,kind:'name-confirmed',source:{...source(0),frame:'f'},id:'a'});
  return {version:2 as const,complete:true,dropped:0,events};
}
async function checkpoint(trace:ReturnType<typeof example>){
  const inventory=new InventoryEvidence([]);
  for(const event of trace.events.filter(event=>event.type==='inventory-event'))
    inventory.apply(event.value as Parameters<typeof inventory.apply>[0]);
  trace.events.push({seq:trace.events.length+1,type:'inventory-checkpoint',value:{complete:true,hash:await hashInventoryEvidence(inventory.snapshot())}});
}
test('existing ordered receipts, groups and accepted name facts reproduce a diagnostic projection',async()=>{
  const trace=example(),inventory=new InventoryEvidence([]);
  for(const event of trace.events.filter(event=>event.type==='inventory-event'))
    inventory.apply(event.value as Parameters<typeof inventory.apply>[0]);
  trace.events.push({seq:trace.events.length+1,type:'inventory-checkpoint',value:{complete:true,hash:await hashInventoryEvidence(inventory.snapshot())}});
  const a=await analyzeFrameNames(trace),b=await analyzeFrameNames(trace);
  assert.equal(a.status,'complete');assert.equal(a.inputStatus,'complete');assert.equal(a.frames,1);assert.equal(a.epoch,'unknown');
  assert.equal(a.matchesCapturedState,null);assert.match(a.projectionHash!,/^[a-f0-9]{64}$/);
  assert.equal(a.projectionHash,b.projectionHash);
});
test('recovery facts are counted and prevent a full trace claim while preserving the input-only result',async()=>{
  const trace=example();
  trace.events.push({seq:trace.events.length+1,type:'acquisition-capture',value:{...receipt(0),phase:'recovery'}});
  await checkpoint(trace);
  const result=await analyzeFrameNames(trace);
  assert.equal(result.status,'partial');assert.equal(result.inputStatus,'complete');
  assert.equal(result.reason,'recovery facts are not analyzed');
  assert.equal(result.recoveryReceipts,1);assert.equal(result.recoveryEvents,0);
  assert.equal(result.recoveryCoverage,'not-analyzed');assert.equal(result.inventoryMatch,true);
});
test('legacy recordings without capture receipts are unsupported',async()=>{
  const trace=example();trace.events=trace.events.filter(e=>e.type!=='acquisition-capture');
  assert.equal((await analyzeFrameNames(trace)).status,'unsupported');
});
test('missing receipt and incomplete recordings remain partial',async()=>{
  const trace=example();trace.events=trace.events.filter(e=>!(e.type==='acquisition-capture'&&(e.value as {slot:number}).slot===39));
  assert.equal((await analyzeFrameNames(trace)).status,'partial');
  assert.equal((await analyzeFrameNames({...example(),complete:false})).status,'partial');
  assert.equal((await analyzeFrameNames({...example(),dropped:1})).status,'partial');
  assert.equal((await analyzeFrameNames({...example(),version:1})).status,'partial');
  assert.equal((await analyzeFrameNames(example())).inventoryMatch,null,'missing inventory checkpoint is not a match');
  const bad=example();bad.events.push({seq:bad.events.length+1,type:'inventory-checkpoint',value:{complete:true,hash:'0'.repeat(64)}});
  assert.equal((await analyzeFrameNames(bad)).inventoryMatch,false);
  assert.equal((await analyzeFrameNames(bad)).status,'partial');
});
test('source mismatch, duplicate receipt and reordered events fail',async()=>{
  const mismatch=example();const entry=mismatch.events.find(e=>e.type==='acquisition-capture')!;
  entry.value={...(entry.value as object),captureTime:3};await assert.rejects(()=>analyzeFrameNames(mismatch),/mismatch/);
  const duplicate=example();const first=duplicate.events.findIndex(e=>e.type==='acquisition-capture');
  duplicate.events.splice(first+1,0,{...duplicate.events[first]});duplicate.events.forEach((e,i)=>e.seq=i+1);
  await assert.rejects(()=>analyzeFrameNames(duplicate),/Duplicate/);
  const reorder=example();reorder.events[2].seq=reorder.events[1].seq;
  await assert.rejects(()=>analyzeFrameNames(reorder),/order/);
});

test('name confirmation needs an accepted identity for that exact observation, not only the same card and a later order',async()=>{
  const trace=example(),accepted=trace.events.find(e=>e.type==='inventory-event'&&(e.value as {kind:string}).kind==='identity-accepted')!;
  // InventoryEvidence accepts this because card a has an equal-or-newer order;
  // it does not assert that acceptance and name proof came from the same source.
  accepted.value={version:1,kind:'identity-accepted',source:{...source(1),frame:'f'},id:'a'};
  await checkpoint(trace);
  const result=await analyzeFrameNames(trace);
  assert.equal(result.inventoryMatch,true);
  assert.equal(result.status,'partial');assert.equal(result.unrecordedNames,1);
});

test('a non-admitted duplicate cannot supply an independent name proof',async()=>{
  const trace=example(),group=trace.events.find(e=>e.type==='grid-command'&&(e.value as {method:string}).method==='group')!;
  const cmd=group.value as {version:number;method:string;args:unknown[]};
  group.value={...cmd,args:cmd.args.map((value,index)=>index===3?false:value)};
  await checkpoint(trace);
  const result=await analyzeFrameNames(trace);
  assert.equal(result.inventoryMatch,true);
  assert.equal(result.status,'partial');assert.equal(result.unrecordedNames,1);
});

test('grid trace and source must agree even for non-fresh groups',async()=>{
  const trace=example(),group=trace.events.find(e=>e.type==='grid-command'&&(e.value as {method:string}).method==='group')!;
  const cmd=group.value as {version:number;method:string;args:unknown[]};
  group.value={...cmd,args:cmd.args.map((value,index)=>index===2?42:index===3?false:value)};
  await assert.rejects(()=>analyzeFrameNames(trace),/Grid trace and source mismatch/);
});

test('two cells claiming the same visual group cannot make a complete input analysis',async()=>{
  const trace=example(),groups=trace.events.filter(e=>e.type==='grid-command'&&(e.value as {method:string}).method==='group');
  const cmd=groups[1].value as {version:number;method:string;args:unknown[]};
  groups[1].value={...cmd,args:cmd.args.map((value,index)=>index===1?0:value)};
  await checkpoint(trace);
  const result=await analyzeFrameNames(trace);
  assert.equal(result.inventoryMatch,true);assert.equal(result.inputStatus,'partial');assert.equal(result.groupConflicts,1);
});
