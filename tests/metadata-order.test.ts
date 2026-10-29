import test from 'node:test';
import assert from 'node:assert/strict';
import {MetadataOrder,metadataSortChanged} from '../src/features/card-scanner/metadata-order';
import type {CapturedMetadata,ScanMetadata} from '../src/features/card-scanner/metadata-order';
import {reconcileCardSort} from '../src/features/card-scanner/capture-metadata';

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

test('successful field timestamps are independent and null never advances either field',()=>{
  const order=new MetadataOrder();
  order.accept(50,{growthPoints:null,sort:newer.sort});
  assert.deepEqual(order.accept(20,older),{growthPoints:older.growthPoints,sort:null});
  assert.deepEqual(order.accept(60,{growthPoints:newer.growthPoints,sort:null}),{growthPoints:newer.growthPoints,sort:null});
  assert.deepEqual(order.accept(55,older),{growthPoints:null,sort:older.sort});
  order.accept(100,{growthPoints:null,sort:null});
  assert.deepEqual(order.accept(70,newer),newer);
});

test('the captured launch time protects current metadata while historical candidates keep raw sort',async()=>{
  const order=new MetadataOrder();order.accept(50,newer);
  let resolve!:(value:ScanMetadata)=>void,sourceTime=1;
  const reading=new Promise<ScanMetadata>(done=>{resolve=done;});
  const pending:CapturedMetadata={time:sourceTime,reading};
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

test('an older same-kind known direction can supplement a newer missing arrow',()=>{
  const order=new MetadataOrder();
  const asc={kind:'name',direction:'asc'} as const,unknown={kind:'name',direction:'unknown'} as const;
  order.accept(50,{growthPoints:null,sort:asc});
  assert.equal(order.accept(100,{growthPoints:null,sort:unknown}).sort,null);
  const next=order.accept(90,{growthPoints:null,sort:newer.sort}).sort;
  assert.deepEqual(next,newer.sort);assert.equal(metadataSortChanged(asc,next),true);
  assert.equal(order.accept(80,{growthPoints:null,sort:asc}).sort,null,'older direction cannot replace newer known direction');
});

test('a different kind between direction and latest kind prevents borrowing that old direction',()=>{
  const order=new MetadataOrder();
  const unknown={kind:'name',direction:'unknown'} as const;
  order.accept(50,{growthPoints:null,sort:newer.sort});
  order.accept(100,{growthPoints:null,sort:unknown});
  const invalidated=order.accept(95,older).sort;
  assert.deepEqual(invalidated,unknown);assert.equal(metadataSortChanged(newer.sort,invalidated),true);
  assert.equal(order.accept(90,{growthPoints:null,sort:newer.sort}).sort,null);
  const repaired=order.accept(97,{growthPoints:null,sort:newer.sort}).sort;
  assert.deepEqual(repaired,newer.sort);assert.equal(metadataSortChanged(unknown,repaired),false);
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
  assert.deepEqual(final([0,1,2,3]),newer.sort);
  assert.deepEqual(final([0,3,1,2]),newer.sort);
  assert.deepEqual(final([3,2,1,0]),newer.sort);
});
