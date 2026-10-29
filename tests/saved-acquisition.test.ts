import {test} from 'node:test';
import assert from 'node:assert/strict';
import {saveAcquisition,SavedAcquisitions,resolvedSavedObservation,coveredSavedAcquisition,sourceObservationFrame,exactSourceSavedObservation,selectObservationSourceFrameId} from '../src/features/card-scanner/saved-acquisition';
import type {SavedAcquisition,SavedObservation} from '../src/features/card-scanner/saved-acquisition';
import {CountObservations,countReliability} from '../src/features/card-scanner/count-confidence';
import {normalizeScannerInputFrame} from '../src/features/card-scanner/scanner-input-frame';

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

const sourceBinding={sourceFrameId:7,captureTime:1,width:100,height:100,hash:'a'.repeat(64)};
function physicalSaved():SavedAcquisition {
  const cell={slot:0,content:{x:10,y:10,width:40,height:60},preview:{x:8,y:8,width:44,height:64},pixelKey:'original-pixels',
    quality:{usable:true,reason:'',sharpness:1}} as SavedAcquisition['cells'][number];
  return {width:100,height:100,layout:{scale:1} as SavedAcquisition['layout'],cells:[cell],
    observations:[{order:137,frame:sourceObservationFrame('scan',7,17),stable:false}],
    rasterReceipt:{version:1,kind:'measured',...sourceBinding,acquisitionFrameId:17}};
}

test('fresh acquisition can borrow exact source observation metadata without borrowing its old raster measurement',()=>{
  const prior=physicalSaved(),current={...prior.cells[0],content:{...prior.cells[0].content},preview:{...prior.cells[0].preview},pixelKey:'newly-measured-pixels'};
  const borrowed=exactSourceSavedObservation(prior,sourceBinding,current);
  assert.equal(borrowed,prior.observations[0],'keep the source-owned mutable observation reference');
  assert.equal(borrowed?.order,137);assert.equal(borrowed?.frame,'scan/source/7');assert.equal(borrowed?.stable,false);
  assert.equal(current.pixelKey,'newly-measured-pixels');assert.equal(prior.rasterReceipt?.acquisitionFrameId,17);
  assert.equal(Object.hasOwn(borrowed!,'rasterReceipt'),false);assert.equal(Object.hasOwn(borrowed!,'image'),false);
});

test('observation metadata requires exact physical ID, time, source SHA and both dimensions',()=>{
  const prior=physicalSaved(),cell=prior.cells[0];
  for(const changed of [{sourceFrameId:17},{sourceFrameId:undefined},{captureTime:1+1e-10},{width:101},{height:101},
    {hash:'b'.repeat(64)},{hash:undefined},{hash:'bad'},{captureTime:NaN}])
    assert.equal(exactSourceSavedObservation(prior,{...sourceBinding,...changed},cell),undefined);
  for(const malformed of [undefined,{...prior.rasterReceipt,kind:'analysis-reused',originAcquisitionFrameId:1},
    {...prior.rasterReceipt,extra:true},{...prior.rasterReceipt,width:101}])
    assert.equal(exactSourceSavedObservation({...prior,rasterReceipt:malformed} as SavedAcquisition,sourceBinding,cell),undefined);
  assert.equal(exactSourceSavedObservation({...prior,width:101},sourceBinding,cell),undefined);
  assert.equal(exactSourceSavedObservation(undefined,sourceBinding,cell),undefined);
});

test('a different slot or even a fractional content/preview crop change cannot borrow old observation metadata',()=>{
  const prior=physicalSaved(),cell=prior.cells[0];
  for(const part of ['content','preview'] as const)for(const key of ['x','y','width','height'] as const){
    const current={...cell,[part]:{...cell[part],[key]:cell[part][key]+.5}};
    assert.equal(exactSourceSavedObservation(prior,sourceBinding,current),undefined);
  }
  for(const changed of [{slot:1},{slot:-1},{slot:40},{content:{...cell.content,x:NaN}},
    {preview:{...cell.preview,width:0}},{content:{...cell.content,x:90}}])
    assert.equal(exactSourceSavedObservation(prior,sourceBinding,{...cell,...changed}),undefined);
  assert.equal(exactSourceSavedObservation({...prior,cells:[{...cell,slot:1}]},sourceBinding,cell),undefined);
});

const weakCount={stable:false,borderAlignment:.95,awakening:0,extraCopies:1,
  pattern:{value:1,candidate:1,score:.32,gap:.02,reason:'weak intact counter'}};

for(const kind of ['canonical','prepared'] as const)test(`${kind} source selection survives default sidecar eviction without inventing count independence`,()=>{
  const physical={id:7,captureTime:1},counts=new CountObservations(),pixels=new Uint8Array(3240).fill(100),cache=new SavedAcquisitions();
  const initialId=selectObservationSourceFrameId(kind,physical.id);
  const firstFrame=sourceObservationFrame('normal-scan',initialId,17);
  const prior={...saved(),observations:[{order:137,stable:false,frame:firstFrame}]};
  assert.equal(prior.rasterReceipt,undefined,'normal identity binding does not require or fabricate a measured receipt');
  cache.set(physical.id,prior);
  const first=counts.offer('card',firstFrame,pixels,weakCount);
  assert.equal(first,false);assert.equal(countReliability({...weakCount,repeatedCount:first}),'unconfirmed');
  // Exercise the production default of 128 sidecars, not a reduced test limit.
  for(let id=8;id<=135;id++)cache.set(id,saved());
  assert.equal(cache.get(physical.id),undefined,'the original still exists after its optional analysis is evicted');
  assert.ok(cache.get(8));assert.ok(cache.get(135));
  const reacquiredId=selectObservationSourceFrameId(kind,physical.id);
  const restoredFrame=sourceObservationFrame('normal-scan',reacquiredId,99);
  assert.equal(restoredFrame,firstFrame);
  const sameSource=counts.offer('card',restoredFrame,pixels.slice(),weakCount);
  assert.equal(sameSource,false);assert.equal(countReliability({...weakCount,repeatedCount:sameSource}),'unconfirmed');
  assert.equal(physical.captureTime,1,'a processing retry does not rewrite the capture clock');
});

test('normal canonical selection keeps different physical sources distinct even at the same clock and slot',()=>{
  const counts=new CountObservations(),pixels=new Uint8Array(3240).fill(100);
  const inputs=[{id:7,captureTime:1,slot:0,processing:17},{id:8,captureTime:1,slot:0,processing:99}];
  const frames=inputs.map(input=>sourceObservationFrame('normal-scan',selectObservationSourceFrameId('canonical',input.id),input.processing));
  assert.notEqual(frames[0],frames[1]);assert.equal(inputs[0].captureTime,inputs[1].captureTime);assert.equal(inputs[0].slot,inputs[1].slot);
  assert.equal(counts.offer('card',frames[0],pixels,weakCount),false);
  const distinctSource=counts.offer('card',frames[1],pixels,weakCount);
  assert.equal(distinctSource,true);assert.equal(countReliability({...weakCount,repeatedCount:distinctSource}),'repeated-pattern');
});

test('slots and processing attempts within one physical source cannot become independent count observations',()=>{
  const counts=new CountObservations(),pixels=new Uint8Array(3240).fill(100),physical=selectObservationSourceFrameId('canonical',7);
  const slots=[{slot:0,processing:17},{slot:1,processing:99}];
  const frames=slots.map(input=>sourceObservationFrame('normal-scan',physical,input.processing));
  assert.notEqual(slots[0].slot,slots[1].slot);assert.equal(frames[0],frames[1]);
  assert.equal(counts.offer('card-a',frames[0],pixels,weakCount),false);
  assert.equal(counts.offer('card-a',frames[1],pixels,weakCount),false);
  assert.equal(counts.offer('card-b',frames[1],pixels,weakCount),false,'different cards retain their own evidence state');
});

test('legacy PNG and unbound decoded inputs cannot borrow an arbitrary saved ID or a measured sidecar ID',()=>{
  const prior=physicalSaved();
  for(const savedId of [7,prior.rasterReceipt!.sourceFrameId,undefined]){
    const selected=selectObservationSourceFrameId('unbound',savedId);
    assert.equal(selected,undefined);
    assert.equal(sourceObservationFrame('legacy',selected,17),'legacy/17');
    assert.equal(sourceObservationFrame('legacy',selected,99),'legacy/99');
  }
  for(const kind of ['canonical','prepared'] as const){
    assert.equal(selectObservationSourceFrameId(kind,undefined),undefined,'a mode is not proof that an ID exists');
    assert.equal(sourceObservationFrame('decoded',selectObservationSourceFrameId(kind,undefined),17),'decoded/17');
  }
});

test('bound source selection validates physical IDs without changing their numeric domain',()=>{
  for(const kind of ['canonical','prepared'] as const){
    for(const id of [1,7,Number.MAX_SAFE_INTEGER])assert.equal(selectObservationSourceFrameId(kind,id),id);
    for(const invalid of [0,-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
      assert.throws(()=>selectObservationSourceFrameId(kind,invalid),/physical observation source identity/);
  }
  assert.throws(()=>selectObservationSourceFrameId('legacy' as Parameters<typeof selectObservationSourceFrameId>[0],7),/source kind/);
});

test('reacquiring the same physical source cannot corroborate a weak count after cache eviction or crop refinement',()=>{
  const counts=new CountObservations(),pixels=new Uint8Array(3240).fill(100),prior=physicalSaved(),cache=new SavedAcquisitions(1);
  const firstFrame=sourceObservationFrame('scan',7,17);
  assert.equal(counts.offer('card',firstFrame,pixels,weakCount),false);
  cache.set(7,prior);cache.set(8,physicalSaved());assert.equal(cache.get(7),undefined);
  assert.equal(exactSourceSavedObservation(cache.get(7),sourceBinding,prior.cells[0]),undefined);
  const evictedRetry=sourceObservationFrame('scan',7,99),sameSourceRepeated=counts.offer('card',evictedRetry,pixels,weakCount);
  assert.equal(sameSourceRepeated,false);assert.equal(countReliability({...weakCount,repeatedCount:sameSourceRepeated}),'unconfirmed');
  const refined={...prior.cells[0],content:{...prior.cells[0].content,x:10.5}};
  assert.equal(exactSourceSavedObservation(prior,sourceBinding,refined),undefined);
  const refinedRetry=counts.offer('card',sourceObservationFrame('scan',7,100),pixels,weakCount);
  assert.equal(refinedRetry,false);assert.equal(countReliability({...weakCount,repeatedCount:refinedRetry}),'unconfirmed');
});

test('genuinely distinct physical sources still corroborate the same weak counter',()=>{
  const counts=new CountObservations(),pixels=new Uint8Array(3240).fill(100);
  assert.equal(counts.offer('card',sourceObservationFrame('scan',7,17),pixels,weakCount),false);
  const repeated=counts.offer('card',sourceObservationFrame('scan',8,18),pixels,weakCount);
  assert.equal(repeated,true);assert.equal(countReliability({...weakCount,repeatedCount:repeated}),'repeated-pattern');
  const unread={...weakCount,extraCopies:null,awakening:null};
  assert.equal(counts.offer('card',sourceObservationFrame('scan',9,19),pixels,unread),false);
  assert.equal(countReliability({...unread,repeatedCount:true}),'unconfirmed');assert.equal(unread.extraCopies,null);
});

test('source keys separate physical identity, legacy processing identity and session domains',()=>{
  assert.equal(sourceObservationFrame('scan',7,17),sourceObservationFrame('scan',7,999));
  assert.notEqual(sourceObservationFrame('scan',7,17),sourceObservationFrame('scan',8,17));
  assert.equal(sourceObservationFrame('scan',undefined,17),'scan/17');
  assert.notEqual(sourceObservationFrame('scan',7,17),sourceObservationFrame('other',7,17));
  assert.notEqual(sourceObservationFrame('scan',7,17),sourceObservationFrame('scan/source',undefined,7));
  for(const invalid of [0,-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>sourceObservationFrame('scan',invalid,1));assert.throws(()=>sourceObservationFrame('scan',undefined,invalid));
  }
  assert.throws(()=>sourceObservationFrame('',7,17));
});

test('raw encoder identities survive reprocessing without colliding with live or imported source numbers',()=>{
  const counts=new CountObservations(),pixels=new Uint8Array(3240).fill(100);
  const first=sourceObservationFrame('scan',7,17,'raw-source'),retry=sourceObservationFrame('scan',7,99,'raw-source');
  assert.equal(first,retry);assert.equal(first,'scan/raw-source/7');
  assert.notEqual(first,sourceObservationFrame('scan',7,17));
  assert.notEqual(first,sourceObservationFrame('scan',7,17,'archive-source'));
  assert.equal(counts.offer('card',first,pixels,weakCount),false);
  assert.equal(counts.offer('card',retry,pixels,weakCount),false);
  assert.equal(counts.offer('card',sourceObservationFrame('scan',8,100,'raw-source'),pixels,weakCount),true);
});

test('recorded processing uses keep one verified archive source alias and never borrow a missing source ID',()=>{
  const counts=new CountObservations(),pixels=new Uint8Array(3240).fill(100),element={} as HTMLCanvasElement;
  const inputs=[17,99].map(frameId=>normalizeScannerInputFrame({element,time:1,percent:50,
    provenance:{frameId,sourceFrameId:7,captureTime:1,phase:frameId===17?'input':'recovery',phaseInferred:false,pixelHash:'a'.repeat(64)}}));
  const aliases=inputs.map((input,index)=>sourceObservationFrame('replay',input.provenance!.sourceFrameId,index+1,'archive-source'));
  assert.equal(aliases[0],aliases[1]);assert.equal(aliases[0],'replay/archive-source/7');
  assert.equal(counts.offer('card',aliases[0],pixels,weakCount),false);
  assert.equal(counts.offer('card',aliases[1],pixels,weakCount),false);
  const legacy=normalizeScannerInputFrame({element,time:1,percent:50,
    provenance:{frameId:7,captureTime:1,phase:'input',phaseInferred:true,pixelHash:'a'.repeat(64)}});
  assert.equal(legacy.provenance!.sourceFrameId,undefined);
  assert.equal(sourceObservationFrame('replay',legacy.provenance!.sourceFrameId,3),'replay/3');
  assert.throws(()=>sourceObservationFrame('scan',undefined,17,'raw-source'));
  assert.throws(()=>sourceObservationFrame('scan',7,17,'timestamp' as 'source'));
});
