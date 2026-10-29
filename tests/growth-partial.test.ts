import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compareGrowthCandidates,currentBookProgress,type GrowthMaster,type OwnedCard} from '../src/features/growth/optimizer';
import {completeGrowth,undoGrowth} from '../src/features/growth/complete-growth';
import type {ScannerState} from '../src/features/card-scanner/scanner';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

const full:GrowthMaster=JSON.parse(readFileSync(new URL('../public/growth/master.json',import.meta.url),'utf8'));
const only=(id:string):GrowthMaster=>{const book=full.books.find(b=>b.id===id)!;return {...full,books:[book],cards:full.cards.filter(c=>book.cardIds.includes(c.id))};};
const own=(id:string,awakening=0):OwnedCard=>({id,awakening,extraCopies:15-awakening*(awakening+1)/2,review:[],countReliable:true});

test('real two-of-three collection effect activates and requires only the missing required registration',()=>{
 const master=only('257'),ids=master.books[0].cardIds;
 const cards=ids.slice(0,2).map(id=>({...own(id),extraCopies:0}));
 const p=currentBookProgress(master,cards);
 assert.equal(p.targets.find(t=>t.id==='132')?.current,20);
 assert.equal(p.targets.find(t=>t.id==='126')?.current,0);
 assert.equal(compareGrowthCandidates({master,cards,target:'132',xp:0}).collectionCandidates.length,0);
 const steps=compareGrowthCandidates({master,cards:cards.slice(0,1),target:'132',xp:0}).collectionCandidates;
 assert.equal(steps.length,1);assert.equal(steps[0].cards.length,1);
 assert.equal(steps[0].missingCopies,1);assert.equal(steps[0].available.missingCopies,1);
 assert.equal(steps[0].xp,0);assert.equal(steps[0].gain,20);
});

test('real six-of-seven awakening milestones execute before the seventh card is required',()=>{
 const master=only('162'),ids=master.books[0].cardIds,cards=ids.slice(0,6).map(id=>own(id));
 const steps=compareGrowthCandidates({master,cards,target:'132',xp:10_000_000}).collectionCandidates;
 assert.deepEqual(steps.map(s=>s.milestones[0].to),[12,24,30,35]);
 assert.deepEqual(steps.map(s=>s.status),['ready','ready','ready','cards-needed']);
 assert.ok(steps.slice(0,3).every(s=>s.available.cards.every(c=>c.id!==ids[6])));
 assert.equal(steps[2].available.gained,20);
 assert.equal(steps[3].available.missingCopies,16);
 const observations=cards.map(c=>({...c,name:c.id,confidence:1,image:'',time:0,observations:1})) as ScannedCard[];
 let state={cards:observations,growthPoints:{current:10_000_000,maximum:null}} as ScannerState;
 const initial=structuredClone(state);
 while(currentBookProgress(master,state.cards).targets.find(t=>t.id==='132')!.current<20){
  const next=compareGrowthCandidates({master,cards:state.cards,target:'132',xp:state.growthPoints!.current}).collectionCandidates[0];
  state=completeGrowth(state,master,next);
 }
 assert.equal(state.cards.length,6);
 while(state.growthHistory?.length)state=undoGrowth(state);
 assert.deepEqual(state.cards,initial.cards);assert.deepEqual(state.growthPoints,initial.growthPoints);
});

test('optional unreadable members cannot erase confirmed rewards or block sufficient growth',()=>{
 const master=only('162'),ids=master.books[0].cardIds;
 const unknown={...own(ids[6]),awakening:null,extraCopies:null,review:['이름 확인']};
 const cards=[...ids.slice(0,6).map(id=>own(id)),unknown];
 const steps=compareGrowthCandidates({master,cards,target:'132',xp:10_000_000}).collectionCandidates;
 assert.equal(steps.length,3);assert.ok(steps.every(s=>s.status==='ready'));
 const p=currentBookProgress(master,[...ids.slice(0,6).map(id=>own(id,5)),unknown]);
 assert.deepEqual(p.books[0].effects.map(e=>e.active),[true,true,true,null]);
 assert.equal(p.targets.find(t=>t.id==='132')?.current,20);
});
