import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ThumbnailSidecar} from '../dev/thumbnail-sidecar';
import {consensus} from '../src/features/card-scanner/recognition/consensus';
import {InventoryEvidence,hashInventoryEvidence} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventorySource,PresentationObservation} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

const image=(part='AAAA')=>`data:image/jpeg;base64,${part}`;
const source=(order=1,change:Partial<InventorySource>={}):InventorySource=>({sessionId:'scan-a',frameId:order,
 observationId:`obs-${order}`,captureOrder:order,captureTime:order/10,phase:'input',slot:0,frame:`frame-${order}`,...change});
const origin=(source:InventorySource):PresentationObservation=>({source,token:Symbol('test-observation')});
const card=(s:InventorySource,change:Partial<ScannedCard>={}):ScannedCard=>({id:'card',name:'카드',awakening:0,extraCopies:0,
 confidence:1,review:[],image:'',time:s.captureTime,observations:1,captureOrder:s.captureOrder,countReliable:true,
 capturePosition:{frame:s.frame,slot:s.slot,stable:true,sort:null},...change});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

test('reducer generation can select an older representative when a newer observation lacks reliable fields',()=>{
 const old=origin(source(1)),newer=origin(source(2)),oldImage=image('T0xE'),newImage=image('TkVX');
 const oldCard=card(old.source,{image:oldImage}),newCard=card(newer.source,{extraCopies:3,countReliable:false,review:['장수 확인'],image:newImage});
 const actual=consensus([oldCard,newCard]);
 assert.equal(actual.image,oldImage,'consensus selects the earlier reliable representative');
 assert.equal(actual.captureOrder,2,'the aggregate capture order does not identify its image source');
 const sidecar=new ThumbnailSidecar({sessionId:'scan-a'});
 const oldTicket=sidecar.register('card',old)!,newTicket=sidecar.register('card',newer)!;
 assert.equal(sidecar.settle(oldTicket,oldImage),true);assert.equal(sidecar.settle(newTicket,newImage),true);
 assert.equal(sidecar.select('card',1,newer),true);assert.equal(sidecar.get('card',1,newer),newImage);
 assert.equal(sidecar.select('card',2,old),true,'newer presentation generation may select an older capture');
 assert.equal(sidecar.get('card',2,old),oldImage);assert.equal(sidecar.get('card',1,newer),undefined);
 assert.equal(sidecar.select('card',1,newer),false,'late old selection cannot override the reducer');
});

test('one generation cannot name two sources even if capture orders coincide',()=>{
 const changed:string[]=[],sidecar=new ThumbnailSidecar({sessionId:'scan-a',onChange:id=>changed.push(id)});
 const first=origin(source(4)),other=origin(source(4,{frameId:40,observationId:'other',frame:'other-frame'}));
 assert.equal(sidecar.settle(sidecar.register('card',first),image()),true);
 assert.equal(sidecar.settle(sidecar.register('card',other),image('QkJC')),true);
 assert.equal(sidecar.select('card',1,first),true);assert.equal(sidecar.get('card',1,first),image());
 assert.equal(sidecar.select('card',1,other),false);assert.equal(sidecar.get('card',1,first),undefined);
 assert.equal(sidecar.select('card',1,first),false,'conflict stays unresolved within the generation');
 assert.equal(sidecar.select('card',2,other),true,'the reducer may choose the other source in a new generation');
 assert.equal(sidecar.get('card',2,other),image('QkJC'));assert.deepEqual(changed,['card','card','card']);
});

test('late image is cached only under its exact source and displayed only if reselected',async()=>{
 const changed:string[]=[],sidecar=new ThumbnailSidecar({sessionId:'scan-a',onChange:id=>changed.push(id)});
 const old=origin(source(1)),newer=origin(source(2)),early=sidecar.register('card',old)!,latest=sidecar.register('card',newer)!;
 const work=deferred<string>();void work.promise.then(value=>sidecar.settle(early,value));
 assert.equal(sidecar.select('card',1,old),true);assert.equal(sidecar.select('card',2,newer),true);
 work.resolve(image('T0xE'));await work.promise;await Promise.resolve();
 assert.equal(sidecar.get('card',2,newer),undefined);assert.deepEqual(changed,[]);
 assert.equal(sidecar.settle(latest,image('TkVX')),true);assert.equal(sidecar.get('card',2,newer),image('TkVX'));
 assert.equal(sidecar.select('card',3,old),true);assert.equal(sidecar.get('card',3,old),image('T0xE'));
 assert.equal(sidecar.settle(early,image('T0xE')),false,'one job cannot settle twice');
 assert.deepEqual(changed,['card','card']);
});

test('unknown or conflicting selection never borrows a thumbnail from another source or card',()=>{
 const sidecar=new ThumbnailSidecar({sessionId:'scan-a'}),a=origin(source(1)),b=origin(source(1,{observationId:'b'}));
 assert.equal(sidecar.settle(sidecar.register('card',a),image()),true);
 assert.equal(sidecar.select('card',1,null),true);assert.equal(sidecar.get('card',1,a),undefined);
 assert.equal(sidecar.select('card',2,b),true);assert.equal(sidecar.get('card',2,b),undefined);
 assert.equal(sidecar.get('other',2,a),undefined);assert.equal(sidecar.get('card',2,a),undefined);
 assert.equal(sidecar.select('card',3,a),true);assert.equal(sidecar.get('card',3,a),image());
});

test('cancellation and session restart reject stale jobs, old selections and malformed inputs',()=>{
 const first=new ThumbnailSidecar({sessionId:'scan-a'}),old=origin(source(1)),oldTicket=first.register('card',old)!;
 assert.equal(first.select('card',1,old),true);first.dispose();first.dispose();
 assert.equal(first.settle(oldTicket,image()),false);assert.equal(first.select('card',2,old),false);
 const next=new ThumbnailSidecar({sessionId:'scan-b'}),current=origin(source(1,{sessionId:'scan-b'}));
 assert.equal(next.register('card',old),null);assert.equal(next.settle(oldTicket,image()),false);
 assert.equal(next.select('card',1,origin(source(2,{sessionId:'scan-b',slot:40}))),false);
 assert.equal(next.select('card',-1,current),false);
 const ticket=next.register('card',current)!;
 for(const value of ['',null,'https://example.test/card.png','data:image/svg+xml;base64,AAAA','data:image/jpeg;base64,<script>'])
  assert.equal(next.settle(ticket,value),false);
 assert.equal(next.settle(ticket,image()),true);assert.equal(next.select('card',1,current),true);
 assert.equal(next.get('card',1,current),image());assert.equal(next.get('card',1,old),undefined);
});

test('entry and byte eviction invalidate tickets but preserve selection generations',()=>{
 const pic=image(),changed:string[]=[],sidecar=new ThumbnailSidecar({sessionId:'scan-a',maxEntries:2,
  maxSelections:2,maxBytes:pic.length*2,maxImageBytes:pic.length*2,onChange:id=>changed.push(id)});
 const a=origin(source(1)),b=origin(source(2)),c=origin(source(3)),one=sidecar.register('one',a)!,two=sidecar.register('two',b)!;
 assert.equal(sidecar.select('one',10,a),true);assert.equal(sidecar.select('two',1,b),true);
 assert.equal(sidecar.settle(one,pic),true);assert.equal(sidecar.settle(two,pic),true);
 assert.equal(sidecar.get('one',10,a),undefined);assert.equal(sidecar.get('two',1,b),pic);
 assert.equal(sidecar.settle(one,pic),false);assert.ok(sidecar.stats().estimatedStringBytes<=pic.length*2);
 assert.equal(sidecar.select('one',9,a),false,'evicting image data never forgets the selection generation');
 assert.equal(sidecar.select('three',1,c),false,'a full selection table fails closed rather than evicting its generation');
 const three=sidecar.register('three',c)!;
 assert.equal(sidecar.settle(three,image('QUFBQUFBQUFB')),false,'oversized image is not retained');
 assert.ok(changed.includes('one'));sidecar.dispose();
 assert.deepEqual(sidecar.stats(),{entries:0,selections:0,estimatedStringBytes:0,closed:true});
});

test('a re-registered evicted source cannot accept the old worker completion',()=>{
 const sidecar=new ThumbnailSidecar({sessionId:'scan-a',maxEntries:1}),old=origin(source(1)),other=origin(source(2));
 const original=sidecar.register('card',old)!;
 assert.equal(sidecar.select('card',1,old),true);
 assert.ok(sidecar.register('card',other),'another job evicts the original');
 const retry=sidecar.register('card',old)!;
 assert.notEqual(retry,original);
 assert.equal(sidecar.settle(original,image('T0xE')),false,'eviction invalidates the original token');
 assert.equal(sidecar.settle(retry,image('TkVX')),true);
 assert.equal(sidecar.get('card',1,old),image('TkVX'));
});

test('distinct reducer observations from the same source cannot swap their asynchronously completed image variants',async()=>{
 const capture=source(1),inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',trackPresentation:true});
 const sidecar=new ThumbnailSidecar({sessionId:'scan-a'}),firstDone=deferred<string>(),secondDone=deferred<string>();
 inventory.acceptIdentity(capture,'card');inventory.confirmName(capture,'card','카드');
 const first=inventory.recordObservation(capture,card(capture,{image:'',confidence:.8}),.9).presentationObservation!;
 const firstSelection=inventory.presentationSelection('card')!,firstTicket=sidecar.register('card',first)!;
 assert.equal(sidecar.select('card',firstSelection.generation,firstSelection.observation),true);
 void firstDone.promise.then(value=>sidecar.settle(firstTicket,value));
 inventory.acceptIdentity(capture,'card');inventory.confirmName(capture,'card','카드');
 const second=inventory.recordObservation(capture,card(capture,{image:'',confidence:.9}),.9).presentationObservation!;
 const secondSelection=inventory.presentationSelection('card')!,secondTicket=sidecar.register('card',second)!;
 assert.deepEqual(first.source,second.source);assert.notEqual(first.token,second.token);
 assert.equal(secondSelection.generation,firstSelection.generation+1);
 assert.equal(sidecar.select('card',secondSelection.generation,secondSelection.observation),true);
 void secondDone.promise.then(value=>sidecar.settle(secondTicket,value));
 firstDone.resolve(image('T0xE'));await firstDone.promise;await Promise.resolve();
 assert.equal(sidecar.get('card',secondSelection.generation,second),undefined,'older variant cannot satisfy the newer token');
 secondDone.resolve(image('TkVX'));await secondDone.promise;await Promise.resolve();
 assert.equal(sidecar.get('card',secondSelection.generation,second),image('TkVX'));
 assert.equal(sidecar.get('card',secondSelection.generation,first),undefined);
 assert.equal(sidecar.register('other',second),null,'one observation token cannot be registered for another card');
 const forged={token:second.token,source:{...second.source,slot:1}};
 assert.equal(sidecar.register('card',forged),null,'a reused token cannot silently change its source');
});

test('optional thumbnail never alters inventory, completion proof or replay hash',async()=>{
 const capture=source(1),initial=card(capture),inventory=new InventoryEvidence([initial],{seedPolicy:'prior-run-v3'});
 const before=await hashInventoryEvidence(inventory.snapshot());
 const sidecar=new ThumbnailSidecar({sessionId:'scan-a',onChange:()=>{throw Error('UI unavailable');}});
 const selected=origin(capture),ticket=sidecar.register('card',selected)!;assert.equal(sidecar.select('card',1,selected),true);
 assert.equal(sidecar.settle(ticket,image()),true);assert.equal(sidecar.get('card',1,selected),image());
 assert.equal(inventory.cards.get('card')?.image,'');assert.equal(await hashInventoryEvidence(inventory.snapshot()),before);
 assert.equal(inventory.confirmedFieldOrder.size,0);assert.equal(inventory.confirmedNameOrder.size,0);
});
