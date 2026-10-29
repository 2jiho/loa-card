import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceStoreTiming,type SourceStoreTimingRecord,type SourceStoreWorkerTiming} from '../src/features/card-scanner/source-store-timing';

const record=(id:number):SourceStoreTimingRecord=>({id,width:1920,height:1080,time:id/30,role:id===1?'input':'recovery'});
const preparation={copyMs:2,conversionHashMs:4,rasterMs:0,totalMs:7};
const worker:SourceStoreWorkerTiming={version:1,path:'native',queuedMs:30,prepareMs:5,packMs:2,compressMs:9,appendMs:4,workMs:20,receiveToAckMs:50};

test('overlapping sources retain distinct main lifecycle intervals and worker durations without adding clocks',()=>{
  const timing=new SourceStoreTiming();
  timing.reserve(record(1),100,100,1_000);
  timing.reserve(record(2),200,300,1_002);
  timing.prepared(1,1_010);timing.preparation(1,preparation);
  timing.prepared(2,1_012);timing.preparation(2,{...preparation,totalMs:8});
  timing.dispatch(1,1_015);timing.dispatch(2,1_016);
  timing.ack(1,1_080,worker);timing.ack(2,1_090,{...worker,path:'rgba',queuedMs:40});
  const snapshot=timing.snapshot(),first=snapshot.sources[0],second=snapshot.sources[1];
  assert.equal(first.reserveToPreparedMs,10);assert.equal(first.preparedToDispatchMs,5);
  assert.equal(first.reserveToDispatchMs,15);assert.equal(first.dispatchToAckMs,65);assert.equal(first.reserveToAckMs,80);
  assert.equal(first.worker?.receiveToAckMs,50,'worker duration is not substituted for main transfer/ACK time');
  assert.deepEqual(first.preparation,preparation);assert.equal(second.dispatchToAckMs,74);
  assert.deepEqual(snapshot.ignored,{events:0,clocks:0,preparationTiming:0,workerTiming:0});
});

test('first eight lifecycle records stay bounded while later reservations and a failure are observed',()=>{
  const timing=new SourceStoreTiming();
  for(let id=1;id<=100;id++)timing.reserve({...record(id),pixels:new Uint8Array(4)} as SourceStoreTimingRecord,4,id*4,id);
  let descriptorsRead=0;
  function* pending(){for(let id=1;;id++){descriptorsRead++;yield {id,ageMs:100-id,bytes:4,prepared:id%2===0,transferred:id===1};}}
  timing.fail('writer unavailable',101,pending());
  const snapshot=timing.snapshot();
  assert.deepEqual(snapshot.sources.map(value=>value.id),[1,2,3,4,5,6,7,8]);assert.equal(snapshot.truncatedSources,true);
  assert.equal(snapshot.sources.some(value=>Object.hasOwn(value,'pixels')),false);
  assert.deepEqual(snapshot.failure?.pending.map(value=>value.id),[1,2,3,4,5,6,7,8]);
  assert.equal(snapshot.failure?.truncated,true);assert.equal(descriptorsRead,9,'never scan an unbounded failure queue');
});

test('failure copies the pending prefix before queue cleanup and a late ACK can still explain the stored prefix',()=>{
  const timing=new SourceStoreTiming(),pending=[{id:1,ageMs:12,bytes:64,prepared:true,transferred:true}];
  timing.reserve(record(1),64,64,1);timing.prepared(1,5);timing.dispatch(1,8);
  timing.fail('first quota failure',13,pending);
  pending[0].bytes=0;pending.length=0;
  timing.fail('cleanup side effect',14,[]);
  timing.ack(1,20,worker);
  const snapshot=timing.snapshot();
  assert.equal(snapshot.failure?.reason,'first quota failure');assert.equal(snapshot.failure?.atMs,13);
  assert.deepEqual(snapshot.failure?.pending,[{id:1,ageMs:12,bytes:64,prepared:true,transferred:true}]);
  assert.equal(snapshot.sources[0].ackAtMs,20);assert.equal(snapshot.sources[0].dispatchToAckMs,12);
  assert.equal(snapshot.sources[0].worker?.appendMs,4);
});

test('malformed optional worker timings are ignored without losing valid ACK telemetry',()=>{
  const hostile=new Proxy({}, {getPrototypeOf(){throw Error('untrusted getter');}});
  const malformed=[null,[],{},hostile,{...worker,version:2},{...worker,path:'canvas'}, {...worker,appendMs:-1},
    {...worker,workMs:NaN},{...worker,queuedMs:Infinity},{...worker,compressMs:120_001},{...worker,extra:true},
    {...worker,queuedMs:'1'},Object.assign(Object.create({}),worker),{...worker,[Symbol('extra')]:true}];
  for(const value of malformed){
    const timing=new SourceStoreTiming();timing.reserve(record(1),4,4,0);timing.dispatch(1,1);
    assert.doesNotThrow(()=>timing.ack(1,2,value));
    const snapshot=timing.snapshot();
    assert.equal(snapshot.sources[0].ackAtMs,2);assert.equal(snapshot.sources[0].worker,undefined);
    assert.equal(snapshot.ignored.workerTiming,1);assert.equal(snapshot.failure,undefined);
  }
  const timing=new SourceStoreTiming();timing.reserve(record(1),4,4,0);timing.dispatch(1,1);timing.ack(1,2);
  assert.equal(timing.snapshot().ignored.workerTiming,0,'an absent optional field is not malformed');
});

test('invalid preparation telemetry cannot become a source failure or poison a later valid duration report',()=>{
  const timing=new SourceStoreTiming();timing.reserve(record(1),4,4,0);
  for(const value of [undefined,null,{...preparation,totalMs:-1},{...preparation,copyMs:NaN},{...preparation,rasterMs:120_001},
    {...preparation,extra:true},Object.defineProperty({...preparation},'totalMs',{get(){throw Error('getter');}})])
    assert.doesNotThrow(()=>timing.preparation(1,value));
  timing.preparation(1,preparation);timing.dispatch(1,1);timing.ack(1,2,worker);
  const snapshot=timing.snapshot();
  assert.equal(snapshot.ignored.preparationTiming,7);assert.deepEqual(snapshot.sources[0].preparation,preparation);
  assert.equal(snapshot.sources[0].ackAtMs,2);assert.equal(snapshot.failure,undefined);
});

test('invalid or decreasing main clocks cannot create negative stage durations or overwrite accepted stages',()=>{
  const timing=new SourceStoreTiming();timing.reserve(record(1),4,4,100);
  for(const now of [NaN,Infinity,-1,99])timing.prepared(1,now);
  timing.prepared(1,110);timing.dispatch(1,109);timing.dispatch(1,115);
  timing.ack(1,114,worker);timing.ack(1,120,worker);timing.ack(1,130,worker);
  const snapshot=timing.snapshot(),source=snapshot.sources[0];
  assert.equal(snapshot.ignored.clocks,6);assert.equal(snapshot.ignored.events,1);
  assert.equal(source.reserveToPreparedMs,10);assert.equal(source.preparedToDispatchMs,5);assert.equal(source.dispatchToAckMs,5);
  assert.equal(source.ackAtMs,120);
  const invalidFailure=new SourceStoreTiming();invalidFailure.reserve(record(1),4,4,5);
  invalidFailure.fail('failure still needs its queue prefix',4,[{id:1,ageMs:1,bytes:4,prepared:false,transferred:false}]);
  assert.equal(invalidFailure.snapshot().failure?.pending.length,1);assert.equal(invalidFailure.snapshot().failure?.atMs,undefined);
});

test('malformed lifecycle events and a throwing failure iterator remain optional diagnostics',()=>{
  const timing=new SourceStoreTiming();
  assert.doesNotThrow(()=>timing.reserve({...record(1),id:0},4,4,0));
  assert.doesNotThrow(()=>timing.reserve(record(1),5,4,0));
  timing.reserve(record(1),4,4,1);timing.ack(1,2,worker);
  timing.reserve(record(1),4,4,2);timing.dispatch(1,3);timing.ack(1,4,worker);
  const pending={*[Symbol.iterator](){yield {id:1,ageMs:3,bytes:4,prepared:false,transferred:true};throw Error('iterator failed');}};
  assert.doesNotThrow(()=>timing.fail('x'.repeat(1000),5,pending));
  const snapshot=timing.snapshot();
  assert.equal(snapshot.sources[0].ackAtMs,4);assert.equal(snapshot.failure?.pending.length,1);
  assert.equal(snapshot.failure?.reason.length,512);assert.equal(snapshot.ignored.events,5);
});

test('snapshots and supplied duration/pending objects do not alias the retained bounded state',()=>{
  const timing=new SourceStoreTiming(),input={...preparation},workerInput={...worker};
  timing.reserve(record(1),4,4,0);timing.preparation(1,input);timing.dispatch(1,1);timing.ack(1,2,workerInput);
  timing.fail('failure',3,[{id:1,ageMs:3,bytes:4,prepared:true,transferred:true}]);
  const first=timing.snapshot() as unknown as {sources:{id:number;preparation:typeof preparation;worker:typeof worker}[];
    ignored:{events:number};failure:{reason:string;pending:{bytes:number}[]}};
  input.totalMs=999;workerInput.appendMs=999;first.sources[0].id=999;first.sources[0].preparation.totalMs=999;
  (first.sources[0].worker as {appendMs:number}).appendMs=999;first.failure.reason='changed';first.failure.pending[0].bytes=999;
  first.ignored.events=999;first.sources.length=0;
  const second=timing.snapshot();
  assert.equal(second.sources[0].id,1);assert.equal(second.sources[0].preparation?.totalMs,7);
  assert.equal(second.sources[0].worker?.appendMs,4);assert.equal(second.failure?.reason,'failure');
  assert.equal(second.failure?.pending[0].bytes,4);assert.equal(second.ignored.events,0);
});
