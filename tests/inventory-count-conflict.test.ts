import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InventoryEvidence,CURRENT_INVENTORY_CONSENSUS_POLICY,hashInventoryEvidence,inventoryEventData,
  parseInventorySeed,serializeInventorySeed} from '../src/features/card-scanner/session/inventory-evidence';
import {InventoryEvidenceReplay} from '../src/features/card-scanner/reproduction/inventory-evidence-replay';
import {canStopSharing} from '../src/features/card-scanner/session/auto-completion';
import type {InventoryEvent,InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

const policy={version:1 as const,sessionId:'session'};
const options={seedPolicy:'prior-run-v3' as const,consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY,countConflictPolicy:policy};
const policyV2={version:2 as const,sessionId:'session'};
const optionsV2={...options,countConflictPolicy:policyV2};
const policyV3={version:3 as const,sessionId:'session'};
const optionsV3={...options,countConflictPolicy:policyV3};
const source=(order:number,id=`obs-${order}`):InventorySource=>({sessionId:'session',frameId:order,
  observationId:id,captureOrder:order,captureTime:order/10,phase:'input',slot:0,frame:`frame-${order}`});
const card=(s:InventorySource,value:number,kind:'positive'|'empty'|'stable-empty'|'fixed'|'unknown'='positive'):ScannedCard=>({
  id:'card',name:'카드',awakening:kind==='fixed'?5:0,extraCopies:kind==='unknown'?null:value,
  confidence:1,review:kind==='unknown'?['추가 장수 확인']:[],image:'',time:s.captureTime,observations:1,
  countReliable:kind!=='unknown',captureOrder:s.captureOrder,capturePosition:{frame:s.frame,slot:s.slot,stable:true,sort:null},
  countDiagnostics:{maximum:15,reason:'',readings:[],iconPresent:kind==='empty'||kind==='stable-empty'?false:true,
    reliability:kind==='empty'?'empty-counter':kind==='stable-empty'?'stable-frame':kind==='fixed'?'fixed-zero':kind==='unknown'?'unconfirmed':'clear-pattern'}
});
function record(inv:InventoryEvidence,s:InventorySource,value:number,kind:Parameters<typeof card>[2]='positive') {
  inv.acceptIdentity(s,'card');inv.confirmName(s,'card','카드');return inv.recordObservation(s,card(s,value,kind),.9);
}
function canStop(inv:InventoryEvidence){
  return canStopSharing({expected:1,finalExpected:1,cards:inv.project([]),latest:inv.latestIdentityOrder,
    confirmed:inv.confirmedFieldOrder,confirmedNames:inv.confirmedNameOrder,unresolved:0,dropped:0,inputSettled:true,
    fieldChangesSettled:true,headerAvailable:true});
}
test('v6 keeps positive-to-empty conflict unresolved across repeated empty views',()=>{
  const inv=new InventoryEvidence([],options);
  record(inv,source(1),4);record(inv,source(2),0,'empty');
  assert.equal(inv.hasCountConflict('card'),true);assert.equal(canStop(inv),false);
  assert.equal(inv.pendingFields().length,1);assert.equal(inv.latestFieldObservationSource('card')?.captureOrder,2);
  record(inv,source(3),0,'stable-empty');assert.equal(inv.hasCountConflict('card'),true);assert.equal(canStop(inv),false);
  record(inv,source(4),4);assert.equal(inv.hasCountConflict('card'),false);assert.equal(canStop(inv),true);
});
test('late earlier positive revokes latest zero without replacing its diagnostic source',()=>{
  const inv=new InventoryEvidence([],options),first=source(1),later=source(2);
  inv.acceptIdentity(first,'card');record(inv,later,0,'empty');assert.equal(canStop(inv),true);
  inv.confirmName(first,'card','카드');inv.recordObservation(first,card(first,4),.9);
  assert.equal(inv.hasCountConflict('card'),true);assert.equal(canStop(inv),false);
  assert.equal(inv.pendingFields().length,1);assert.deepEqual(inv.latestFieldObservationSource('card'),later);
});
test('contradictory retries of the same acquired slot and order cannot certify zero',()=>{
  const inv=new InventoryEvidence([],options),first=source(1),retry={...first,observationId:'retry'};
  record(inv,first,4);record(inv,retry,0,'empty');assert.equal(inv.hasCountConflict('card'),true);assert.equal(canStop(inv),false);
  const reverse=new InventoryEvidence([],options);reverse.acceptIdentity(first,'card');record(reverse,retry,0,'empty');
  reverse.confirmName(first,'card','카드');reverse.recordObservation(first,card(first,4),.9);
  assert.equal(reverse.hasCountConflict('card'),true);assert.equal(canStop(reverse),false);
});
test('prior seed is not current positive proof and a later rule-derived fixed zero can supersede a conflict',()=>{
  const seed=card(source(1),4),inv=new InventoryEvidence([seed],options);
  record(inv,source(2),0,'empty');assert.equal(inv.hasCountConflict('card'),false);assert.equal(canStop(inv),true);
  const conflict=new InventoryEvidence([],options);record(conflict,source(1),4);record(conflict,source(2),0,'empty');
  record(conflict,source(3),0,'fixed');assert.equal(conflict.hasCountConflict('card'),false);assert.equal(canStop(conflict),true);
});
test('actual rule-derived zero without counter diagnostics supersedes conflict in capture order',()=>{
  const apply=(inv:InventoryEvidence,s:InventorySource,value:ScannedCard)=>{
    inv.confirmName(s,'card','카드');inv.recordObservation(s,value,.9);
  };
  for(const kind of ['max-awakening','growthless'] as const){
    const run=(reversed:boolean)=>{
      const inv=new InventoryEvidence([],optionsV2),a=source(1),b=source(2),c=source(3);
      const {countDiagnostics:_omitted,...withoutDiagnostic}=card(c,0,'fixed');
      const fixed=kind==='growthless'?{...withoutDiagnostic,awakening:0,maxAwakening:0}:withoutDiagnostic;
      if(reversed){
        inv.acceptIdentity(a,'card');inv.acceptIdentity(b,'card');inv.acceptIdentity(c,'card');
        apply(inv,c,fixed);apply(inv,b,card(b,0,'empty'));apply(inv,a,card(a,4));
      }else{
        record(inv,a,4);record(inv,b,0,'empty');inv.acceptIdentity(c,'card');apply(inv,c,fixed);
      }
      assert.equal(inv.hasCountConflict('card'),false,`${kind}: reversed=${reversed}`);
      assert.equal(canStop(inv),true,`${kind}: reversed=${reversed}`);
    };
    run(false);run(true);
  }
});
test('unreliable, reviewed or impossible rule-derived zero does not clear conflict',()=>{
  const variants:((s:InventorySource)=>ScannedCard)[]=[
    s=>({...card(s,0,'fixed'),countDiagnostics:undefined,review:['각성 확인']}),
    s=>({...card(s,0,'fixed'),countDiagnostics:undefined,countReliable:false}),
    s=>({...card(s,1,'fixed'),countDiagnostics:undefined}),
    s=>({...card(s,0,'fixed'),countDiagnostics:undefined,awakening:1,maxAwakening:0}),
  ];
  for(const make of variants){
    const inv=new InventoryEvidence([],optionsV2),c=source(3);
    record(inv,source(1),4);record(inv,source(2),0,'empty');
    inv.acceptIdentity(c,'card');inv.confirmName(c,'card','카드');inv.recordObservation(c,make(c),.9);
    assert.equal(inv.hasCountConflict('card'),true);assert.equal(canStop(inv),false);
  }
});
test('version 1 preserves diagnostic-free fixed-zero semantics and version 2 changes them explicitly',async()=>{
  const events:InventoryEvent[]=[],original=new InventoryEvidence([],{...options,onEvent:event=>events.push(event)});
  record(original,source(1),4);record(original,source(2),0,'empty');
  const last=source(3),{countDiagnostics:_omitted,...fixed}=card(last,0,'fixed');
  original.acceptIdentity(last,'card');original.confirmName(last,'card','카드');original.recordObservation(last,fixed,.9);
  assert.equal(original.hasCountConflict('card'),true);assert.equal(canStop(original),false);
  const modern=new InventoryEvidence([],optionsV2);for(const event of events)modern.apply(event);
  assert.equal(modern.hasCountConflict('card'),false);assert.equal(canStop(modern),true);
  for(const [version,live,chosen] of [[1,original,policy],[2,modern,policyV2]] as const){
    const seed=serializeInventorySeed([],options.seedPolicy,options.consensusPolicy,chosen);
    const parsed=parseInventorySeed(seed);assert.equal(parsed.version,6);
    assert.equal(parsed.version===6&&parsed.countConflictPolicy.version,version);
    const replay=new InventoryEvidenceReplay(new AbortController().signal);replay.seed(seed);
    for(const event of events)replay.accept(inventoryEventData(event));
    const expected=await hashInventoryEvidence(live.snapshot());replay.checkpoint({complete:true,hash:expected});
    assert.equal((await replay.summary()).matchesCapturedState,true);
    assert.equal(replay.confirmedFieldOrder.has('card'),version===2);
  }
  assert.notEqual(await hashInventoryEvidence(original.snapshot()),await hashInventoryEvidence(modern.snapshot()));
});
test('v6 source events and replay bind conflict state without changing v5 semantics',async()=>{
  const events:InventoryEvent[]=[],live=new InventoryEvidence([],{...options,onEvent:event=>events.push(event)});
  record(live,source(1),4);record(live,source(2),0,'empty');
  const seed=serializeInventorySeed([],options.seedPolicy,options.consensusPolicy,policy);
  assert.equal(parseInventorySeed(seed).version,6);
  const replay=new InventoryEvidenceReplay(new AbortController().signal);replay.seed(seed);
  for(const event of events)replay.accept(inventoryEventData(event));
  const expected=await hashInventoryEvidence(live.snapshot());replay.checkpoint({complete:true,hash:expected});
  assert.equal((await replay.summary()).matchesCapturedState,true);assert.equal(replay.confirmedFieldOrder.has('card'),false);
  const v5=new InventoryEvidence([],{seedPolicy:'prior-run-v3',consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY});
  for(const event of events)v5.apply(event);assert.equal(canStop(v5),true);
  assert.throws(()=>live.acceptIdentity({...source(3),sessionId:'different'},'card'),/session mismatch/);
});

test('v3 holds contradictory rule-based zero and positive readings from the same captured order',()=>{
  for(const kind of ['max-awakening','growthless'] as const)for(const reversed of [false,true]){
    const inv=new InventoryEvidence([],optionsV3),positive=source(10,'positive'),fixed=source(10,'fixed');
    const input={...card(fixed,0,'fixed'),...(kind==='growthless'?{awakening:0,maxAwakening:0}:{}),countDiagnostics:undefined};
    const put=(s:InventorySource,value:ScannedCard)=>{inv.acceptIdentity(s,'card');inv.confirmName(s,'card','카드');inv.recordObservation(s,value,.9);};
    if(reversed){put(fixed,input);put(positive,card(positive,4));}
    else{put(positive,card(positive,4));put(fixed,input);}
    assert.equal(inv.hasCountConflict('card'),true,`${kind}: reversed=${reversed}`);
    assert.equal(inv.pendingFields().length,1);
    assert.equal(canStop(inv),false,'a retry of the same capture cannot settle contradictory counts');
    assert.equal(inv.confirmedFieldOrder.has('card'),false);
  }
});

test('v3 accepts a later distinct valid positive or rule-based zero after a tied conflict',()=>{
  for(const nextKind of ['positive','fixed'] as const){
    const inv=new InventoryEvidence([],optionsV3),first=source(10,'positive'),retry=source(10,'fixed');
    record(inv,first,4);record(inv,retry,0,'fixed');
    assert.equal(inv.hasCountConflict('card'),true);
    if(nextKind==='fixed')record(inv,source(11),0,'fixed');else record(inv,source(11),4);
    assert.equal(inv.hasCountConflict('card'),false,nextKind);
    assert.equal(canStop(inv),true,nextKind);
  }
});

test('v3 also holds other conflicting reliable tuples for one capture order',()=>{
  for(const kind of ['same-zero-different-awakening','different-positive-count','same-count-different-awakening'] as const)
    for(const reversed of [false,true]){
      const inv=new InventoryEvidence([],optionsV3),first=source(8,'a'),second=source(8,'b');
      const a=card(first,kind==='same-zero-different-awakening'?0:4,kind==='same-zero-different-awakening'?'empty':'positive');
      const b=kind==='same-zero-different-awakening'?card(second,0,'fixed'):
        {...card(second,kind==='different-positive-count'?5:4),awakening:kind==='same-count-different-awakening'?1:0};
      const put=(s:InventorySource,value:ScannedCard)=>{inv.acceptIdentity(s,'card');inv.confirmName(s,'card','카드');inv.recordObservation(s,value,.9);};
      if(reversed){put(second,b);put(first,a);}else{put(first,a);put(second,b);}
      assert.equal(inv.hasCountConflict('card'),true,`${kind}: reversed=${reversed}`);
      assert.equal(canStop(inv),false,`${kind}: reversed=${reversed}`);
      record(inv,source(9),4);
      assert.equal(inv.hasCountConflict('card'),false,'later accepted proof can clear the tuple conflict');
      assert.equal(canStop(inv),true);
    }
});

test('v3 repeated matching tuples at the same capture order do not create a conflict',()=>{
  for(const kind of ['positive','empty','fixed'] as const){
    const inv=new InventoryEvidence([],optionsV3),value=kind==='positive'?4:0;
    record(inv,source(10,'attempt-a'),value,kind);record(inv,source(10,'attempt-b'),value,kind);
    assert.equal(inv.hasCountConflict('card'),false,kind);
    assert.equal(canStop(inv),true,kind);
  }
});

test('v3 an unknown later observation does not clear an unresolved same-order tuple',()=>{
  const inv=new InventoryEvidence([],optionsV3);
  record(inv,source(10,'positive'),4);record(inv,source(10,'fixed'),0,'fixed');
  record(inv,source(11),0,'unknown');
  assert.equal(inv.hasCountConflict('card'),true);
  assert.equal(canStop(inv),false);
});

test('v3 does not let a diagnostic-free non-rule zero bypass an earlier positive',()=>{
  const inv=new InventoryEvidence([],optionsV3),later=source(11);
  record(inv,source(10),4);
  inv.acceptIdentity(later,'card');inv.confirmName(later,'card','카드');
  inv.recordObservation(later,{...card(later,0,'empty'),countDiagnostics:undefined},.9);
  assert.equal(inv.hasCountConflict('card'),true);
  assert.equal(canStop(inv),false);
});

test('v3 tied fixed-zero conflict is independent of result completion order and ignores earlier valid results',()=>{
  const permutations=[[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]];
  for(const order of permutations){
    const inv=new InventoryEvidence([],optionsV3);
    for(const n of order){
      const s=n===1?source(2,'earlier'):source(3,n===2?'positive':'fixed');
      record(inv,s,n===3?0:4,n===3?'fixed':'positive');
    }
    assert.equal(inv.hasCountConflict('card'),true,order.join(','));
    assert.equal(canStop(inv),false,order.join(','));
  }
});

test('v3 replay preserves its own conflict semantics and older v2 records stay unchanged',async()=>{
  const events:InventoryEvent[]=[],v3=new InventoryEvidence([],{...optionsV3,onEvent:event=>events.push(event)});
  record(v3,source(10,'positive'),4);record(v3,source(10,'fixed'),0,'fixed');
  const v2=new InventoryEvidence([],optionsV2);for(const event of events)v2.apply(event);
  assert.equal(v2.hasCountConflict('card'),false,'historical v2 behavior remains frozen');
  assert.equal(v3.hasCountConflict('card'),true);
  for(const [live,selected] of [[v2,policyV2],[v3,policyV3]] as const){
    const seed=serializeInventorySeed([],options.seedPolicy,options.consensusPolicy,selected);
    const parsed=parseInventorySeed(seed);assert.equal(parsed.version===6&&parsed.countConflictPolicy.version,selected.version);
    const replay=new InventoryEvidenceReplay(new AbortController().signal);replay.seed(seed);
    for(const event of events)replay.accept(inventoryEventData(event));
    const expected=await hashInventoryEvidence(live.snapshot());replay.checkpoint({complete:true,hash:expected});
    assert.equal((await replay.summary()).matchesCapturedState,true);
  }
  assert.notEqual(await hashInventoryEvidence(v2.snapshot()),await hashInventoryEvidence(v3.snapshot()));
});
