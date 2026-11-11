import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InventoryEvidence,hashInventoryEvidence,inventoryEventData} from '../src/features/card-scanner/session/inventory-evidence';
import {consensusWithRepresentative} from '../src/features/card-scanner/recognition/consensus';
import type {InventorySeedPolicy,InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

const source=(order:number,change:Partial<InventorySource>={}):InventorySource=>({sessionId:'s',frameId:order,
 observationId:`obs-${order}`,captureOrder:order,captureTime:order/10,phase:'input',slot:0,frame:`frame-${order}`,...change});
const card=(input:InventorySource,change:Partial<ScannedCard>={}):ScannedCard=>({id:'card',name:'카드',awakening:0,extraCopies:2,
 confidence:.9,review:[],image:`data:image/jpeg;base64,${input.frameId}`,time:input.captureTime,observations:1,
 captureOrder:input.captureOrder,capturePosition:{frame:input.frame,slot:input.slot,stable:true,sort:null},countReliable:true,...change});
function record(inventory:InventoryEvidence,input:InventorySource,value=card(input)){
 inventory.acceptIdentity(input,value.id);inventory.confirmName(input,value.id,value.name);
 return inventory.recordObservation(input,value,.9);
}

test('seed has no invented image source and the first appended observation owns a frozen exact source',()=>{
 const seed=card(source(1),{image:'seed-image'}),inventory=new InventoryEvidence([seed],{seedPolicy:'prior-run-v3',trackPresentation:true});
 assert.deepEqual(inventory.presentationSelection('card'),{generation:0,observation:null});
 assert.equal(inventory.latestFieldObservationSource('card'),undefined);
 const input=source(20),change=record(inventory,input),origin=change.presentationObservation!;
 assert.equal(typeof origin.token,'symbol');assert.deepEqual(origin.source,input);assert.notEqual(origin.source,input);
 assert.ok(Object.isFrozen(origin)&&Object.isFrozen(origin.source));
 assert.equal(inventory.presentationSelection('card')?.observation,origin);
 assert.equal(inventory.presentationSelection('card')?.generation,1);
 assert.deepEqual(inventory.latestFieldObservationSource('card'),input);
 (input as {frame:string}).frame='mutated';assert.notEqual(origin.source.frame,input.frame,'the caller cannot mutate retained source');
});

test('sort cloning retains image token and diagnostic source without inventing another generation',()=>{
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true}),input=source(20);
 const change=record(inventory,input),before=inventory.presentationSelection('card')!;
 assert.equal(before.observation,change.presentationObservation);
 assert.equal(inventory.observeSort(input,'card',{kind:'name',direction:'asc'}),true);
 assert.equal(inventory.presentationSelection('card'),before);
 assert.deepEqual(inventory.latestFieldObservationSource('card'),input);
 assert.equal(inventory.observeSort(input,'card',{kind:'name',direction:'asc'}),false);
 assert.equal(inventory.presentationSelection('card'),before);
});

test('duplicate observation does not invent a new preview job, but its replaced diagnostic retains its actual source',()=>{
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true}),first=source(20);
 const created=record(inventory,first),before=inventory.presentationSelection('card')!;
 const retry=source(20,{observationId:'retry'}),duplicate=record(inventory,retry,card(retry));
 assert.equal(duplicate.appended,false);assert.equal(duplicate.presentationObservation,undefined);
 assert.equal(inventory.presentationSelection('card'),before);
 assert.equal(before.observation,created.presentationObservation);
 assert.deepEqual(inventory.latestFieldObservationSource('card'),retry);
});

test('same source and different appended observations have distinct tokens and presentation generations',()=>{
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true}),input=source(20);
 const first=record(inventory,input,card(input,{image:'first',confidence:.8}));
 const a=inventory.presentationSelection('card')!;
 const second=record(inventory,input,card(input,{image:'second',confidence:.9}));
 const b=inventory.presentationSelection('card')!;
 assert.ok(first.appended&&second.appended);assert.notEqual(first.presentationObservation?.token,second.presentationObservation?.token);
 assert.deepEqual(first.presentationObservation?.source,second.presentationObservation?.source);
 assert.equal(a.generation,1);assert.equal(b.generation,2);assert.equal(b.observation,second.presentationObservation);
 assert.equal(inventory.cards.get('card')?.image,'second');
});

test('later reducer decisions can select an older observation without using aggregate capture order as its image source',()=>{
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true}),newer=source(20),older=source(10);
 const first=record(inventory,newer,card(newer,{awakening:2,extraCopies:3,image:'new'}));
 const selected=inventory.presentationSelection('card')!;assert.equal(selected.observation,first.presentationObservation);
 const late=record(inventory,older,card(older,{awakening:1,extraCopies:2,image:'old',manual:['awakening','extraCopies']}));
 const after=inventory.presentationSelection('card')!;
 assert.equal(inventory.cards.get('card')?.image,'old');assert.equal(inventory.cards.get('card')?.captureOrder,20);
 assert.equal(after.generation,2);assert.equal(after.observation,late.presentationObservation);
 assert.deepEqual(after.observation?.source,older);
});

test('an older, nonrepresentative completion returns its own token without changing the current selection',()=>{
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true}),newer=source(20),older=source(10);
 record(inventory,newer,card(newer,{image:'new'}));const before=inventory.presentationSelection('card')!;
 const late=record(inventory,older,card(older,{image:'old'}));
 assert.ok(late.presentationObservation);assert.deepEqual(late.presentationObservation.source,older);
 assert.equal(inventory.presentationSelection('card'),before);assert.equal(inventory.cards.get('card')?.image,'new');
});

test('diagnostic source follows the actual equal-order replacement, including rejected input',()=>{
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true}),first=source(20);
 record(inventory,first);const before=inventory.presentationSelection('card');
 const rejected=source(20,{frameId:21,frame:'other',observationId:'other'});
 const change=inventory.recordObservation(rejected,card(rejected,{image:'other'}),.7);
 assert.equal(change.sourceRejected,true);assert.equal(change.presentationObservation,undefined);
 assert.deepEqual(inventory.latestFieldObservationSource('card'),rejected);
 assert.equal(inventory.presentationSelection('card'),before);
});

test('diagnostic source eviction follows the existing diagnostic bound',()=>{
 const inventory=new InventoryEvidence();
 for(let i=1;i<=1001;i++){
  const input=source(i),value=card(input,{id:`card-${i}`});
  inventory.acceptIdentity(input,value.id);inventory.recordObservation(input,value,.9);
 }
 assert.equal(inventory.latestFieldObservationSource('card-1'),undefined);
 assert.deepEqual(inventory.latestFieldObservationSource('card-1001'),source(1001));
});

test('presentation tracking never changes v1-v4 state hashes, wire events or completion proof',async()=>{
 for(const policy of [undefined,'prior-run','prior-run-v2','prior-run-v3'] as const satisfies readonly (InventorySeedPolicy|undefined)[]){
  const seed=card(source(1),{image:'seed'}),wire:string[][]=[[],[]];
  const plain=new InventoryEvidence([seed],{seedPolicy:policy,onEvent:event=>wire[0].push(JSON.stringify(inventoryEventData(event)))});
  const tracked=new InventoryEvidence([seed],{seedPolicy:policy,trackPresentation:true,onEvent:event=>wire[1].push(JSON.stringify(inventoryEventData(event)))});
  for(const inventory of [plain,tracked]){
   record(inventory,source(20),card(source(20),{image:'twenty'}));
   record(inventory,source(10),card(source(10),{image:'ten',manual:['awakening','extraCopies']}));
  }
  assert.deepEqual(wire[0],wire[1]);
  assert.equal(await hashInventoryEvidence(plain.snapshot()),await hashInventoryEvidence(tracked.snapshot()));
  assert.deepEqual([...plain.confirmedNameOrder],[...tracked.confirmedNameOrder]);
  assert.deepEqual([...plain.confirmedFieldOrder],[...tracked.confirmedFieldOrder]);
  assert.equal(plain.presentationSelection('card'),undefined);
 }
});

test('settling a preview updates only its exact observation without changing evidence or wire events',async()=>{
 const events:string[]=[],inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true,
  onEvent:event=>events.push(JSON.stringify(inventoryEventData(event)))}),input=source(10);
 const change=record(inventory,input,card(input,{image:''})),origin=change.presentationObservation!;
 const before=await hashInventoryEvidence(inventory.snapshot()),wire=events.slice(),selection=inventory.presentationSelection('card');
 assert.equal(inventory.settlePresentationImage('card',origin,'data:image/jpeg;base64,YQ=='),true);
 assert.equal(inventory.cards.get('card')?.image,'data:image/jpeg;base64,YQ==');
 assert.equal(inventory.presentationSelection('card'),selection);
 assert.equal(await hashInventoryEvidence(inventory.snapshot()),before);
 assert.deepEqual(events,wire);
 assert.equal(inventory.settlePresentationImage('card',origin,'data:image/jpeg;base64,Yg=='),false,'settled pixels cannot be replaced');
 assert.equal(inventory.cards.get('card')?.image,'data:image/jpeg;base64,YQ==');
});

test('late preview of an old observation never replaces the selected newer image',()=>{
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true});
 const older=record(inventory,source(10),card(source(10),{image:''})).presentationObservation!;
 const newer=record(inventory,source(20),card(source(20),{image:''})).presentationObservation!;
 const selection=inventory.presentationSelection('card');
 assert.equal(inventory.settlePresentationImage('card',older,'data:image/jpeg;base64,YQ=='),true);
 assert.equal(inventory.cards.get('card')?.image,'');
 assert.equal(inventory.presentationSelection('card'),selection);
 assert.equal(inventory.settlePresentationImage('card',newer,'data:image/jpeg;base64,Yg=='),true);
 assert.equal(inventory.cards.get('card')?.image,'data:image/jpeg;base64,Yg==');
});

test('preview tokens cannot cross scans, cards, or create images for unknown seed origins',()=>{
 const first=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true});
 const origin=record(first,source(10),card(source(10),{image:''})).presentationObservation!;
 const next=new InventoryEvidence([card(source(1),{image:''})],{seedPolicy:'prior-run-v3',trackPresentation:true});
 assert.equal(next.presentationSelection('card')?.observation,null);
 assert.equal(next.settlePresentationImage('card',origin,'data:image/jpeg;base64,YQ=='),false);
 assert.equal(first.settlePresentationImage('other',origin,'data:image/jpeg;base64,YQ=='),false);
 assert.equal(first.settlePresentationImage('card',{...origin},'data:image/jpeg;base64,YQ=='),false);
 assert.equal(first.settlePresentationImage('card',origin,'data:,'),false);
});

test('sort metadata cloning retains the token for delayed preview settlement',()=>{
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true}),input=source(10);
 const origin=record(inventory,input,card(input,{image:''})).presentationObservation!;
 assert.equal(inventory.observeSort(input,'card',{kind:'name',direction:'asc'}),true);
 assert.equal(inventory.settlePresentationImage('card',origin,'data:image/jpeg;base64,YQ=='),true);
 assert.equal(inventory.cards.get('card')?.image,'data:image/jpeg;base64,YQ==');
});

test('a duplicate without an observation token cannot attach a different preview to a blank original',()=>{
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true}),input=source(10);
 const first=record(inventory,input,card(input,{image:''}));
 const duplicate=record(inventory,input,card(input,{image:'data:image/jpeg;base64,Yg=='}));
 assert.equal(duplicate.appended,false);
 assert.equal(duplicate.presentationObservation,undefined);
 assert.equal(inventory.settlePresentationImage('card',duplicate.presentationObservation,'data:image/jpeg;base64,Yg=='),false);
 assert.equal(inventory.cards.get('card')?.image,'','a key or same source does not prove matching crop pixels');
 assert.ok(first.presentationObservation);
});

test('image bytes do not alter representative selection or other consensus fields',()=>{
 const a=source(10),b=source(20),c=source(30);
 const sets=[
  [card(a,{image:'',confidence:.9}),card(b,{image:'',confidence:.9})],
  [card(a,{image:'',confidence:.8,manual:['awakening','extraCopies']}),card(b,{image:'',awakening:2,extraCopies:3})],
  [card(a,{image:'',review:['이름 확인']}),card(b,{image:'',awakening:null,extraCopies:null,countReliable:false}),card(c,{image:'',confidence:.8})],
 ];
 for(const observations of sets)for(let index=0;index<observations.length;index++){
  const before=consensusWithRepresentative(observations);
  const after=consensusWithRepresentative(observations.map((value,i)=>i===index?{...value,image:'data:image/jpeg;base64,YQ=='}:value));
  assert.equal(after.representativeIndex,before.representativeIndex);
  assert.deepEqual({...after.card,image:''},{...before.card,image:''});
  assert.equal(after.card.image,index===before.representativeIndex?'data:image/jpeg;base64,YQ==':before.card.image);
 }
});
