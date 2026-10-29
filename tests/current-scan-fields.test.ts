import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consensus } from '../src/features/card-scanner/consensus';
import { CURRENT_FIELD_REVIEW, MAX_UNRESOLVED_FIELD_CHANGES, boundedCountDiagnostics, boundedUnresolvedFieldChanges, carryUnattributedFieldReviews, hasCurrentFieldProof, pendingScanFields, projectCurrentScanFields, unattributedFieldReviewCount } from '../src/features/card-scanner/current-scan-fields';
import { confirmedReadingCount } from '../src/features/card-scanner/recovery-completion';
import { scanCompletion } from '../src/features/card-scanner/completion';
import type { ScannedCard } from '../src/features/card-scanner/recognizer';
import { inventoryCsv, inventoryCsvIssues } from '../src/inventory-csv';
import { remainingMerchantCopies } from '../src/features/merchants/merchant-progress';
import { trustedInventory } from '../src/features/growth/optimizer';
import { raidMembers } from '../src/features/raid/raid-progress';
import type { RaidSet } from '../src/features/raid/raid-progress';
import { inventoryBackupState } from '../src/features/card-scanner/scan-backup';
import type { ScannerState } from '../src/features/card-scanner/scanner';

const original: ScannedCard = { id:'3200416', name:'하누마탄', awakening:0, extraCopies:0, review:[], countReliable:true,
  confidence:1, image:'old-good', time:1, observations:1, captureOrder:10 };
const failed: ScannedCard = { ...original, extraCopies:null, countReliable:false, review:['추가 장수 확인'],
  image:'latest-unresolved', time:2, captureOrder:20,
  countDiagnostics:{maximum:15,reason:'추가 장수 영역 가림 또는 불명확',readings:[]},
  capturePosition:{frame:'frame-20',slot:3,stable:true,sort:null} };
const proof = (latest=20, confirmed=10) => ({ latest:new Map([[original.id,latest]]), confirmed:new Map([[original.id,confirmed]]) });

test('394 collected identities with one stale zero publish 393 confirmed and one review', () => {
  const history = [failed, original], merged = consensus(history);
  assert.deepEqual(merged.review, [], 'consensus deliberately preserves the old complete pair');
  const others = Array.from({length:393}, (_,i) => ({...original,id:`other-${i}`,name:`카드 ${i}`}));
  const evidence = proof();
  for (const card of others) { evidence.latest.set(card.id,10); evidence.confirmed.set(card.id,10); }
  const before = structuredClone({history,merged});
  const cards = projectCurrentScanFields([merged,...others], evidence);
  assert.equal(cards.length,394);
  assert.equal(confirmedReadingCount({cards,...evidence}),393);
  assert.equal(cards.filter(card=>card.review.length).length,1);
  assert.equal(scanCompletion(394,cards.length,1,394),'입력 처리 완료 · 수량 일치 · 1종 판독 확인 필요');
  assert.deepEqual([cards[0].awakening,cards[0].extraCopies],[0,0]);
  assert.equal(cards[0].countReliable,false);
  assert.ok(cards[0].review.includes(CURRENT_FIELD_REVIEW));
  assert.equal(cards[0].image,'old-good');
  assert.equal(cards[0].time,1);
  assert.deepEqual({history,merged},before,'presentation cannot contaminate the consensus history');
  assert.equal(cards[1],others[0],'confirmed cards remain untouched');
});

test('the published uncertainty blocks CSV and all numeric calculation consumers', () => {
  const cards = projectCurrentScanFields([consensus([original,failed])],proof());
  const definitions = [{id:original.id,name:original.name,rarity:5,
    steps:Array.from({length:5},(_,i)=>({copies:i+1,xp:0,silver:0}))}];
  const set: RaidSet = {id:'test',name:'test',alias:'test',role:'dealer',element:'general',slots:1,cardIds:[original.id],stages:[]};
  assert.equal(inventoryCsvIssues(cards).length,1);
  assert.throws(()=>inventoryCsv(cards),/확인 필요/);
  assert.equal(remainingMerchantCopies(cards[0]),null);
  assert.deepEqual(trustedInventory({version:'test',cards:definitions,books:[],targets:[]},cards).valid,[]);
  assert.deepEqual(raidMembers(set,{version:'test',cards:definitions,sets:[set]},cards,true)
    .map(({status,awakening,copies})=>({status,awakening,copies})),[{status:'unknown',awakening:null,copies:null}]);
});

test('a newly confirmed observation removes the projection without losing the valid zero', () => {
  const history = [original,failed], old = consensus(history);
  const pending = projectCurrentScanFields([old],proof());
  const renewed = {...original,captureOrder:30,time:3,image:'new-good'};
  history.push(renewed);
  const raw = consensus(history), evidence = proof(30,30);
  const cards = projectCurrentScanFields([raw],evidence);
  assert.equal(cards[0],raw);
  assert.deepEqual(cards[0].review,[]);
  assert.equal(cards[0].countReliable,true);
  assert.equal(cards[0].extraCopies,0);
  assert.equal(confirmedReadingCount({cards,...evidence}),1);
  assert.equal(inventoryCsvIssues(cards).length,0);
  assert.ok(pending[0].review.includes(CURRENT_FIELD_REVIEW),'older published snapshots remain immutable');
});

test('missing and nonfinite proof cannot certify this run; unobserved seeds stay historical', () => {
  const seed = {...original,id:'seed'};
  for (const confirmed of [NaN,Infinity,-Infinity,9]) {
    const evidence = proof(10,confirmed);
    assert.equal(hasCurrentFieldProof(original.id,evidence),false);
    assert.equal(projectCurrentScanFields([original],evidence)[0].countReliable,false);
  }
  const evidence = {...proof(),confirmed:new Map<string,number>()};
  const cards = projectCurrentScanFields([original,seed],evidence);
  assert.ok(cards[0].review.includes(CURRENT_FIELD_REVIEW));
  assert.equal(cards[1],seed);
  assert.equal(confirmedReadingCount({cards,...evidence}),0);
  const reviewed = {...original,review:['이름 확인']};
  assert.deepEqual(projectCurrentScanFields([reviewed],proof())[0].review,['이름 확인',CURRENT_FIELD_REVIEW]);
  assert.deepEqual(projectCurrentScanFields(cards,evidence)[0].review,[CURRENT_FIELD_REVIEW]);
});

test('pending diagnostics expose the latest failed source separately from old confirmed values', () => {
  const observations = [{card:failed,borderAlignment:.7}];
  const pending = pendingScanFields(observations,proof());
  assert.deepEqual(pending,[{id:original.id,name:original.name,image:'latest-unresolved',time:2,captureOrder:20,
    reason:'추가 장수 확인',countReason:'추가 장수 영역 가림 또는 불명확',stable:true,borderAlignment:.7,
    countDiagnostics:boundedCountDiagnostics(failed.countDiagnostics)}]);
  assert.deepEqual(pendingScanFields(observations,proof(20,20)),[]);
  assert.deepEqual(pendingScanFields([{card:original,borderAlignment:1}],proof()),[],
    'an older diagnostic source cannot impersonate the latest failed capture');
});

test('pending fields retain bounded numeric evidence without changing the preview or reader diagnostics', () => {
  const diagnostic = {maximum:15,reason:'가림',iconPresent:false,patternOcrAgreed:false,ocrConfirmedValue:0,
    pattern:{value:null,candidate:1,score:.29,gap:.01,reason:'대비 부족'},
    readings:[{engine:'PP-OCRv6 숫자 영역',text:'+1',confidence:71.5,value:1}]};
  const card = {...failed,countDiagnostics:diagnostic};
  const [pending] = pendingScanFields([{card,borderAlignment:.7}],proof());
  assert.equal(pending.image,failed.image);
  assert.equal(pending.recognitionImage,undefined);
  assert.equal(pending.countDiagnostics?.iconPresent,false);
  assert.deepEqual(pending.countDiagnostics?.pattern,diagnostic.pattern);
  assert.deepEqual(pending.countDiagnostics?.readings,diagnostic.readings);
  diagnostic.pattern.score=.9;diagnostic.readings[0].value=9;
  assert.equal(pending.countDiagnostics?.pattern?.score,.29);
  assert.equal(pending.countDiagnostics?.readings[0].value,1);
  const large={...diagnostic,reason:'R'.repeat(2000),pattern:{...diagnostic.pattern,reason:'P'.repeat(2000)},
    readings:Array.from({length:100},()=>({engine:'E'.repeat(1000),text:'T'.repeat(1000),confidence:12,value:null})),
    image:'raw pixels',trace:{sensitive:'not numeric evidence'}};
  const bounded=boundedCountDiagnostics(large)!;
  assert.equal(bounded.readings.length,12);
  assert.equal(bounded.readings[0].engine.length,48);
  assert.equal(bounded.readings[0].text.length,80);
  assert.equal(bounded.reason.length,300);
  assert.equal(bounded.pattern?.reason.length,300);
  assert.equal('image' in bounded,false);assert.equal('trace' in bounded,false);
});

test('bounded field diagnostics preserve explicit gray-empty evidence and omit unknown evidence kinds',()=>{
  const kind='gray-card-marker-and-visible-background' as const;
  const diagnostic={maximum:15,reason:'회색 카드 표식 · 빈 장수 배경 확인',readings:[],iconPresent:false,
    emptyEvidence:kind,pattern:{value:null,candidate:null,score:0,gap:0,reason:'회색 카드 표식 · 빈 장수 배경 확인',emptyEvidence:kind}};
  const result=boundedCountDiagnostics(diagnostic)!;
  assert.equal(result.emptyEvidence,kind);assert.equal(result.pattern?.emptyEvidence,kind);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),diagnostic);
  const absent=boundedCountDiagnostics({maximum:15,reason:'기존 진단',readings:[]})!;
  assert.equal('emptyEvidence' in absent,false);
  const invalid=structuredClone(diagnostic);
  invalid.emptyEvidence='arbitrary artwork claim' as typeof kind;
  invalid.pattern.emptyEvidence='arbitrary artwork claim' as typeof kind;
  const bounded=boundedCountDiagnostics(invalid)!;
  assert.equal('emptyEvidence' in bounded,false);assert.equal('emptyEvidence' in bounded.pattern!,false);
});

test('legacy aggregate deficits remain visible without inventing an affected ID', () => {
  const cards = [original], before = structuredClone(cards);
  assert.equal(unattributedFieldReviewCount({cards,currentRunNames:394,currentRunRead:393}),1);
  assert.equal(unattributedFieldReviewCount({cards:projectCurrentScanFields(cards,proof()),currentRunNames:394,currentRunRead:393}),0);
  assert.equal(unattributedFieldReviewCount({cards:[{...original,review:['추가 장수 확인']}],currentRunNames:394,currentRunRead:393}),1,
    'an unrelated old review cannot explain which card lost its latest proof');
  assert.equal(unattributedFieldReviewCount({cards,currentRunNames:394,currentRunRead:394}),0);
  assert.equal(unattributedFieldReviewCount({cards}),0,'CSV has no run proof counters');
  assert.equal(unattributedFieldReviewCount({cards,currentRunRead:0}),0,'unknown name count is not evidence of a deficit');
  assert.equal(unattributedFieldReviewCount({cards,currentRunNames:NaN,currentRunRead:0}),0);
  assert.deepEqual(cards,before);
});

test('legacy proof gaps survive partial rescans and backup until the whole inventory is freshly confirmed', () => {
  const initial = {cards:[original,{...original,id:'other'}],expected:2,currentRunNames:2,currentRunRead:1};
  const gap = unattributedFieldReviewCount(initial);
  assert.equal(gap,1);
  const partial = {...initial,currentRunNames:1,currentRunRead:1};
  const carried = carryUnattributedFieldReviews(gap,partial);
  assert.equal(carried,1);
  const restored = inventoryBackupState({...partial,unattributedFieldReviews:carried} as ScannerState);
  assert.equal(restored.unattributedFieldReviews,1);
  assert.equal(unattributedFieldReviewCount(restored),1);
  const fresh = {...initial,currentRunRead:2};
  assert.equal(carryUnattributedFieldReviews(gap,fresh),0);
  for (const change of [{expected:null},{expected:3},{currentRunRead:1},{currentRunNames:1},
    {cards:[original,{...original,id:'other',countReliable:false}]},
    {cards:[original,{...original,id:'other',review:['추가 장수 확인']}]}])
    assert.equal(carryUnattributedFieldReviews(gap,{...fresh,...change}),1);
  assert.equal(unattributedFieldReviewCount({cards:[original],unattributedFieldReviews:1}),1,'run initialization cannot hide the carry');
});

test('unidentified changed fields block global use even when every retained card is confirmed', () => {
  const fresh={cards:[original],expected:1,currentRunNames:1,currentRunRead:1,unresolvedFieldChanges:2};
  const before=structuredClone(fresh);
  assert.equal(unattributedFieldReviewCount(fresh),2);
  assert.equal(unattributedFieldReviewCount({...fresh,unattributedFieldReviews:1}),2,'overlapping aggregate warnings are not added');
  assert.equal(carryUnattributedFieldReviews(0,fresh),2,'a new unresolved source must not require a pre-existing carry');
  assert.equal(carryUnattributedFieldReviews(3,fresh),3);
  assert.equal(carryUnattributedFieldReviews(2,{...fresh,unresolvedFieldChanges:0}),0,'fresh complete proof can clear a carried warning');
  assert.deepEqual(fresh,before,'no affected identity or field is invented');
});

test('changed-field summaries accept only bounded integers and never invoke optional getters', () => {
  assert.deepEqual(boundedUnresolvedFieldChanges({}),{});
  assert.deepEqual(boundedUnresolvedFieldChanges({unresolvedFieldChanges:undefined}),{});
  for(const count of [0,1,MAX_UNRESOLVED_FIELD_CHANGES])
    assert.deepEqual(boundedUnresolvedFieldChanges({unresolvedFieldChanges:count}),{unresolvedFieldChanges:count});
  for(const count of [null,-1,.5,NaN,Infinity,MAX_UNRESOLVED_FIELD_CHANGES+1]){
    const state={cards:[original],unresolvedFieldChanges:count} as unknown as Parameters<typeof unattributedFieldReviewCount>[0];
    assert.deepEqual(boundedUnresolvedFieldChanges(state),{unresolvedFieldChangesUnavailable:true});
    assert.equal(unattributedFieldReviewCount(state),1,'malformed optional proof remains a global warning');
  }
  const accessor=Object.defineProperty({cards:[original]},'unresolvedFieldChanges',{get(){throw Error('must not read getter');}});
  assert.deepEqual(boundedUnresolvedFieldChanges(accessor),{unresolvedFieldChangesUnavailable:true});
  assert.equal(unattributedFieldReviewCount(accessor),1);
});
