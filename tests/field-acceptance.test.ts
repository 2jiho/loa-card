import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observedCard,readFieldReliability,settleReadFields} from '../src/features/card-scanner/session/field-acceptance';
import type {CountDiagnostics} from '../src/features/card-scanner/recognition/recognizer-types';

const diagnostics=(extra:Partial<CountDiagnostics>={}):CountDiagnostics=>({maximum:15,reason:'판독',readings:[],...extra});

test('a zero that this crop cannot confirm stays unread, and unread values are flagged for review', () => {
  // No icon inspected, borders not intact: nothing shows that the counter is empty.
  const values={awakening:2,extraCopies:0 as number|null,countDiagnostics:diagnostics()};
  const reliability=readFieldReliability(values,{stable:false,borderAlignment:.5});
  assert.equal(reliability,'unconfirmed');
  const review=settleReadFields(values,[],reliability);
  assert.equal(values.extraCopies,null);
  assert.deepEqual(review,['추가 장수 확인']);
  assert.equal(values.countDiagnostics.reliability,'unconfirmed');
  assert.match(values.countDiagnostics.reason,/추가 카드 표시 없음/);
});

test('an explicitly observed empty counter on an intact card is a zero, not unread', () => {
  const values={awakening:3,extraCopies:0 as number|null,countDiagnostics:diagnostics({iconPresent:false})};
  const reliability=readFieldReliability(values,{stable:false,borderAlignment:.95});
  assert.equal(reliability,'empty-counter');
  assert.deepEqual(settleReadFields(values,[],reliability),[]);
  assert.equal(values.extraCopies,0);
  assert.equal(values.countDiagnostics.reason,'판독');
});

test('review keeps the identity flags first and adds one flag per unread value', () => {
  const values={awakening:null,extraCopies:null};
  const reliability=readFieldReliability(values,{stable:true,borderAlignment:1});
  assert.equal(reliability,'unconfirmed');                         // an unread count is never reliable, stable or not
  const identityReview=['이름 확인'];
  assert.deepEqual(settleReadFields(values,identityReview,reliability),['이름 확인','각성 확인','추가 장수 확인']);
  assert.deepEqual(identityReview,['이름 확인']);                   // the identity's own list is not changed
});

test('a positive count keeps its value whatever its reliability; only the reliable flag differs', () => {
  const weak={awakening:1,extraCopies:4 as number|null,countDiagnostics:diagnostics()};
  const reliability=readFieldReliability(weak,{stable:false,borderAlignment:.95});
  assert.equal(reliability,'unconfirmed');
  assert.deepEqual(settleReadFields(weak,[],reliability),[]);
  assert.equal(weak.extraCopies,4);
  const position={frame:"f1",slot:7,stable:false,sort:null};
  const identity={id:'1',name:'카드',confidence:1,review:[] as string[],maxAwakening:5,nameEvidence:[{engine:'portrait',text:'카드',confidence:1}]};
  const card=observedCard({identity,values:weak,review:[],reliability,image:'',time:1.5,order:42,stable:false,position});
  assert.deepEqual({reliable:card.countReliable,observations:card.observations,order:card.captureOrder,time:card.time,position:card.capturePosition},
    {reliable:false,observations:1,order:42,time:1.5,position});
  assert.deepEqual(card.nameEvidence,[{engine:'portrait',text:'카드',confidence:1,stable:false,frame:'f1'}]);
  assert.equal(observedCard({identity,values:weak,review:[],reliability:'clear-pattern',image:'',time:1.5,order:42,stable:false,position}).countReliable,true);
});

test('a still list does not certify a count the patterns alone read; it does one the text reader read', () => {
  // A weak pattern reading (score 0.23, gap 0.02 at a resampled crop): on a still list the same
  // misread repeats on the same pixels, so stillness adds nothing.
  const weak={awakening:1,extraCopies:4 as number|null,countDiagnostics:{maximum:14,reason:'장수 전체 패턴 일치',readings:[],iconPresent:true,
    pattern:{value:4,candidate:4,score:.23,gap:.02,reason:'장수 전체 패턴 일치',contrastFloor:.22}}};
  assert.equal(readFieldReliability(weak,{stable:true,borderAlignment:.95}),'unconfirmed');
  // The text reader read the same value on its own (where the patterns cannot read the digits):
  // a still list counts, as before.
  const read={awakening:0,extraCopies:15 as number|null,countDiagnostics:{maximum:15,reason:'숫자 근거 일치로 확정',readings:[],iconPresent:true,ocrConfirmedValue:15,
    pattern:{value:null,candidate:13,score:.2,gap:.01,reason:'숫자 획과 외곽선 대비 부족',contrastFloor:.22}}};
  assert.equal(readFieldReliability(read,{stable:true,borderAlignment:1}),'stable-frame');
  assert.equal(readFieldReliability(read,{stable:false,borderAlignment:1}),'unconfirmed');
});
