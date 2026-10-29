import {test} from 'node:test';
import assert from 'node:assert/strict';
import {updateUnknown} from '../src/features/card-scanner/unknown-observations';
import {ConfirmedNameGroups} from '../src/features/card-scanner/confirmed-name-groups';

test('newer failure replaces time/image/reason and survives an older name proof',()=>{
  const vector=new Uint8Array(3240).fill(80),vectors:Uint8Array[]=[];
  const first={group:1,captureOrder:10,pending:false,image:'old',time:1,reason:'old'},entries:typeof first[]=[];
  assert.equal(updateUnknown(entries,vectors,first,vector),true);
  const latest={...first,captureOrder:30,image:'new',time:3,reason:'new'};
  assert.equal(updateUnknown(entries,vectors,latest,vector),true);assert.deepEqual(entries,[latest]);
  const names=new ConfirmedNameGroups();names.confirm(1,'a',20,[]);
  assert.equal(names.covers(entries[0].group,entries[0].captureOrder),false);
  names.confirm(1,'a',30,[]);
  assert.equal(names.covers(entries[0].group,entries[0].captureOrder),true);
});

test('pending retries and old results cannot regress final failure, but newer pending input updates it',()=>{
  const vector=new Uint8Array(3240).fill(90),vectors=[vector],entries=[{group:1,captureOrder:30,pending:false}];
  assert.equal(updateUnknown(entries,vectors,{group:1,captureOrder:10,pending:false},vector),false);
  assert.equal(updateUnknown(entries,vectors,{group:1,captureOrder:30,pending:true},vector),false);
  assert.equal(updateUnknown(entries,vectors,{group:1,captureOrder:40,pending:true},vector),true);
  assert.equal(updateUnknown(entries,vectors,{group:1,captureOrder:40,pending:false},vector),true);
  assert.equal(updateUnknown(entries,vectors,{group:2,captureOrder:40,pending:false},vector),true);
  assert.equal(entries.length,2,'identical low-resolution features do not merge different unknown groups');
});
