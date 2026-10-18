import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RecentScanActivity} from '../src/features/card-scanner/scan-activity';

test('activity retains at most sixteen thumbnails and ignores late completion of evicted work',()=>{
  const activity=new RecentScanActivity();
  for(let i=0;i<30;i++)activity.start(i,`crop-${i}`);
  activity.finish(0,'read','old card');
  assert.equal(activity.snapshot().length,16);
  assert.equal(activity.snapshot()[0].id,14);
  assert.equal(activity.snapshot().some(item=>item.name==='old card'),false);
});
test('retries reuse one tile, snapshots stay immutable, and new sessions start empty',()=>{
  const activity=new RecentScanActivity();activity.start(7,'pixels');
  const before=activity.snapshot();activity.finish(7,'waiting');
  assert.equal(before[0].status,'reading');
  activity.start(7,'clearer');activity.finish(7,'read','card');
  assert.deepEqual(activity.snapshot(),[{id:7,image:'clearer',status:'read',name:'card'}]);
  assert.deepEqual(new RecentScanActivity().snapshot(),[]);
});
