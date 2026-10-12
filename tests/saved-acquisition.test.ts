import {test} from 'node:test';
import assert from 'node:assert/strict';
import {saveAcquisition,SavedAcquisitions,resolvedSavedObservation,coveredSavedAcquisition} from '../src/features/card-scanner/saved-acquisition';
import type {SavedAcquisition,SavedObservation} from '../src/features/card-scanner/saved-acquisition';

const observation={order:10,frame:'capture/1',stable:true,identity:{id:'a',review:[]}} as SavedObservation;
function saved():SavedAcquisition {
  return {width:100,height:100,layout:{scale:1} as SavedAcquisition['layout'],
    cells:[{quality:{usable:true,reason:'',sharpness:1}}] as SavedAcquisition['cells'],observations:[observation]};
}

test('exact original receipt retires only an equal or older confirmed observation',()=>{
  assert.equal(resolvedSavedObservation(observation,new Map([['a',10]])),true);
  assert.equal(resolvedSavedObservation(observation,new Map([['a',11]])),true);
  assert.equal(resolvedSavedObservation(observation,new Map([['a',9]])),false);
  assert.equal(resolvedSavedObservation(observation,new Map()),false);
  assert.equal(resolvedSavedObservation({...observation,identity:{...observation.identity!,review:['이름 확인']}},new Map([['a',11]])),false);
  assert.equal(resolvedSavedObservation(undefined,new Map([['a',11]])),false);
});

test('future originals must all be covered; totals cannot excuse unlocated or occluded frames',()=>{
  const confirmed=new Map([['a',10]]);
  assert.equal(coveredSavedAcquisition(saved(),confirmed),true);
  for(const change of [{layout:null},{cells:[]},{observations:[]},
    {cells:[{quality:{usable:false,reason:'가림'}}] as SavedAcquisition['cells']}])
    assert.equal(coveredSavedAcquisition({...saved(),...change},confirmed),false);
  const empty={...saved(),observations:[],cells:[{quality:{usable:false,reason:'미보유 카드 뒷면 · 빈 슬롯'}}] as SavedAcquisition['cells']};
  assert.equal(coveredSavedAcquisition(empty,confirmed),true);
  assert.equal(coveredSavedAcquisition(saved(),new Map()),false);
});

test('receipt cache is ID-specific and bounded; evicted or missing frames require acquisition',()=>{
  const cache=new SavedAcquisitions(2),covered=(s:SavedAcquisition|undefined)=>coveredSavedAcquisition(s,new Map([['a',10]]));
  cache.set(1,saved());cache.set(3,saved());
  assert.equal(cache.coveredFrom(1,3,covered),false);
  cache.set(2,saved());assert.equal(cache.get(1),undefined);
  assert.equal(cache.coveredFrom(2,3,covered),true);
  cache.delete(2);assert.equal(cache.coveredFrom(2,3,covered),false);
  cache.clear();assert.equal(cache.get(3),undefined);
});

test('receipt owns its geometry and features without retaining raster or preview canvases',()=>{
  const cell={...saved().cells[0],feature:new Uint8Array([1]),art:new Uint8Array([2]),image:{uncloneable(){}},previewImage:{uncloneable(){}}};
  const result=saveAcquisition(100,100,saved().layout,[cell] as unknown as Parameters<typeof saveAcquisition>[3]);
  cell.feature[0]=9;
  assert.equal(result.cells[0].feature[0],1);
  assert.equal('image' in result.cells[0],false);
  assert.equal('previewImage' in result.cells[0],false);
});
