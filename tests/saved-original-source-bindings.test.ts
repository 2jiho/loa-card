import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SavedOriginalSourceBindings,saveAcquisition,sourceObservationFrame,
  type SavedAcquisition,type SavedObservation,type OriginalBindingCapability} from '../src/features/card-scanner/acquisition/saved-acquisition';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';

const physical={sourceFrameId:7,captureTime:1,width:100,height:100,hash:'a'.repeat(64)};
const original:ObservationSource={sessionId:'scan',frameId:17,observationId:'original',captureOrder:137,captureTime:1,phase:'input',slot:0};
const recovery:ObservationSource={...original,frameId:99,observationId:'recovery',phase:'recovery'};

function sample(){
 const nominal={x:10,y:10,width:40,height:60},area={x:0,y:0,width:100,height:100};
 const cell={slot:0,content:{...nominal},preview:{x:8,y:8,width:44,height:64},
  intact:true,complete:true,labelVisible:true,alignment:.95,borderSides:[1,1,1,1],quality:{usable:true,reason:'판독 후보',sharpness:1},
  pixelKey:'untrusted-pixel-key',image:{notCloned(){}}} as unknown as Parameters<typeof saveAcquisition>[3][number];
 const saved=saveAcquisition(100,100,{cells:[nominal],area,scale:1} as SavedAcquisition['layout'],[cell],
  {version:1,kind:'measured',...physical,acquisitionFrameId:17});
 const observation:SavedObservation={order:137,frame:sourceObservationFrame('scan',7,17),stable:true};
 saved.observations[0]=observation;
 return {saved,observation,current:{...saved.cells[0],content:{...cell.content},preview:{...cell.preview},
  quality:{...saved.cells[0].quality},borderSides:[...saved.cells[0].borderSides]}};
}

test('a same-session prepared metadata match returns an opaque, revocable original source capability',()=>{
 const {saved,observation,current}=sample(),bindings=new SavedOriginalSourceBindings('scan');
 assert.equal(bindings.bindInput(saved,3,original),true);
 assert.equal(bindings.size,1);
 const token=bindings.matchRecovery(saved,physical,current,recovery);assert.ok(token);
 const claim=bindings.read(token);assert.ok(claim);
 assert.deepEqual(claim.originalSource,original);assert.deepEqual(claim.recoverySource,recovery);
 assert.equal(claim.originalGroup,3);assert.deepEqual(claim.physical,physical);
 assert.equal(claim.scope,'prepared-source-metadata-only');assert.equal(claim.pixelsAuthenticated,false);
 assert.equal(Object.hasOwn(claim,'identity'),false);assert.equal(Object.hasOwn(claim,'image'),false);
 assert.equal(bindings.read(structuredClone(token) as OriginalBindingCapability),undefined);
 assert.equal(bindings.read(JSON.parse(JSON.stringify(token)) as OriginalBindingCapability),undefined);
 // Later identity updates are normal, but cannot themselves create a binding.
 observation.identity={id:'card',name:'카드',confidence:1,review:[]} as SavedObservation['identity'];
 assert.deepEqual(bindings.read(token)?.originalSource,original);
 bindings.release(token);assert.equal(bindings.read(token),undefined);
 bindings.close();assert.equal(bindings.matchRecovery(saved,physical,current,recovery),undefined);
});

test('raw or cloned objects, wrong sessions and input/recovery confusion cannot mint a claim',()=>{
 const {saved,observation,current}=sample(),bindings=new SavedOriginalSourceBindings('scan');
 const clone=structuredClone(saved);
 assert.equal(bindings.bindInput(clone,3,original),false,'JSON-shaped acquisition has no live owner');
 assert.equal(bindings.bindInput(saved,3,{...original,sessionId:'other'}),false);
 assert.equal(bindings.bindInput(saved,3,{...original,phase:'recovery'}),false);
 assert.equal(bindings.bindInput(saved,3,{...original,frameId:18}),false);
 assert.equal(bindings.bindInput(saved,3,{...original,captureTime:2}),false);
 assert.equal(bindings.bindInput(saved,3,{...original,captureOrder:138}),false);
 assert.equal(bindings.bindInput(saved,0,original),false);
 assert.equal(bindings.bindInput(saved,3,original),true);
 for(const changed of [{sessionId:'other'},{phase:'input' as const},{frameId:17},{observationId:'original'},
  {captureOrder:138},{captureTime:2},{slot:1}])
  assert.equal(bindings.matchRecovery(saved,physical,current,{...recovery,...changed}),undefined);
 assert.equal(bindings.matchRecovery(clone,physical,current,recovery),undefined);
 saved.observations[0]={...observation};
 assert.equal(bindings.matchRecovery(saved,physical,current,recovery),undefined,'a cloned observation is not the bound input');
});

test('source id, timestamp, hash, size and both crop geometries must all match',()=>{
 const {saved,current}=sample(),bindings=new SavedOriginalSourceBindings('scan');
 assert.equal(bindings.bindInput(saved,3,original),true);
 for(const changed of [{sourceFrameId:8},{sourceFrameId:undefined},{captureTime:1.1},
  {width:101},{height:101},{hash:'b'.repeat(64)},{hash:undefined},{hash:'invalid'}])
  assert.equal(bindings.matchRecovery(saved,{...physical,...changed},current,recovery),undefined);
 for(const key of ['content','preview'] as const)for(const part of ['x','y','width','height'] as const)
  assert.equal(bindings.matchRecovery(saved,physical,{...current,[key]:{...current[key],[part]:current[key][part]+.5}},recovery),undefined);
 // Equal names or a reused pixel key do not repair different physical inputs.
 saved.observations[0]!.identity={id:'same',name:'같은 이름',confidence:1,review:[]} as SavedObservation['identity'];
 assert.equal(bindings.matchRecovery(saved,{...physical,sourceFrameId:8},current,recovery),undefined);
});

test('a mismatched recovery slot cannot borrow the bound observation through an alias',()=>{
 const {saved,current,observation}=sample(),bindings=new SavedOriginalSourceBindings('scan');
 assert.equal(bindings.bindInput(saved,3,original),true);
 saved.cells[1]={...saved.cells[0],slot:1};saved.observations[1]=observation;
 assert.equal(bindings.matchRecovery(saved,physical,{...current,slot:1},recovery),undefined);
});

test('changed stored provenance, geometry, quality or observation revokes already issued tokens',()=>{
 for(const mutate of [
  (s:SavedAcquisition)=>{s.observations[0]!.order++;},
  (s:SavedAcquisition)=>{s.observations[0]!.frame='other';},
  (s:SavedAcquisition)=>{s.observations[0]!.stable=false;},
  (s:SavedAcquisition)=>{s.cells[0].content.x++;},
  (s:SavedAcquisition)=>{s.cells[0].preview.y++;},
  (s:SavedAcquisition)=>{s.layout!.cells[0].x++;},
  (s:SavedAcquisition)=>{s.layout!.area.width--;},
  (s:SavedAcquisition)=>{s.cells[0].quality.usable=false;},
  (s:SavedAcquisition)=>{s.cells[0].preBorder={kind:'tooltip',reason:'가림'};},
  (s:SavedAcquisition)=>{s.cells[0].quality.reason='changed';},
  (s:SavedAcquisition)=>{s.cells[0].borderSides[0]=.5;},
  (s:SavedAcquisition)=>{s.cells[0].intact=false;},
  (s:SavedAcquisition)=>{s.rasterReceipt={...s.rasterReceipt!,hash:'b'.repeat(64)};},
 ]){
  const {saved,current}=sample(),bindings=new SavedOriginalSourceBindings('scan');
  assert.equal(bindings.bindInput(saved,3,original),true);
  const token=bindings.matchRecovery(saved,physical,current,recovery);assert.ok(token);
  mutate(saved);assert.equal(bindings.read(token),undefined);
 }
});

test('missing receipt, hidden or incomplete cards and pre-existing aliased observations are rejected',()=>{
 for(const mutate of [
  (s:SavedAcquisition)=>{s.rasterReceipt=undefined;},
  (s:SavedAcquisition)=>{s.cells[0].intact=false;},
  (s:SavedAcquisition)=>{s.cells[0].complete=false;},
  (s:SavedAcquisition)=>{s.cells[0].labelVisible=false;},
  (s:SavedAcquisition)=>{s.cells[0].quality.usable=false;},
  (s:SavedAcquisition)=>{s.cells[0].borderSides[0]=NaN;},
 ]){
  const {saved}=sample(),bindings=new SavedOriginalSourceBindings('scan');mutate(saved);
  assert.equal(bindings.bindInput(saved,3,original),false);
 }
 const first=sample(),second=sample(),bindings=new SavedOriginalSourceBindings('scan');
 assert.equal(bindings.bindInput(first.saved,3,original),true);
 second.saved.observations[0]=first.observation;
 assert.equal(bindings.bindInput(second.saved,3,original),false,'a reused object cannot claim a second acquisition');
 bindings.forget(first.saved);
 assert.equal(bindings.bindInput(second.saved,3,original),false,'forgetting does not revive an aliased observation');
});

test('recovery quality must be usable and mutation after matching revokes the capability',()=>{
 for(const mutate of [
  (c:ReturnType<typeof sample>['current'])=>{c.intact=false;},
  (c:ReturnType<typeof sample>['current'])=>{c.complete=false;},
  (c:ReturnType<typeof sample>['current'])=>{c.labelVisible=false;},
  (c:ReturnType<typeof sample>['current'])=>{c.quality.usable=false;},
  (c:ReturnType<typeof sample>['current'])=>{c.preBorder={kind:'tooltip',reason:'가림'};},
  (c:ReturnType<typeof sample>['current'])=>{c.alignment=NaN;},
  (c:ReturnType<typeof sample>['current'])=>{c.borderSides[0]=NaN;},
 ]){
  const {saved,current}=sample(),bindings=new SavedOriginalSourceBindings('scan');
  assert.equal(bindings.bindInput(saved,3,original),true);
  const token=bindings.matchRecovery(saved,physical,current,recovery);assert.ok(token);
  mutate(current);
  assert.equal(bindings.matchRecovery(saved,physical,current,recovery),undefined);
  assert.equal(bindings.read(token),undefined);
 }
});

test('binding and capability budgets fail closed and released sidecars revoke claims',()=>{
 assert.throws(()=>new SavedOriginalSourceBindings('scan',5121));
 assert.throws(()=>new SavedOriginalSourceBindings('scan',1,161));
 const first=sample(),second=sample(),bindings=new SavedOriginalSourceBindings('scan',4,1);
 assert.equal(bindings.bindInput(first.saved,3,original),true);
 assert.equal(bindings.observedSources,1);assert.equal(bindings.remainingBindings,3);
 assert.equal(bindings.bindInput(second.saved,3,original),false,'same observation source cannot bind twice');
 const old=bindings.matchRecovery(first.saved,physical,first.current,recovery);assert.ok(old);
 const latest=bindings.matchRecovery(first.saved,physical,first.current,{...recovery,frameId:100,observationId:'next'});assert.ok(latest);
 assert.equal(bindings.capabilities,1);assert.equal(bindings.read(old),undefined);assert.ok(bindings.read(latest));
 bindings.forget(first.saved);assert.equal(bindings.size,0);assert.equal(bindings.read(latest),undefined);
 assert.equal(bindings.bindInput(second.saved,3,original),false,'forgetting does not permit a source alias');
 assert.equal(bindings.bindInput(second.saved,3,{...original,observationId:'other'}),true);
 assert.equal(bindings.observedSources,4);assert.equal(bindings.remainingBindings,0);
 bindings.forget(second.saved);
 assert.equal(bindings.bindInput(sample().saved,3,{...original,observationId:'third'}),false,'forget does not reset the lifetime bound');
 bindings.close();assert.equal(bindings.size,0);assert.equal(bindings.capabilities,0);
 assert.equal(bindings.bindInput(second.saved,3,original),false);
});

test('input and recovery observation IDs share a bounded session namespace',()=>{
 const first=sample(),second=sample(),bindings=new SavedOriginalSourceBindings('scan',3,4);
 const secondSource={...original,frameId:18,captureOrder:138,captureTime:2,observationId:'second'};
 second.saved.rasterReceipt={...second.saved.rasterReceipt!,acquisitionFrameId:18,captureTime:2};
 second.observation.order=138;second.observation.frame=sourceObservationFrame('scan',7,18);
 assert.equal(bindings.bindInput(first.saved,3,original),true);
 assert.equal(bindings.bindInput(second.saved,4,secondSource),true);
 const firstRecovery=bindings.matchRecovery(first.saved,physical,first.current,recovery);assert.ok(firstRecovery);
 assert.ok(bindings.matchRecovery(first.saved,physical,first.current,recovery),'same recovery can be checked again');
 assert.equal(bindings.matchRecovery(second.saved,{...physical,captureTime:2},second.current,
  {...secondSource,frameId:99,phase:'recovery',observationId:recovery.observationId}),undefined);
 assert.equal(bindings.matchRecovery(first.saved,physical,first.current,{...recovery,observationId:'second'}),undefined);
 assert.equal(bindings.matchRecovery(first.saved,physical,first.current,{...recovery,observationId:'new'}),undefined,'budget covers both phases');
 bindings.forget(first.saved);
 assert.equal(bindings.matchRecovery(second.saved,{...physical,captureTime:2},second.current,
  {...secondSource,frameId:99,phase:'recovery',observationId:recovery.observationId}),undefined);
});

test('an input observation ID cannot be rebound to another physical frame even after forgetting',()=>{
 const first=sample(),second=sample(),bindings=new SavedOriginalSourceBindings('scan',3);
 const changed={...original,frameId:18,captureOrder:138,captureTime:2};
 second.saved.rasterReceipt={...second.saved.rasterReceipt!,acquisitionFrameId:18,captureTime:2};
 second.observation.order=138;
 second.observation.frame=sourceObservationFrame('scan',7,18);
 assert.equal(bindings.bindInput(first.saved,3,original),true);
 assert.equal(bindings.bindInput(second.saved,3,changed),false);
 bindings.forget(first.saved);
 assert.equal(bindings.bindInput(second.saved,3,changed),false,'forgetting must not revive the observation ID');
 assert.equal(bindings.bindInput(second.saved,3,{...changed,observationId:'distinct'}),true);
 assert.equal(bindings.observedSources,2);
});
