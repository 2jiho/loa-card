import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendObservation} from '../src/features/card-scanner/observation-history';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

test('same-frame retries do not accumulate identical evidence; changes and fresh captures stay separate',()=>{
  const card={id:'a',name:'A',awakening:0,extraCopies:1,countReliable:true,confidence:1,review:[],observations:1,
    image:'image',time:1,captureOrder:10,capturePosition:{frame:'frame'}} as ScannedCard;
  const history:ScannedCard[]=[];
  assert.equal(appendObservation(history,card),true);
  for(let i=0;i<100;i++)assert.equal(appendObservation(history,{...card}),false);
  assert.equal(history.length,1);
  assert.equal(appendObservation(history,{...card,extraCopies:2}),true);
  assert.equal(appendObservation(history,{...card,captureOrder:20,capturePosition:{...card.capturePosition!,frame:'other'}}),true);
  assert.equal(appendObservation(history,{...card,review:['이름 확인']}),true);
  assert.equal(history.length,4);
});
