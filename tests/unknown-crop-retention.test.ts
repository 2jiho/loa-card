import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UnknownCropRetention,type UnknownCrop} from '../src/features/card-scanner/session/unknown-crop-retention';

function crop(order=1):UnknownCrop {
  return {source:{sessionId:'session',observationId:`observation-${order}`,frameId:order,frame:`frame-${order}`,
    captureOrder:order,captureTime:order/10,phase:'input',slot:3},recipe:'reader-rgba-v1',
    group:7,width:2,height:2,sourceWidth:100,sourceHeight:100,sourceBox:{x:1.5,y:2,width:20,height:30},
    rgba:new Uint8ClampedArray([1,2,3,255,4,5,6,255,7,8,9,255,10,11,12,255])};
}

test('retains independent bytes and exact source, even when caller releases or mutates its input',()=>{
  const store=new UnknownCropRetention({entries:2,bytes:32}),input=crop();
  const source={...input.source};
  assert.equal(store.retain(input),'retained');
  input.rgba.fill(0);
  (input.source as {captureTime:number}).captureTime=99;
  (input.sourceBox as {x:number}).x=90;
  const saved=store.get(source)!;
  assert.equal(saved.rgba[0],1);assert.equal(saved.source.captureTime,.1);assert.equal(saved.sourceBox.x,1.5);
  saved.rgba[0]=88;
  assert.equal(store.get(source)!.rgba[0],1,'reading returns another copy');
  assert.equal(store.get({...source,captureOrder:2}),undefined);
  assert.equal(store.release({...source,frame:'different'}),false);
  assert.equal(store.release(source),true);assert.equal(store.snapshot().bytes,0);
});

test('capacity is bounded without evicting earlier unresolved sources',()=>{
  const store=new UnknownCropRetention({entries:1,bytes:16}),a=crop(1),b=crop(2);
  assert.equal(store.retain(a),'retained');assert.equal(store.retain(b),'capacity');
  assert.equal(store.get(a.source)?.rgba[0],1);assert.equal(store.get(b.source),undefined);
  assert.equal(store.snapshot().capacityRefusals,1);
  assert.equal(store.release(a.source),true);assert.equal(store.retain(b),'retained');
  assert.equal(store.snapshot().capacityRefusals,1,'historical refusal is not silently erased');
  const bytes=new UnknownCropRetention({entries:5,bytes:15});
  assert.equal(bytes.retain(a),'capacity');assert.equal(bytes.snapshot().bytes,0);
});

test('same observation with changed bytes, geometry or capture metadata is a conflict',()=>{
  const store=new UnknownCropRetention({entries:3,bytes:48}),a=crop();
  assert.equal(store.retain(a),'retained');assert.equal(store.retain(crop()),'duplicate');
  const changed=crop();changed.rgba[15]=0;
  assert.equal(store.retain(changed),'conflict');
  assert.equal(store.retain({...crop(),recipe:'other'}),'conflict');
  assert.equal(store.retain({...crop(),source:{...a.source,captureOrder:5}}),'conflict');
  assert.equal(store.retain({...crop(),group:8}),'conflict');
  assert.equal(store.get(a.source)?.rgba[15],255);
  assert.equal(store.snapshot().conflicts,4);
});

test('pixel matching is exact and does not conflate a new source with the original',()=>{
  const store=new UnknownCropRetention({entries:2,bytes:32}),a=crop(1),b=crop(2);
  store.retain(a);
  assert.equal(store.matches(b),false,'different capture is not the original source');
  assert.equal(store.matchesPixels(a.source,b),true,'full same-recipe byte equality only');
  assert.deepEqual(store.matchingSources(b),[{source:a.source,group:a.group}],'returns the original source and group, not the later one');
  assert.equal(store.snapshot().entries,1,'matching does not retire or duplicate evidence');
  b.rgba[15]=0;
  assert.equal(store.matchesPixels(a.source,b),false,'alpha participates in comparison');
  assert.deepEqual(store.matchingSources(b),[]);
  assert.equal(store.matchesPixels(a.source,{...a,recipe:'different'}),false);
  assert.equal(store.matchesPixels(b.source,a),false,'lookup requires the exact original source');
});

test('invalid raster and source cannot be retained, and disposal invalidates all access',()=>{
  const store=new UnknownCropRetention({entries:1,bytes:16}),a=crop();
  for(const bad of [
    {...a,rgba:new Uint8ClampedArray(15)},
    {...a,width:0},
    {...a,source:{...a.source,captureTime:NaN}},
    {...a,source:{...a.source,slot:40}},
    {...a,group:-1},
    {...a,sourceBox:{...a.sourceBox,x:99}},
    {...a,recipe:''},
  ])assert.equal(store.retain(bad),'invalid');
  assert.equal(store.retain(a),'retained');store.dispose();store.dispose();
  assert.equal(store.get(a.source),undefined);assert.equal(store.matches(a),false);
  assert.equal(store.release(a.source),false);assert.equal(store.retain(a),'closed');
  assert.equal(store.snapshot().bytes,0);assert.equal(store.snapshot().entries,0);
  assert.throws(()=>new UnknownCropRetention({entries:-1,bytes:0}),RangeError);
});
