import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  InventoryEvidence, hashInventoryEvidence, inventoryEventData, parseInventoryEvent, parseInventoryPreviewConfirmation, parseInventorySeed,
  reduceInventoryCard, replayInventoryEvidence, serializeInventoryEvent, serializeInventorySeed,
} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventoryEvent, InventoryPreviewConfirmation, InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard, NameEvidence} from '../src/features/card-scanner/recognition/recognizer';
import {consensus} from '../src/features/card-scanner/recognition/consensus';
import {appendObservation} from '../src/features/card-scanner/session/observation-history';
import {confirmedReadingCount} from '../src/features/card-scanner/session/recovery-completion';
import {canStopSharing, confirmedCaptureCount} from '../src/features/card-scanner/session/auto-completion';
import {InventoryEvidenceReplay} from '../src/features/card-scanner/reproduction/inventory-evidence-replay';
import {CURRENT_FIELD_REVIEW, hasCurrentFieldProof} from '../src/features/card-scanner/session/current-scan-fields';

function source(order = 10, slot = 0): InventorySource {
  return {sessionId: 'session', frameId: order, observationId: `observation-${order}-${slot}`,
    captureOrder: order, captureTime: order / 10, phase: 'input', slot, frame: `session/frame-${order}`};
}
function proof(change: Partial<NameEvidence> = {}): NameEvidence {
  return {rawText: '카드', normalizedText: '카드', engine: 'paddle', readingId: 'read-one', fingerprint: 'pixels-one',
    ocrConfidence: 90, score: .95, gap: .3, exact: true, stable: true, frame: 'session/frame-10', ...change};
}
function card(input: InventorySource = source(), change: Partial<ScannedCard> = {}): ScannedCard {
  return {id: 'card', name: '카드', awakening: 0, extraCopies: 2, confidence: .95, review: [],
    image: `data:image/jpeg;base64,${input.captureOrder}`, time: input.captureTime, observations: 1,
    captureOrder: input.captureOrder, capturePosition: {frame: input.frame, slot: input.slot, stable: true, sort: null},
    countReliable: true, nameEvidence: [proof({frame: input.frame})], ...change};
}
function record(inventory: InventoryEvidence, input: InventorySource, value = card(input)) {
  inventory.acceptIdentity(input, value.id);
  if (!value.review.includes('이름 확인')) inventory.confirmName(input, value.id,value.name);
  return inventory.recordObservation(input, value, .9);
}
function evidence(inventory: InventoryEvidence) {
  return {latest: inventory.latestIdentityOrder, confirmed: inventory.confirmedFieldOrder};
}

function completion(inventory: InventoryEvidence) {
  return {expected:1,finalExpected:1,cards:inventory.project([]),...evidence(inventory),
    confirmedNames:inventory.confirmedNameOrder,unresolved:0,dropped:0,inputSettled:true,
    fieldChangesSettled:true,headerAvailable:true};
}

test('new-run seed manual fields cannot override or certify a newer observation', () => {
  const seed=card(source(1),{awakening:1,extraCopies:2,manual:['awakening','extraCopies']});
  const inventory=new InventoryEvidence([seed],{seedPolicy:'prior-run'});
  assert.deepEqual(inventory.cards.get('card')!.manual,['awakening','extraCopies'], 'initial seed retains manual provenance');
  const input=source(10), next=card(input,{awakening:2,extraCopies:3});
  record(inventory,input,next);
  assert.deepEqual([inventory.cards.get('card')!.awakening,inventory.cards.get('card')!.extraCopies],[2,3]);
  assert.equal(canStopSharing(completion(inventory)),true);
  assert.deepEqual(seed.manual,['awakening','extraCopies'], 'the caller-owned seed is unchanged');
});

test('new-run seed manual fields cannot make unresolved or impossible newer fields current', () => {
  for(const next of [card(source(10),{awakening:null,extraCopies:null,countReliable:false,review:['각성 확인']}),
    card(source(10),{awakening:4,extraCopies:10,countReliable:true,review:[]}),
    card(source(10),{awakening:1,extraCopies:2,countReliable:true,review:[],maxAwakening:0})]){
    const seed=card(source(1),{awakening:1,extraCopies:2,manual:['awakening','extraCopies']});
    const inventory=new InventoryEvidence([seed],{seedPolicy:'prior-run'});
    record(inventory,source(10),next);
    assert.equal(inventory.confirmedFieldOrder.has('card'),false);
    assert.ok(inventory.project([])[0].review.includes(CURRENT_FIELD_REVIEW));
    assert.equal(canStopSharing(completion(inventory)),false);
  }
});

test('impossible newer observation cannot reuse an older valid field proof', () => {
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run'});
  record(inventory,source(10),card(source(10),{awakening:1,extraCopies:2}));
  record(inventory,source(20),card(source(20),{awakening:4,extraCopies:10}));
  assert.equal(inventory.confirmedFieldOrder.get('card'),10);
  assert.equal(inventory.latestIdentityOrder.get('card'),20);
  assert.equal(canStopSharing(completion(inventory)),false);
});

test('repeated newer field pair stays provable while a changed pair does not', () => {
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run'});
  record(inventory,source(10),card(source(10),{awakening:0,extraCopies:2}));
  record(inventory,source(20),card(source(20),{awakening:0,extraCopies:2,countReliable:false,review:['추가 장수 확인']}));
  const repeated={latest:inventory.latestIdentityOrder,confirmed:inventory.confirmedFieldOrder,agreed:inventory.agreedFieldOrder};
  assert.equal(inventory.confirmedFieldOrder.get('card'),10);
  assert.equal(inventory.latestIdentityOrder.get('card'),20);
  assert.equal(inventory.agreedFieldOrder.get('card'),20);
  assert.equal(hasCurrentFieldProof('card',repeated),true);
  assert.equal(confirmedReadingCount({cards:inventory.project([]),...repeated}),1);

  const changed=new InventoryEvidence([],{seedPolicy:'prior-run'});
  record(changed,source(10),card(source(10),{awakening:0,extraCopies:2}));
  record(changed,source(20),card(source(20),{awakening:0,extraCopies:3,countReliable:false,review:['추가 장수 확인']}));
  assert.equal(changed.confirmedFieldOrder.get('card'),10);
  assert.equal(changed.latestIdentityOrder.get('card'),20);
  assert.equal(changed.agreedFieldOrder.has('card'),false);
  assert.equal(hasCurrentFieldProof('card',{latest:changed.latestIdentityOrder,confirmed:changed.confirmedFieldOrder,
    agreed:changed.agreedFieldOrder}),false);

  const partial=new InventoryEvidence([],{seedPolicy:'prior-run'});
  record(partial,source(10),card(source(10),{awakening:0,extraCopies:2}));
  record(partial,source(20),card(source(20),{awakening:null,extraCopies:2,countReliable:false,review:['각성 확인']}));
  assert.equal(partial.agreedFieldOrder.get('card'),20,'an unobserved awakening does not contradict the confirmed pair');
  assert.equal(hasCurrentFieldProof('card',{latest:partial.latestIdentityOrder,confirmed:partial.confirmedFieldOrder,
    agreed:partial.agreedFieldOrder}),true,'the newest capture still repeats the count');

  const contradicted=new InventoryEvidence([],{seedPolicy:'prior-run'});
  record(contradicted,source(10),card(source(10),{awakening:0,extraCopies:2}));
  record(contradicted,source(20),card(source(20),{awakening:1,extraCopies:2,countReliable:false,review:['각성 확인']}));
  assert.equal(contradicted.agreedFieldOrder.has('card'),false,'a later observed awakening blocks the old pair');

  const missingCount=new InventoryEvidence([],{seedPolicy:'prior-run'});
  record(missingCount,source(10),card(source(10),{awakening:0,extraCopies:2}));
  record(missingCount,source(20),card(source(20),{awakening:null,extraCopies:null,countReliable:false,review:['각성 확인','추가 장수 확인']}));
  assert.equal(missingCount.agreedFieldOrder.has('card'),false,'the newest capture must repeat the count');
});

test('manual observations within a new run retain their existing precedence', () => {
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run'});
  record(inventory,source(10),card(source(10),{awakening:1,extraCopies:2,manual:['awakening','extraCopies']}));
  record(inventory,source(20),card(source(20),{awakening:2,extraCopies:3}));
  assert.deepEqual([inventory.cards.get('card')!.awakening,inventory.cards.get('card')!.extraCopies],[1,2]);
  assert.equal(inventory.confirmedFieldOrder.get('card'),10,'newer conflicting proof cannot certify the manual value');
  assert.equal(canStopSharing(completion(inventory)),false);
});

test('newer name proof cannot certify a conflicting same-run manual label', () => {
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v2'});
  record(inventory,source(10),card(source(10),{name:'수동 이름',manual:['name']}));
  record(inventory,source(20),card(source(20),{name:'다른 이름'}));
  assert.equal(inventory.cards.get('card')!.name,'수동 이름');
  assert.equal(inventory.confirmedNameOrder.get('card'),10,'an older matching proof is retained but is not current');
  assert.equal(canStopSharing(completion(inventory)),false);
  record(inventory,source(30),card(source(30),{name:'수동 이름'}));
  assert.equal(inventory.confirmedNameOrder.get('card'),30);
  assert.equal(canStopSharing(completion(inventory)),true);
});

test('unreadable or out-of-order name observations cannot upgrade a manual label', () => {
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v2'});
  record(inventory,source(10),card(source(10),{name:'수동 이름',manual:['name']}));
  record(inventory,source(30),card(source(30),{name:'수동 이름',review:['이름 확인']}));
  assert.equal(canStopSharing(completion(inventory)),false);
  record(inventory,source(20),card(source(20),{name:'다른 이름'}));
  assert.equal(canStopSharing(completion(inventory)),false);
  record(inventory,source(40),card(source(40),{name:'수동 이름'}));
  assert.equal(canStopSharing(completion(inventory)),true);
  record(inventory,source(15),card(source(15),{name:'다른 이름'}));
  assert.equal(inventory.confirmedNameOrder.get('card'),40, 'an older read does not erase newer matching proof');
  assert.equal(canStopSharing(completion(inventory)),true);
});

test('same-capture retries and interrupted bound name events cannot revive conflicting proof', async () => {
  const events:InventoryEvent[]=[],inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v2',onEvent:event=>events.push(event)});
  record(inventory,source(10),card(source(10),{name:'수동 이름',manual:['name']}));
  const latest=source(20);record(inventory,latest,card(latest,{name:'다른 이름'}));
  assert.equal(inventory.confirmedNameOrder.get('card'),10);
  assert.equal(canStopSharing(completion(inventory)),false);
  const before=await hashInventoryEvidence(inventory.snapshot());
  inventory.acceptIdentity(latest,'card');inventory.confirmName(latest,'card','다른 이름');
  assert.equal(inventory.confirmedNameOrder.get('card'),10,'confirmation alone is not a finished observation');
  assert.equal(canStopSharing(completion(inventory)),false,'timeout after the event cannot revive the old manual label');
  assert.notEqual(await hashInventoryEvidence(inventory.snapshot()),before,'a pending confirmation is included in the checkpoint');
  const replay=new InventoryEvidenceReplay(new AbortController().signal);replay.seed(serializeInventorySeed([],'prior-run-v2'));
  for(const event of events)replay.accept(serializeInventoryEvent(event));
  replay.checkpoint({complete:true,hash:await hashInventoryEvidence(inventory.snapshot())});
  assert.equal((await replay.summary()).matchesCapturedState,true);
  inventory.recordObservation(latest,card(latest,{name:'다른 이름'}),.9);
  assert.equal(canStopSharing(completion(inventory)),false,'same-source disagreement remains unresolved');
  inventory.acceptIdentity(latest,'card');inventory.confirmName(latest,'card','수동 이름');
  inventory.recordObservation(latest,card(latest,{name:'수동 이름'}),.9);
  assert.equal(inventory.confirmedNameOrder.get('card'),20);
  assert.equal(canStopSharing(completion(inventory)),true,'same-source matching observation restores proof');
  inventory.confirmName(latest,'card','수동 이름');
  assert.equal(canStopSharing(completion(inventory)),true,'reuse of the identical source and label retains proof');
  const other={...latest,observationId:'different-attempt'};
  inventory.confirmName(other,'card','다른 이름');
  assert.equal(canStopSharing(completion(inventory)),false,'a different attempt cannot reuse the same-order proof');
  inventory.recordObservation(latest,card(latest,{name:'수동 이름'}),.9);
  assert.equal(canStopSharing(completion(inventory)),false,'a different source cannot consume the pending confirmation');
});

test('an older observation cannot consume a pending newer bound-name source', () => {
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v2'});
  const newer=source(30),older=source(20);
  inventory.acceptIdentity(newer,'card');inventory.confirmName(newer,'card','카드');
  inventory.acceptIdentity(older,'card');inventory.confirmName(older,'card','다른 이름');
  inventory.recordObservation(older,card(older,{name:'다른 이름'}),.9);
  assert.equal(inventory.confirmedNameOrder.has('card'),false);
  inventory.recordObservation(newer,card(newer,{name:'카드',confidence:1}),.9);
  assert.equal(inventory.confirmedNameOrder.get('card'),30);
  assert.equal(canStopSharing(completion(inventory)),true);
});

test('a same-order unconfirmed replacement cannot reuse a proof bound to another label', () => {
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v2'}),input=source(10);
  record(inventory,input,card(input,{name:'첫 이름',confidence:.8}));
  assert.equal(canStopSharing(completion(inventory)),true);
  inventory.acceptIdentity(input,'card');
  inventory.recordObservation(input,card(input,{name:'다른 이름',confidence:1}),.9);
  assert.equal(inventory.cards.get('card')!.name,'다른 이름');
  assert.equal(inventory.confirmedNameOrder.has('card'),false);
  assert.equal(canStopSharing(completion(inventory)),false);
});

test('v2 state replay keeps its historical name proof while v3 rejects the conflicting proof', async () => {
  const legacyEvents:InventoryEvent[]=[],currentEvents:InventoryEvent[]=[];
  const legacy=new InventoryEvidence([],{seedPolicy:'prior-run',onEvent:event=>legacyEvents.push(event)});
  const current=new InventoryEvidence([],{seedPolicy:'prior-run-v2',onEvent:event=>currentEvents.push(event)});
  for(const inventory of [legacy,current]) {
    record(inventory,source(10),card(source(10),{name:'수동 이름',manual:['name']}));
    record(inventory,source(20),card(source(20),{name:'다른 이름'}));
  }
  assert.equal(canStopSharing(completion(legacy)),true,'legacy v2 semantics are preserved for state replay');
  assert.equal(canStopSharing(completion(current)),false,'new v3 state does not certify a different label');
  for(const [version,policy,events,inventory] of [[2,'prior-run',legacyEvents,legacy],[3,'prior-run-v2',currentEvents,current]] as const){
    const wire=serializeInventorySeed([],policy),parsed=parseInventorySeed(wire);
    assert.equal(parsed.version,version);
    const replay=new InventoryEvidenceReplay(new AbortController().signal);replay.seed(wire);
    for(const event of events)replay.accept(serializeInventoryEvent(event));
    replay.checkpoint({complete:true,hash:await hashInventoryEvidence(inventory.snapshot())});
    assert.equal((await replay.summary()).matchesCapturedState,true);
  }
});

test('late manual observation cannot reuse newer proof for different selected values', () => {
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run'});
  record(inventory,source(20),card(source(20),{awakening:2,extraCopies:3}));
  record(inventory,source(10),card(source(10),{awakening:1,extraCopies:2,manual:['awakening','extraCopies']}));
  assert.deepEqual([inventory.cards.get('card')!.awakening,inventory.cards.get('card')!.extraCopies],[1,2]);
  assert.equal(inventory.confirmedFieldOrder.get('card'),10);
  assert.equal(canStopSharing(completion(inventory)),false);
});

test('historical manually named seed does not override the current observed name', () => {
  const seed=card(source(1),{name:'이전 수동 이름',confidence:1,manual:['name']});
  const inventory=new InventoryEvidence([seed],{seedPolicy:'prior-run'});
  record(inventory,source(10),card(source(10),{name:'카드',confidence:.9}));
  assert.equal(inventory.cards.get('card')!.name,'카드');
  assert.equal(inventory.evidence.get('card')![0].name,'이전 수동 이름');
});

test('versioned new-run seed replays the new policy and legacy version retains old semantics', async () => {
  const seed=card(source(1),{awakening:1,extraCopies:2,manual:['awakening','extraCopies']});
  const events:InventoryEvent[]=[];
  const inventory=new InventoryEvidence([seed],{seedPolicy:'prior-run',onEvent:event=>events.push(event)});
  record(inventory,source(10),card(source(10),{awakening:2,extraCopies:3}));
  const wire=serializeInventorySeed([seed],'prior-run');
  const parsed=parseInventorySeed(wire);assert.equal(parsed.version,2);
  assert.equal(await hashInventoryEvidence(replayInventoryEvidence(parsed.cards,events,{seedPolicy:'prior-run'}).snapshot()),
    await hashInventoryEvidence(inventory.snapshot()));
  const replay=new InventoryEvidenceReplay(new AbortController().signal);replay.seed(wire);
  for(const event of events)replay.accept(serializeInventoryEvent(event));
  const expected=await hashInventoryEvidence(inventory.snapshot());replay.checkpoint({complete:true,hash:expected});
  assert.equal((await replay.summary()).matchesCapturedState,true);
  const legacy=new InventoryEvidenceReplay(new AbortController().signal);legacy.seed(serializeInventorySeed([seed]));
  for(const event of events)legacy.accept(serializeInventoryEvent(event));
  legacy.checkpoint({complete:true,hash:expected});
  assert.equal((await legacy.summary()).matchesCapturedState,false);
});

test('seeds remain historical and stable map aliases receive separate identity, name and field facts', () => {
  const seed = card(source(5)), inventory = new InventoryEvidence([seed]);
  const aliases = [inventory.cards, inventory.evidence, inventory.latestIdentityOrder, inventory.confirmedNameOrder,
    inventory.confirmedFieldOrder, inventory.latestFieldObservations];
  assert.equal(inventory.cards.size, 1);
  assert.equal(confirmedReadingCount({cards: inventory.project([]), ...evidence(inventory)}), 0);
  assert.equal(inventory.latestIdentityOrder.size, 0);
  const input = source(); inventory.acceptIdentity(input, seed.id);
  assert.ok(inventory.project([])[0].review.includes(CURRENT_FIELD_REVIEW));
  assert.equal(inventory.confirmedNameOrder.size, 0);
  inventory.confirmName(input, seed.id);
  assert.equal(confirmedCaptureCount({cards: inventory.project([]), latest: inventory.latestIdentityOrder,
    confirmedNames: inventory.confirmedNameOrder}), 1);
  assert.equal(confirmedReadingCount({cards: inventory.project([]), ...evidence(inventory)}), 0);
  inventory.recordObservation(input, card(input), 1);
  assert.equal(confirmedReadingCount({cards: inventory.project([]), ...evidence(inventory)}), 1);
  assert.deepEqual([inventory.cards, inventory.evidence, inventory.latestIdentityOrder, inventory.confirmedNameOrder,
    inventory.confirmedFieldOrder, inventory.latestFieldObservations], aliases);
  aliases.forEach((alias, index) => assert.equal(alias, [inventory.cards, inventory.evidence, inventory.latestIdentityOrder,
    inventory.confirmedNameOrder, inventory.confirmedFieldOrder, inventory.latestFieldObservations][index]));
  assert.notEqual(inventory.evidence.get(seed.id)![0], seed);
});

test('identity acceptance alone invalidates old proof before a timed out or aborted field read', () => {
  const inventory = new InventoryEvidence(); record(inventory, source(10));
  const previous = inventory.project([]), before = inventory.snapshot();
  inventory.acceptIdentity(source(20), 'card');
  assert.equal(inventory.cards.get('card')!.extraCopies, 2);
  assert.equal(inventory.confirmedFieldOrder.get('card'), 10);
  assert.ok(inventory.project([])[0].review.includes(CURRENT_FIELD_REVIEW));
  assert.equal(inventory.project([])[0].countReliable, false);
  assert.deepEqual(previous[0].review, []);
  assert.deepEqual(before.latestIdentityOrder, [['card', 10]]);
  assert.equal(inventory.pendingFields().length, 0, 'no fabricated failed-observation image before fields return');
});

test('late older recovery cannot certify or replace a newer failed observation; a new explicit zero can', () => {
  const inventory = new InventoryEvidence(); record(inventory, source(10));
  record(inventory, source(30), card(source(30), {extraCopies: null, countReliable: false, review: ['추가 장수 확인']}));
  const older = {...source(20), phase: 'recovery' as const};
  record(inventory, older, card(older, {extraCopies: 1}));
  assert.equal(inventory.latestIdentityOrder.get('card'), 30);
  assert.equal(inventory.confirmedFieldOrder.get('card'), 20);
  assert.equal(inventory.cards.get('card')!.extraCopies, 1);
  assert.equal(inventory.pendingFields()[0].captureOrder, 30);
  assert.equal(inventory.pendingFields()[0].image, card(source(30)).image);
  assert.equal(confirmedReadingCount({cards: inventory.project([]), ...evidence(inventory)}), 0);
  record(inventory, source(40), card(source(40), {extraCopies: 0}));
  assert.equal(inventory.cards.get('card')!.extraCopies, 0);
  assert.deepEqual(inventory.pendingFields(), []);
  assert.equal(confirmedReadingCount({cards: inventory.project([]), ...evidence(inventory)}), 1);
});

test('same-frame retries retain changed OCR evidence but identical retries do not manufacture votes', () => {
  const inventory = new InventoryEvidence(), input = source();
  const initial = card(input); record(inventory, input, initial);
  const retry = {...initial, image: 'different optional thumbnail', nameEvidence: [proof({readingId: 'retry-id'})]};
  const duplicate = inventory.recordObservation(input, retry, .9);
  assert.equal(duplicate.appended, false);
  assert.equal(inventory.evidence.get('card')!.length, 1);
  assert.equal(inventory.cards.get('card')!.observations, 1);
  assert.equal(inventory.recordObservation(input, {...retry, extraCopies: 3}, .9).appended, true);
  assert.equal(inventory.evidence.get('card')!.length, 2);
  record(inventory, source(20), card(source(20), {extraCopies: 3}));
  assert.equal(inventory.cards.get('card')!.extraCopies, 3);
  assert.equal(inventory.cards.get('card')!.observations, 3);
});

test('pure transitions preserve previous state and use the existing consensus result without added count rules', () => {
  const input = source(), accepted: InventoryEvent = {version: 1, kind: 'identity-accepted', source: input, id: 'card'};
  const first = reduceInventoryCard(undefined, accepted).state;
  const before = JSON.stringify(first);
  const second = reduceInventoryCard(first, {version: 1, kind: 'name-confirmed', source: input, id: 'card'}).state;
  const value = card(input, {awakening: 4, extraCopies: 10});
  const result = reduceInventoryCard(second, {version: 1, kind: 'observation-recorded', source: input, card: value, borderAlignment: .8});
  assert.equal(JSON.stringify(first), before);
  assert.equal(first.card, undefined);
  assert.deepEqual(result.state.card, consensus([value]));
  assert.ok(result.state.card!.review.includes('각성·장수 조합 확인'));
  assert.equal(result.change.fieldsConfirmed, true, 'retain the original proof update; completion still rejects an impossible consensus');
  assert.equal(Object.isFrozen(result.state), true);
  assert.equal(Object.isFrozen(result.state.observations), true);
  assert.throws(() => reduceInventoryCard(first, {...accepted, id: 'other'}), /identity changed/);
});

test('name uncertainty cannot donate fields to an independently identified card', () => {
  const inventory = new InventoryEvidence(); record(inventory, source(10));
  record(inventory, source(20), card(source(20), {extraCopies: 14, review: ['이름 확인']}));
  assert.equal(inventory.cards.get('card')!.extraCopies, 2);
  assert.equal(inventory.confirmedNameOrder.get('card'), 10);
  assert.equal(inventory.confirmedFieldOrder.get('card'), 10);
  assert.equal(inventory.latestIdentityOrder.get('card'), 20);
  assert.equal(confirmedReadingCount({cards: inventory.project([]), ...evidence(inventory)}), 0);
});

test('state replay does not turn legacy repeated tentative OCR into independent identity proof', () => {
  const events: InventoryEvent[] = [], live = new InventoryEvidence([], {onEvent: event => events.push(event)});
  for (const [index, engine, rawText] of [[10, 'paddle', '발탄'], [20, 'tesseract', '발단']] as const) {
    const input=source(index);
    const tentative=card(input,{id:'short',name:'발탄',review:['이름 확인'],
      nameEvidence:[proof({frame:input.frame,readingId:`reading-${index}`,fingerprint:`pixels-${index}`,
        rawText,engine,exact:index===10})]});
    record(live,input,tentative);
  }
  const replay=replayInventoryEvidence([],events.map(inventoryEventData));
  for (const instance of [live,replay]) {
    assert.ok(instance.cards.get('short')!.review.includes('이름 확인'));
    assert.equal(instance.confirmedNameOrder.has('short'),false);
    assert.equal(instance.cards.get('short')!.nameConfirmedBy,undefined);
  }
});

test('name ambiguity is retained and validated in recorded inventory events', () => {
  const events: InventoryEvent[] = [], inventory=new InventoryEvidence([], {onEvent: event=>events.push(event)});
  const input=source(), value=card(input,{nameEvidence:[proof({nameAmbiguous:true})]});
  record(inventory,input,value);
  const replay=replayInventoryEvidence([],events.map(inventoryEventData));
  assert.equal(replay.cards.get('card')!.nameEvidence![0].nameAmbiguous,true);
  const recorded=structuredClone(inventoryEventData(events.find(event=>event.kind==='observation-recorded')!)) as unknown as {card:{nameEvidence:Array<{nameAmbiguous:unknown}>}};
  recorded.card.nameEvidence[0].nameAmbiguous='yes';
  assert.throws(()=>parseInventoryEvent(recorded),/boolean required/);
});

test('name-sort correction is only a selector and cannot mutate evidence or certify raw name/field proofs', () => {
  const inventory = new InventoryEvidence();
  const catalog = [{id:'a',name:'가나',rarity:1},{id:'b',name:'다라',rarity:1},{id:'c',name:'마바',rarity:1}];
  for (let slot = 0; slot < 3; slot++) {
    const input = source(10, slot), name = catalog[slot];
    record(inventory, input, card(input, {id:name.id,name:name.name,
      review: slot === 1 ? ['이름 확인'] : [],
      nameEvidence: [proof({rawText:name.name, exact:slot !== 1, ocrConfidence:slot === 1 ? 60 : 90})],
      capturePosition:{frame:input.frame,slot,stable:true,sort:{kind:'name',direction:'asc'}},
    }));
  }
  const before = inventory.snapshot();
  const corrected = inventory.project(catalog).find(value => value.id === 'b')!;
  assert.equal(corrected.nameConfirmedBy, 'sort');
  assert.equal(corrected.review.includes('이름 확인'), false);
  assert.equal(corrected.review.includes(CURRENT_FIELD_REVIEW), true);
  assert.equal(inventory.cards.get('b')!.review.includes('이름 확인'), true);
  assert.equal(inventory.confirmedNameOrder.has('b'), false);
  assert.equal(inventory.confirmedFieldOrder.has('b'), false);
  assert.deepEqual(inventory.snapshot(), before);
});

test('events detach and freeze the accepted metadata while runtime images remain available', () => {
  const events: InventoryEvent[] = [], inventory = new InventoryEvidence([], {onEvent: event => events.push(event)});
  const input = source(), value = card(input, {countDiagnostics:{maximum:15,reason:'confirmed',readings:[]}});
  record(inventory, input, value);
  const captured = events[2]; assert.equal(captured.kind, 'observation-recorded');
  if (captured.kind !== 'observation-recorded') assert.fail('recorded event');
  value.review.push('external change'); value.capturePosition!.sort = {kind:'name',direction:'desc'};
  value.nameEvidence![0].rawText = 'mutated'; value.countDiagnostics!.reason = 'mutated';
  assert.deepEqual(captured.card.review, []);
  assert.equal(captured.card.capturePosition!.sort, null);
  assert.equal(captured.card.nameEvidence![0].rawText, '카드');
  assert.equal(captured.card.countDiagnostics!.reason, 'confirmed');
  assert.equal(captured.card.image, value.image);
  assert.equal(inventory.cards.get('card')!.image, value.image);
  assert.throws(() => captured.card.review.push('cannot change'), TypeError);
  assert.throws(() => {captured.source.frame = 'cannot change';}, TypeError);
});

test('image-free seed and event replay reproduce all consensus metadata, histories, proofs and state hashes', async () => {
  const seed = card(source(1), {id:'seed', name:'기존 카드', manual:['awakening'], observations:0});
  const events: string[] = [], inventory = new InventoryEvidence([seed], {onEvent: event => events.push(serializeInventoryEvent(event))});
  const input = source(10), value = card(input, {
    nameEvidence:[proof({complete:true, preprocessing:'soft-rarity',
      portrait:{upper:.94,lower:.95,correlation:.96,margin:.4,region:'above-badge',left:.9,right:.91},
      artwork:{correlation:.95,margin:.3,visiblePrefix:'카',mode:'prefix',textSimilarity:1,textGap:.3},
      ctc:{relativeLikelihood:.88,margin:.3}})],
    countDiagnostics:{maximum:15,reason:'pattern',iconPresent:true,reliability:'pattern-ocr',patternOcrAgreed:true,
      ocrConfirmedValue:2,readings:[{engine:'digits',text:'+2',confidence:87,value:2}],
      pattern:{value:2,candidate:2,score:.6,gap:.3,reason:'distinct'}},
  });
  record(inventory, input, value);
  record(inventory, source(30), card(source(30), {extraCopies:null,review:['추가 장수 확인'],countReliable:false}));
  record(inventory, {...source(20),phase:'recovery'}, card(source(20), {extraCopies:1}));
  const wireSeed = serializeInventorySeed([seed]);
  assert.equal(wireSeed.includes('data:image'), false);
  assert.equal(events.join('').includes('data:image'), false);
  assert.equal(events.some(event => event.includes('"image"')), false);
  const replay = replayInventoryEvidence(parseInventorySeed(wireSeed).cards, events);
  assert.deepEqual(replay.snapshot(), inventory.snapshot());
  assert.equal(await hashInventoryEvidence(replay.snapshot()), await hashInventoryEvidence(inventory.snapshot()));
  assert.equal(replay.cards.get('card')!.image, '');
  assert.equal(inventory.cards.get('card')!.image, card(source(20)).image);
  assert.deepEqual(parseInventoryEvent(events[2]).kind, 'observation-recorded');
  const data = inventoryEventData({version:1,kind:'observation-recorded',source:input,card:value,borderAlignment:.9});
  assert.equal(data.kind, 'observation-recorded');
  if (data.kind === 'observation-recorded') assert.deepEqual(data.card.nameEvidence, value.nameEvidence);
});

test('replay rejects missing acceptance, provenance mismatches and malformed values instead of coercing proof', () => {
  const input = source(), value = card(input);
  const event = {version:1,kind:'observation-recorded',source:input,card:value,borderAlignment:1};
  for (const changed of [{captureOrder:11},{time:99},
    {capturePosition:{...value.capturePosition!,frame:'wrong'}},{capturePosition:{...value.capturePosition!,slot:1}}])
    assert.throws(() => parseInventoryEvent({...event,card:{...value,...changed}}), /mismatch/);
  assert.throws(() => replayInventoryEvidence([], [event]), /acceptance missing/);
  for (const invalid of [null,'0',undefined,NaN,Infinity])
    assert.throws(() => parseInventoryEvent({...event,source:{...input,captureOrder:invalid}}));
  assert.throws(() => parseInventoryEvent({...event,card:{...value,extraCopies:'0'}}));
  assert.throws(() => parseInventoryEvent({...event,card:{...value,review:new Array(1)}}), /string/);
  assert.throws(() => parseInventorySeed({version:1,cards:[value,value]}), /duplicate/);
  assert.throws(() => parseInventorySeed({version:1,cards:new Array(1)}), /sparse/);
  assert.deepEqual(parseInventorySeed(serializeInventorySeed([])), {version:1,cards:[]});
});

test('latest diagnostics retain the original 1000-ID eviction and same-order replacement behavior', () => {
  const inventory = new InventoryEvidence();
  for (let i = 0; i <= 1000; i++) record(inventory, source(10), card(source(10), {id:`card-${i}`}));
  assert.equal(inventory.latestFieldObservations.size, 1000);
  assert.equal(inventory.latestFieldObservations.has('card-0'), false);
  assert.equal(inventory.cards.size, 1001);
  const replacement = record(inventory, source(5), card(source(5), {id:'card-0',extraCopies:null,countReliable:false,review:['추가 장수 확인']}));
  assert.equal(replacement.latestDiagnostic, true, 'evicted diagnostic state does not retain a hidden ordering barrier');
  assert.equal(inventory.latestFieldObservations.get('card-0')!.card.captureOrder, 5);
  assert.equal(inventory.latestFieldObservations.has('card-1'), false);
  const same = record(inventory, source(5), card(source(5), {id:'card-0',extraCopies:0}));
  assert.equal(same.diagnosticResolved, true);
  assert.equal(inventory.latestFieldObservations.get('card-0')!.card.extraCopies, 0);
  assert.equal(inventory.latestIdentityOrder.get('card-0'), 10);
});

test('existing append and consensus behavior is retained across reliable, uncertain, manual and duplicate inputs', () => {
  const inventory = new InventoryEvidence(), history: ScannedCard[] = [];
  const values = [card(source(10)), card(source(30), {awakening:4,extraCopies:5}),
    card(source(20), {extraCopies:14}), card(source(40), {extraCopies:null,countReliable:false,review:['추가 장수 확인']}),
    card(source(40), {extraCopies:null,countReliable:false,review:['추가 장수 확인']}),
    card(source(50), {awakening:3,extraCopies:6,manual:['awakening','extraCopies']})];
  for (const value of values) {
    record(inventory, source(value.captureOrder!), value);
    appendObservation(history, value);
    assert.deepEqual(inventory.cards.get('card'), consensus(history));
    assert.equal(inventory.evidence.get('card')!.length, history.length);
  }
});

test('recorder callback errors remain visible and cannot mutate the already accepted state', () => {
  const failure = new Error('record failed'), inventory = new InventoryEvidence([], {onEvent:() => {throw failure;}});
  assert.throws(() => inventory.acceptIdentity(source(), 'card'), error => error === failure);
  assert.equal(inventory.latestIdentityOrder.get('card'), 10);
  assert.equal(inventory.confirmedFieldOrder.size, 0);
});

test('late sort is an explicit exact-source update, never an extra vote or name/field proof', async () => {
  const events: string[] = [], inventory = new InventoryEvidence([], {onEvent:event => events.push(serializeInventoryEvent(event))});
  const input = source(), value = card(input, {review:['이름 확인'],nameEvidence:[proof({exact:false,ocrConfidence:60})]});
  assert.equal(inventory.observeSort(input, value.id, {kind:'name',direction:'asc'}), false);
  assert.equal(events.length, 0, 'sort before a recorded observation remains on the caller-owned pending position');
  record(inventory, input, value);
  const history = inventory.evidence.get('card')!, before = inventory.snapshot(), originalEvent = events[1];
  assert.equal(inventory.observeSort(input, value.id, {kind:'name',direction:'asc'}), true);
  assert.equal(inventory.evidence.get('card')!.length, 1);
  assert.equal(inventory.cards.get('card')!.observations, 1);
  assert.deepEqual(inventory.evidence.get('card')![0].capturePosition!.sort, {kind:'name',direction:'asc'});
  assert.deepEqual(inventory.latestFieldObservations.get('card')!.card.capturePosition!.sort, {kind:'name',direction:'asc'});
  assert.equal(history[0].capturePosition!.sort, null, 'already published historical references are immutable');
  assert.deepEqual(inventory.snapshot().confirmedNameOrder, before.confirmedNameOrder);
  assert.deepEqual(inventory.snapshot().confirmedFieldOrder, before.confirmedFieldOrder);
  assert.deepEqual(inventory.snapshot().latestIdentityOrder, before.latestIdentityOrder);
  assert.equal(events[1], originalEvent);
  const eventCount = events.length;
  assert.equal(inventory.observeSort(input, value.id, {kind:'name',direction:'asc'}), false);
  assert.equal(events.length, eventCount);
  assert.equal(inventory.observeSort({...input,observationId:'retry-of-same-position'}, value.id, {kind:'name',direction:'desc'}), true);
  const replay = replayInventoryEvidence([], events);
  assert.deepEqual(replay.snapshot(), inventory.snapshot());
  assert.equal(await hashInventoryEvidence(replay.snapshot()), await hashInventoryEvidence(inventory.snapshot()));
});

test('late sort never updates a different card, order, time, frame or slot', () => {
  const inventory = new InventoryEvidence(), input = source(); record(inventory, input);
  const before = inventory.snapshot();
  for (const change of [{captureOrder:9},{captureTime:2},{frame:'other/frame'},{slot:1}])
    assert.equal(inventory.observeSort({...input,...change}, 'card', {kind:'name',direction:'asc'}), false);
  assert.equal(inventory.observeSort(input, 'other', {kind:'name',direction:'asc'}), false);
  assert.deepEqual(inventory.snapshot(), before);
  assert.throws(() => parseInventoryEvent({version:1,kind:'sort-observed',source:input,id:'card',sort:undefined}), /object/);
});

test('external object events and JSON events share the UTF-8 byte cap, independent of optional image size', () => {
  const input = source(), value = card(input, {nameEvidence:Array.from({length:6}, (_, index) =>
    proof({readingId:`reading-${index}`,rawText:'가'.repeat(65_536)}))});
  const event: InventoryEvent = {version:1,kind:'observation-recorded',source:input,card:value,borderAlignment:1};
  assert.ok(JSON.stringify(event).length < 1_048_576, 'UTF-16 character count alone would permit this event');
  assert.throws(() => parseInventoryEvent(event), /event byte limit/);
  assert.throws(() => parseInventoryEvent(JSON.stringify(event)), /event byte limit/);
  assert.throws(() => serializeInventoryEvent(event), /event byte limit/);
  const withImage = {...event,card:card(input,{image:'x'.repeat(1_048_577)})};
  const parsed = parseInventoryEvent(withImage);
  assert.equal(parsed.kind, 'observation-recorded');
  if (parsed.kind === 'observation-recorded') assert.equal(parsed.card.image, '');
  assert.equal(JSON.stringify(parseInventorySeed({version:1,cards:[withImage.card]})).includes('xxx'), false);
});

test('a stable preview re-read can confirm field proof without adding an observation',()=>{
  const inventory=new InventoryEvidence([]);
  assert.equal(inventory.confirmedFieldOrder.get('card'),undefined);
  inventory.confirmPreviewField('card',10);
  assert.equal(inventory.confirmedFieldOrder.get('card'),10);
  inventory.confirmPreviewField('card',5);
  assert.equal(inventory.confirmedFieldOrder.get('card'),10,'older preview evidence cannot replace newer proof');
  inventory.confirmPreviewField('',20);
  inventory.confirmPreviewField('card',Number.NaN);
  assert.equal(inventory.confirmedFieldOrder.get('card'),10);
});

test('final preview rescue exposes identity, name and field maps without older replacement',()=>{
  const inventory=new InventoryEvidence([]);
  inventory.confirmPreviewCard(card(source(10),{id:'rescue'}),10);
  assert.equal(inventory.cards.get('rescue')?.id,'rescue');
  assert.equal(inventory.latestIdentityOrder.get('rescue'),10);
  assert.equal(inventory.confirmedNameOrder.get('rescue'),10);
  assert.equal(inventory.confirmedFieldOrder.get('rescue'),10);
  inventory.confirmPreviewCard(card(source(5),{id:'rescue',name:'older'}),5);
  assert.equal(inventory.cards.get('rescue')?.name,'카드','older preview cannot replace a newer rescue');
  assert.equal(inventory.latestIdentityOrder.get('rescue'),10);
});

test('preview confirmations are recorded and replay to the same inventory state',async()=>{
  const facts:InventoryPreviewConfirmation[]=[],events:InventoryEvent[]=[];
  const live=new InventoryEvidence([],{onEvent:event=>events.push(event),onPreviewConfirmation:fact=>facts.push(fact)});
  record(live,source(10));
  live.confirmPreviewField('card',50);
  live.confirmPreviewCard(card(source(60),{id:'rescue',name:'구조'}),60);
  live.confirmPreviewField('',70);                      // rejected input is not a mutation
  live.confirmPreviewField('card',20);                  // an older order still reaches the live reducer's early-return path
  assert.deepEqual(facts.map(fact=>fact.kind),['preview-field','preview-card','preview-field'],'only accepted calls are recorded');
  const seed=Object.freeze({version:1 as const,cards:[]});
  const replay=new InventoryEvidenceReplay(new AbortController().signal);
  replay.seed(seed);
  for(const event of events)replay.accept(inventoryEventData(event));
  const withoutFacts=await replay.summary();
  for(const fact of facts)replay.previewConfirmation(JSON.parse(JSON.stringify(fact)));
  const withFacts=await replay.summary();
  const liveHash=await hashInventoryEvidence(live.snapshot());
  assert.equal(withFacts.hash,liveHash,'replaying the facts reproduces the live state');
  assert.notEqual(withoutFacts.hash,liveHash,'omitting them is exactly the defect: the proof maps differ');
  assert.equal(replay.confirmedFieldOrder.get('card'),live.confirmedFieldOrder.get('card'));
  assert.equal(replay.confirmedFieldOrder.get('rescue'),60);
});

test('replaying a preview confirmation never re-emits it and rejects malformed facts',()=>{
  const facts:InventoryPreviewConfirmation[]=[];
  const inventory=new InventoryEvidence([],{onPreviewConfirmation:fact=>facts.push(fact)});
  inventory.applyPreviewConfirmation(parseInventoryPreviewConfirmation({version:1,kind:'preview-field',id:'card',order:4}));
  assert.equal(facts.length,0);
  assert.equal(inventory.confirmedFieldOrder.get('card'),4);
  inventory.confirmPreviewField('card',9);
  assert.equal(facts.length,1,'live calls still emit after a replay call');
  assert.throws(()=>parseInventoryPreviewConfirmation({version:1,kind:'preview-field',id:'card',order:-1}));
  assert.throws(()=>parseInventoryPreviewConfirmation({version:1,kind:'preview-field',order:1}));
  assert.throws(()=>parseInventoryPreviewConfirmation({version:1,kind:'preview-field',id:'card',order:1,card:{}}));
  assert.throws(()=>parseInventoryPreviewConfirmation({version:1,kind:'other',order:1}));
});
