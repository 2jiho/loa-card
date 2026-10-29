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

test('a late thumbnail fills its exact trace without reordering or resetting completed state',()=>{
 const activity=new RecentScanActivity();activity.start(1,'');activity.start(2,'newer');
 activity.finish(1,'read','first');const before=activity.snapshot();
 assert.equal(activity.updateImage(1,'ready-first'),true);
 assert.deepEqual(activity.snapshot().map(item=>item.id),[1,2]);
 assert.deepEqual(activity.snapshot()[0],{id:1,image:'ready-first',name:'first',status:'read'});
 assert.equal(before[0].image,'','previously published snapshots remain immutable');
 assert.equal(activity.snapshot()[1].image,'newer');
 assert.equal(activity.updateImage(1,'ready-first'),false);assert.equal(activity.updateImage(1,''),false);
});

test('an evicted thumbnail cannot return to the strip or replace the latest crop image',()=>{
 const activity=new RecentScanActivity();
 for(let id=1;id<=17;id++)activity.start(id,`capture-${id}`);
 const before=activity.snapshot();
 assert.equal(activity.updateImage(1,'late-old'),false);
 assert.equal(activity.snapshot(),before);assert.equal(activity.snapshot().at(-1)?.image,'capture-17');
});

test('a previous attempt cannot reset the same trace while its retry is running or complete',()=>{
 const activity=new RecentScanActivity();
 const first=activity.start(1,'crop');
 const retry=activity.start(1,'crop');
 activity.finish(1,'waiting',undefined,first);
 assert.equal(activity.snapshot()[0].status,'reading');
 activity.finish(1,'read','card',retry);
 activity.finish(1,'review',undefined,first);
 assert.equal(activity.snapshot()[0].status,'read');
});
