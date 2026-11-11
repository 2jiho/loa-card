import {test} from 'node:test';
import assert from 'node:assert/strict';
import {displayCardFields} from '../src/features/card-scanner/acquisition/card-tile-fields';
import {CURRENT_FIELD_REVIEW,projectCurrentScanFields} from '../src/features/card-scanner/session/current-scan-fields';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

const card:ScannedCard={id:'c',name:'카드',awakening:2,extraCopies:0,review:[],countReliable:true,
  confidence:1,image:'',time:1,observations:1};

test('current confirmed values, including zero, remain visible',()=>{
 assert.deepEqual(displayCardFields(card),{awakening:2,extraCopies:0});
 assert.deepEqual(displayCardFields({...card,awakening:0,extraCopies:15}),{awakening:0,extraCopies:15});
});

test('newer unresolved observation hides the retained historical pair without changing it',()=>{
 const evidence={latest:new Map([['c',20]]),confirmed:new Map([['c',10]])};
 const [projected]=projectCurrentScanFields([card],evidence);
 assert.ok(projected.review.includes(CURRENT_FIELD_REVIEW));
 assert.deepEqual(displayCardFields(projected),{awakening:null,extraCopies:null});
 assert.deepEqual([projected.awakening,projected.extraCopies],[2,0]);
 assert.deepEqual([card.awakening,card.extraCopies,card.countReliable],[2,0,true]);
});

test('unknown numeric fields and field-specific review remain unknown independently',()=>{
 assert.deepEqual(displayCardFields({...card,awakening:null,extraCopies:null}),{awakening:null,extraCopies:null});
 assert.deepEqual(displayCardFields({...card,review:['추가 장수 확인'],countReliable:false}),{awakening:2,extraCopies:null});
 assert.deepEqual(displayCardFields({...card,review:['각성 확인']}),{awakening:null,extraCopies:0});
 assert.deepEqual(displayCardFields({...card,review:['각성·장수 다시 확인']}),{awakening:null,extraCopies:null});
 assert.deepEqual(displayCardFields({...card,countReliable:false}),{awakening:2,extraCopies:null});
});

test('name-only review does not invent a numeric problem',()=>{
 assert.deepEqual(displayCardFields({...card,review:['이름 확인']}),{awakening:2,extraCopies:0});
});
