import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareLean} from '../dev/lean-scan';

const observed=(id:string,...values:[number,number|null,number|null][])=>({id,name:id.toUpperCase(),firstTime:values[0][0],
  observations:values.map(([time,awakening,extraCopies])=>({time,awakening,extraCopies}))});

test('the comparison separates cards only one side saw and compares the latest read value of each field', () => {
  const comparison=compareLean([
    observed('a',[1,2,3]),
    observed('b',[1,1,null],[2,1,4],[3,null,null]),      // latest value that was read: copies 4
    observed('c',[1,0,0]),                                // the scanner left the count unread
    observed('d',[1,3,null]),                             // the prototype never read the count
    observed('x',[1,0,0]),                                // not in the scanner's list
  ],[
    {id:'a',name:'A',awakening:2,extraCopies:3},{id:'b',name:'B',awakening:1,extraCopies:5},
    {id:'c',name:'C',awakening:0,extraCopies:null},{id:'d',name:'D',awakening:3,extraCopies:1},
    {id:'m',name:'M',awakening:1,extraCopies:1},
  ]);
  assert.equal(comparison.both,4);
  assert.deepEqual(comparison.onlyScanner,['M']);
  assert.deepEqual(comparison.onlyLean,['X']);
  assert.deepEqual(comparison.awakening,{same:4,different:[],leanUnread:0,scannerUnread:0});
  assert.deepEqual(comparison.extraCopies,{same:1,different:['B: 시제품 4, 스캐너 5'],leanUnread:1,scannerUnread:1});
  assert.deepEqual(comparison.unstable,[]);
});

test('cards whose own observations disagree are listed as unstable; an unread value is not a disagreement', () => {
  const comparison=compareLean([observed('a',[1,2,3],[2,2,null],[3,2,3]),observed('b',[1,1,0],[2,1,2])],[]);
  assert.deepEqual(comparison.unstable,['B']);
});
