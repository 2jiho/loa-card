import test from 'node:test';
import assert from 'node:assert/strict';
import {MetadataOrder,metadataSortChanged} from '../src/features/card-scanner/session/metadata-order';
import type {CapturedMetadata,ScanMetadata} from '../src/features/card-scanner/session/metadata-order';
import {reconcileCardSort} from '../src/features/card-scanner/recognition/capture-metadata';

const newer:ScanMetadata={growthPoints:{current:100,maximum:999999999},sort:{kind:'name',direction:'desc'}};
const older:ScanMetadata={growthPoints:{current:500,maximum:999999999},sort:{kind:'rarity',direction:'asc'}};

test('older recording metadata cannot roll back newer originals or reset inventory positions',()=>{
  const order=new MetadataOrder();
  assert.deepEqual(order.accept(50,newer),newer);
  const next=order.accept(1,older);
  assert.deepEqual(next,{growthPoints:null,sort:null});
  assert.deepEqual(reconcileCardSort(newer.sort,next.sort),{sort:newer.sort,changed:false});
  assert.deepEqual(order.accept(51,older),older,'a genuinely newer capture can change both fields');
});

test('a failed sort invalidates old sort without discarding independent growth evidence',()=>{
  const order=new MetadataOrder();
  order.accept(50,{growthPoints:null,sort:newer.sort});
  assert.deepEqual(order.accept(20,older),{growthPoints:older.growthPoints,sort:null});
  assert.deepEqual(order.accept(60,{growthPoints:newer.growthPoints,sort:null}),{growthPoints:newer.growthPoints,sort:null,sortInvalidated:true});
  assert.deepEqual(order.accept(55,older),{growthPoints:null,sort:null});
  order.accept(100,{growthPoints:null,sort:null});
  assert.deepEqual(order.accept(70,newer),{growthPoints:newer.growthPoints,sort:null});
  assert.equal(metadataSortChanged(null,newer.sort),true);
  assert.deepEqual(order.accept(101,newer),newer);
});

test('the captured launch time protects current metadata while historical candidates keep raw sort',async()=>{
  const order=new MetadataOrder();order.accept(50,newer);
  let resolve!:(value:ScanMetadata)=>void,sourceTime=1;
  const reading=new Promise<ScanMetadata>(done=>{resolve=done;});
  const pending:CapturedMetadata={time:sourceTime,sourceOrder:1,reading};
  const candidateSort=reading.then(value=>value.sort);
  sourceTime=100;
  resolve(older);
  assert.deepEqual(order.accept(pending.time,await pending.reading),{growthPoints:null,sort:null});
  assert.deepEqual(await candidateSort,older.sort);
  assert.equal(sourceTime,100);assert.equal(pending.time,1);
});

test('equal capture times can fill missing metadata, zero is valid and invalid timestamps do not poison order',()=>{
  const order=new MetadataOrder(),zero={growthPoints:{current:0,maximum:999999999},sort:null};
  assert.deepEqual(order.accept(10,zero),zero);
  assert.deepEqual(order.accept(10,{growthPoints:null,sort:newer.sort}),{growthPoints:null,sort:newer.sort});
  for(const time of [NaN,Infinity,-Infinity])assert.deepEqual(order.accept(time,older),{growthPoints:null,sort:null});
  assert.deepEqual(order.accept(11,older),older);
});

test('a newer unreadable arrow invalidates old direction and older results cannot restore it',()=>{
  const order=new MetadataOrder();
  const asc={kind:'name',direction:'asc'} as const,unknown={kind:'name',direction:'unknown'} as const;
  order.accept(50,{growthPoints:null,sort:asc});
  assert.deepEqual(order.accept(100,{growthPoints:null,sort:unknown}).sort,unknown);
  assert.equal(metadataSortChanged(asc,unknown),true);
  const next=order.accept(90,{growthPoints:null,sort:newer.sort}).sort;
  assert.equal(next,null);
  assert.equal(order.accept(80,{growthPoints:null,sort:asc}).sort,null);
  assert.deepEqual(order.accept(101,{growthPoints:null,sort:newer.sort}).sort,newer.sort);
  assert.equal(metadataSortChanged(unknown,newer.sort),true);
});

test('late sort observations cannot change the latest unknown or supply its direction',()=>{
  const order=new MetadataOrder();
  const unknown={kind:'name',direction:'unknown'} as const;
  order.accept(50,{growthPoints:null,sort:newer.sort});
  order.accept(100,{growthPoints:null,sort:unknown});
  const invalidated=order.accept(95,older).sort;
  assert.equal(invalidated,null);assert.equal(metadataSortChanged(newer.sort,unknown),true);
  assert.equal(order.accept(90,{growthPoints:null,sort:newer.sort}).sort,null);
  const repaired=order.accept(97,{growthPoints:null,sort:newer.sort}).sort;
  assert.equal(repaired,null);
});

test('chronological and reordered sort observations give the same current direction across kind changes',()=>{
  const observations=[
    {time:50,sort:{kind:'name',direction:'asc'}},
    {time:70,sort:{kind:'rarity',direction:'desc'}},
    {time:90,sort:{kind:'name',direction:'desc'}},
    {time:100,sort:{kind:'name',direction:'unknown'}},
  ] as const;
  const final=(indexes:number[])=>{
    const order=new MetadataOrder();let sort:ScanMetadata['sort']=null;
    for(const index of indexes){const item=observations[index],next=order.accept(item.time,{growthPoints:null,sort:item.sort});if(next.sort)sort=next.sort;}
    return sort;
  };
  const unknown={kind:'name',direction:'unknown'};
  assert.deepEqual(final([0,1,2,3]),unknown);
  assert.deepEqual(final([0,3,1,2]),unknown);
  assert.deepEqual(final([3,2,1,0]),unknown);
});

test('unknown interval resets positions even if the same direction later returns',()=>{
  for(const direction of ['asc','desc'] as const){
    const order=new MetadataOrder();
    const known={kind:'name' as const,direction},unknown={kind:'name' as const,direction:'unknown' as const};
    order.accept(1,{growthPoints:null,sort:known});
    const lost=order.accept(2,{growthPoints:null,sort:unknown}).sort;
    assert.deepEqual(lost,unknown);assert.equal(metadataSortChanged(known,lost),true);
    const restored=order.accept(3,{growthPoints:null,sort:known}).sort;
    assert.deepEqual(restored,known);assert.equal(metadataSortChanged(unknown,restored),true);
  }
});

test('same frame can fill an unknown arrow without letting an unknown overwrite known evidence',()=>{
  const order=new MetadataOrder(),known={kind:'name' as const,direction:'asc' as const},unknown={kind:'name' as const,direction:'unknown' as const};
  assert.deepEqual(order.accept(1,{growthPoints:null,sort:unknown}).sort,unknown);
  assert.deepEqual(order.accept(1,{growthPoints:null,sort:known}).sort,known);
  assert.equal(order.accept(1,{growthPoints:null,sort:unknown}).sort,null);
});

test('different still images with the same synthetic time use input order, even if OCR resolves late',()=>{
  const order=new MetadataOrder(),known={kind:'name' as const,direction:'asc' as const},unknown={kind:'name' as const,direction:'unknown' as const};
  const first={growthPoints:{current:100,maximum:999999999},sort:known};
  const second={growthPoints:{current:200,maximum:999999999},sort:unknown};
  assert.deepEqual(order.accept(0,first,1),first);
  assert.deepEqual(order.accept(0,second,2),second);
  assert.equal(metadataSortChanged(known,unknown),true);
  assert.deepEqual(order.accept(0,first,1),{growthPoints:null,sort:null});
  const third={growthPoints:null,sort:{kind:'name' as const,direction:'desc' as const}};
  assert.deepEqual(order.accept(0,third,3),third);
  assert.equal(metadataSortChanged(unknown,third.sort),true);
});

test('unlocated input with an invalid clock fences earlier sort results by acquisition order',()=>{
  const order=new MetadataOrder(),known={kind:'name' as const,direction:'asc' as const};
  order.accept(10,{growthPoints:null,sort:known},1);
  assert.deepEqual(order.invalidateSortWithoutTime(2),{growthPoints:null,sort:null,sortInvalidated:true});
  // An earlier asynchronous source cannot revive the old direction even if
  // its timestamp happens to be higher than the last successful one.
  assert.equal(order.accept(11,{growthPoints:null,sort:known},1).sort,null);
  assert.deepEqual(order.accept(12,{growthPoints:null,sort:known},3).sort,known);
  assert.equal(order.invalidateSortWithoutTime(1).sortInvalidated,undefined,'older invalid input cannot erase later knowledge');
});

test('a lost view fences old sort when its timestamp is missing, negative or regresses',()=>{
  const known={kind:'name' as const,direction:'asc' as const};
  for(const lostTime of [NaN,Infinity,-1,9]){
    const order=new MetadataOrder();order.accept(10,{growthPoints:null,sort:known},1);
    assert.equal(order.invalidateUnlocatedSort(lostTime,2).sortInvalidated,true);
    assert.equal(order.accept(11,{growthPoints:null,sort:known},1).sort,null);
    assert.deepEqual(order.accept(12,{growthPoints:null,sort:known},3).sort,known);
  }
});
