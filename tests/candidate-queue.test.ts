import {test} from "node:test";
import assert from "node:assert/strict";
import {CandidateQueue,sourceCandidateKey} from "../src/features/card-scanner/acquisition/candidate-queue";
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';

test('replaceAndTake returns the displaced candidate without releasing it',()=>{
 type Item={group:number;image:object}; const retired:Item[]=[];
 const queue=new CandidateQueue<Item>(1,item=>retired.push(item),()=>true,item=>item.group,item=>[item.image]);
 const first={group:1,image:{}},next={group:1,image:{}};
 assert.equal(queue.pushDetailed(first),'queued');
 const result=queue.replaceAndTake(next);
 assert.deepEqual(result,{status:'replaced',previous:first});assert.deepEqual(retired,[]);
 assert.equal(queue.length,1);assert.equal(queue.shift(),next);
 assert.equal(result.status==='replaced'&&result.previous,first);
});

test('replaceAndTake rejects missing, untracked, aliases and inferior candidates without changing ownership',()=>{
 type Item={group:number;image:object;quality:number};
 const untracked=new CandidateQueue<Item>(1,()=>{});
 assert.deepEqual(untracked.replaceAndTake({group:1,image:{},quality:1}),{status:'untracked'});
 const queue=new CandidateQueue<Item>(1,()=>assert.fail('no release'),(a,b)=>b.quality>a.quality,item=>item.group,item=>[item.image]);
 const first={group:1,image:{},quality:2};queue.push(first);
 assert.deepEqual(queue.replaceAndTake({group:2,image:{},quality:3}),{status:'missing'});
 assert.deepEqual(queue.replaceAndTake({group:1,image:first.image,quality:3}),{status:'ownership-conflict'});
 assert.deepEqual(queue.replaceAndTake({group:1,image:{},quality:1}),{status:'present'});
 assert.equal(queue.pushDetailed({group:2,image:first.image,quality:3}),'ownership-conflict');
 assert.equal(queue.shift(),first);
});

test('replaceAndTake keeps ownership on preparation exceptions and cancellation',()=>{
 type Item={group:number;image:object};let fail=false;const controller=new AbortController();
 const queue=new CandidateQueue<Item>(1,()=>assert.fail('no release'),()=>{
   if(fail)throw Error('prepare failed');controller.abort();return true;
 },item=>item.group,item=>[item.image]);
 const first={group:1,image:{}},next={group:1,image:{}};queue.push(first);
 fail=true;assert.throws(()=>queue.replaceAndTake(next),/prepare failed/);
 fail=false;assert.deepEqual(queue.replaceAndTake(next,{signal:controller.signal}),{status:'cancelled'});
 assert.equal(queue.length,1);assert.equal(queue.shift(),first);
});

test('replaceAndTake prevents callback reentrancy from changing either owner',()=>{
 type Item={group:number;image:object};let queue:CandidateQueue<Item>;
 queue=new CandidateQueue<Item>(1,()=>assert.fail('no release'),()=>{queue.clear();return true;},item=>item.group,item=>[item.image]);
 const first={group:1,image:{}},next={group:1,image:{}};queue.push(first);
 assert.throws(()=>queue.replaceAndTake(next),/transfer is already in progress/);
 assert.equal(queue.length,1);assert.equal(queue.shift(),first);
});

test('replaceAndTake cannot run inside an existing queue mutation callback',()=>{
 type Item={group:number;image:object};let queue:CandidateQueue<Item>;
 const first={group:1,image:{}},next={group:1,image:{}},nested={group:1,image:{}};
 queue=new CandidateQueue<Item>(1,()=>{queue.replaceAndTake(nested);},()=>true,item=>item.group,item=>[item.image]);
 queue.push(first);
 assert.throws(()=>queue.pushDetailed(next),/mutation is already in progress/);
 assert.equal(queue.length,1);assert.equal(queue.shift(),first);
});

test('nested queue mutations from replacement, release and priority callbacks cannot lose entries',()=>{
 type Item={group:number;id:string};
 const first={group:1,id:'first'},next={group:1,id:'next'},injected={group:1,id:'injected'};
 for(const callback of ['replace','release','priority'] as const){
  const released:Item[]=[];let queue:CandidateQueue<Item>;
  const reenter=()=>{queue.shift();queue.push(injected);};
  queue=new CandidateQueue<Item>(2,item=>{if(callback==='release')reenter();released.push(item);},
    ()=>{if(callback==='replace')reenter();return true;});
  queue.push(first);
  if(callback==='priority')assert.throws(()=>queue.shift(()=>{reenter();return 1;}),/mutation is already in progress/);
  else assert.throws(()=>queue.push(next),/mutation is already in progress/);
  assert.equal(queue.length,1,callback);
  assert.equal(queue.shift(),first,`${callback}: original remains owned until explicitly shifted`);
  assert.deepEqual(released,[],`${callback}: no item was silently discarded`);
 }
});

test('after transfer a full auxiliary lane or cleanup failure does not falsely consume the returned candidate',()=>{
 type Item={group:number;image:object};const ownership=(item:Item)=>[item.image];
 const primary=new CandidateQueue<Item>(1,()=>assert.fail('no release'),()=>true,item=>item.group,ownership);
 const auxiliary=new CandidateQueue<Item>(1,()=>{throw Error('cleanup failed');},()=>true,item=>item.group,ownership);
 const first={group:1,image:{}},next={group:1,image:{}},other={group:2,image:{}};
 primary.push(first);auxiliary.push(other);
 const result=primary.replaceAndTake(next);assert.equal(result.status,'replaced');
 if(result.status!=='replaced')assert.fail('expected transfer');
 assert.equal(auxiliary.pushDetailed(result.previous),'full');
 assert.equal(result.previous,first,'caller retains displaced item after rejected admission');
 assert.throws(()=>auxiliary.clear(),/cleanup failed/);
 assert.equal(auxiliary.length,1);assert.equal(auxiliary.shift(),other);
 assert.equal(auxiliary.pushDetailed(result.previous),'queued');
 assert.equal(auxiliary.shift(),first);assert.equal(primary.shift(),next);
});
test("pending images coalesce by observation group and release superseded rasters", () => {
  const released: number[] = [], queue = new CandidateQueue<{ group: number; id: number }>(2, item => released.push(item.id));
  assert.equal(queue.push({ group: 1, id: 1 }), true); queue.push({ group: 2, id: 2 });
  assert.equal(queue.push({ group: 1, id: 3 }), true);
  assert.deepEqual(released, [1]); assert.equal(queue.length, 2);
  assert.equal(queue.push({ group: 3, id: 4 }), false);
  assert.equal(queue.shift()?.id, 3); assert.equal(queue.shift()?.id, 2); assert.equal(queue.shift(), undefined);
});
test("canceling the pipeline releases every retained image", () => {
  const released: number[] = [], queue = new CandidateQueue<{ group: number }>(10, item => released.push(item.group));
  queue.push({ group: 4 }); queue.push({ group: 8 }); queue.clear();
  assert.deepEqual(released, [4,8]); assert.equal(queue.length, 0);
});

test('source-keyed candidates preserve same-group inputs and priority removal does not remove another source',()=>{
 const source=(frameId:number):InventorySource=>({sessionId:'session',frameId,observationId:`${frameId}`,
   captureOrder:frameId,captureTime:frameId,phase:'input',slot:0,frame:`frame-${frameId}`});
 type Item={group:number;source:InventorySource;priority:number};
 const released:Item[]=[],queue=new CandidateQueue<Item>(2,item=>released.push(item),()=>true,sourceCandidateKey);
 const a={group:7,source:source(1),priority:9},b={group:7,source:source(2),priority:1};
 assert.equal(queue.push(a),true);assert.equal(queue.push(b),true);assert.equal(queue.length,2);
 assert.deepEqual(queue.shift(item=>item.priority),b);
 assert.deepEqual(queue.shift(item=>item.priority),a);
 assert.deepEqual(released,[]);
 assert.equal(queue.push(a),true);assert.equal(queue.push({...a,priority:2}),true);
 assert.deepEqual(released,[a]);
});

test('distinct sources are kept through a same-group burst and capacity rejection never evicts them',()=>{
 const source=(frameId:number,slot:number):InventorySource=>({sessionId:'s',frameId,observationId:`${frameId}:${slot}`,
   captureOrder:frameId*100+slot,captureTime:frameId,phase:'input',slot,frame:`frame-${frameId}`});
 type Item={group:number;source:InventorySource};
 const released:Item[]=[],queue=new CandidateQueue<Item>(40,item=>released.push(item),()=>true,sourceCandidateKey);
 const first=Array.from({length:40},(_,slot)=>({group:slot,source:source(1,slot)}));
 for(const item of first)assert.equal(queue.pushDetailed(item),'queued');
 const next={group:0,source:source(2,0)};
 assert.equal(queue.pushDetailed(next),'full');
 assert.equal(queue.length,40);assert.deepEqual(released,[]);
 assert.deepEqual(Array.from({length:40},()=>queue.shift()),first);
 assert.equal(queue.pushDetailed(next),'queued');assert.deepEqual(queue.shift(),next);
});

test('detailed admission exposes replacement, lower-quality rejection and capacity without hiding sources',()=>{
 type Item={group:number;source:number;quality:number};
 const retired:Item[]=[],queue=new CandidateQueue<Item>(1,item=>retired.push(item),
   (previous,next)=>next.quality>previous.quality);
 const first={group:1,source:1,quality:1},better={group:1,source:2,quality:2};
 assert.equal(queue.pushDetailed(first),'queued');
 assert.equal(queue.pushDetailed({group:1,source:3,quality:0}),'present');
 assert.equal(queue.pushDetailed({group:2,source:4,quality:5}),'full');
 assert.deepEqual(retired,[]);
 assert.equal(queue.pushDetailed(better),'replaced');
 assert.deepEqual(retired,[first],'caller receives the exact retired source through release');
 assert.deepEqual(queue.shift(),better);
});

test('opt-in resource ownership rejects aliases without releasing a queued raster',()=>{
 type Item={group:number;image:object;preview:object;execution:object};
 const retired:Item[]=[],queue=new CandidateQueue<Item>(2,item=>retired.push(item),()=>true,
   item=>item.group,item=>[item.image,item.preview,item.execution]);
 const first={group:1,image:{},preview:{},execution:{}};
 const alias={group:2,image:first.image,preview:{},execution:{}};
 assert.equal(queue.pushDetailed(first),'queued');
 assert.equal(queue.pushDetailed(alias),'ownership-conflict');
 assert.equal(queue.pushDetailed({...first,preview:{},execution:{}}),'ownership-conflict');
 assert.deepEqual(retired,[]);assert.equal(queue.length,1);
 const shared={},selfAlias={group:2,image:shared,preview:shared,execution:{}};
 assert.equal(queue.pushDetailed(selfAlias),'ownership-conflict');
 assert.equal(queue.length,1);
 assert.equal(queue.shift(),first,'shifting transfers resource ownership to caller');
 assert.equal(queue.pushDetailed(alias),'queued','queue no longer owns shifted resources; caller manages in-flight ownership');
 queue.clear();assert.deepEqual(retired,[alias]);
 assert.equal(queue.pushDetailed(alias),'queued','clear removes queue ownership bookkeeping');
 queue.clear();assert.deepEqual(retired,[alias,alias]);
});

test('queue requires a bounded non-negative integer capacity',()=>{
 for(const value of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
   assert.throws(()=>new CandidateQueue(value,()=>{}),/Invalid candidate capacity/);
 const empty=new CandidateQueue<{group:number}>(0,()=>assert.fail('nothing retained'));
 assert.equal(empty.pushDetailed({group:1}),'full');
});

test('a throwing replacement release keeps the pending entry and its resource ownership',()=>{
 type Item={group:number;image:object};
 const released:Item[]=[];let fail=true;
 const queue=new CandidateQueue<Item>(2,item=>{released.push(item);if(fail)throw Error('release failed');},
   ()=>true,item=>item.group,item=>[item.image]);
 const first={group:1,image:{}},replacement={group:1,image:{}},alias={group:2,image:first.image};
 assert.equal(queue.pushDetailed(first),'queued');
 assert.throws(()=>queue.pushDetailed(replacement),/release failed/);
 assert.equal(queue.length,1);
 assert.equal(queue.pushDetailed(alias),'ownership-conflict','old raster is still guarded after the exception');
 assert.deepEqual(released,[first]);
 fail=false;
 assert.equal(queue.pushDetailed(replacement),'replaced');
 assert.deepEqual(released,[first,first]);
 assert.equal(queue.shift(),replacement);
 assert.equal(queue.pushDetailed(alias),'queued','successful release removed the old guard');
 queue.clear();
});

test('a throwing clear retains the failed and remaining entries without releasing completed entries twice',()=>{
 type Item={group:number;image:object};
 const released:number[]=[];let fail=true;
 const queue=new CandidateQueue<Item>(3,item=>{released.push(item.group);if(fail&&item.group===2)throw Error('release failed');},
   ()=>true,item=>item.group,item=>[item.image]);
 const first={group:1,image:{}},second={group:2,image:{}},third={group:3,image:{}};
 for(const item of [first,second,third])assert.equal(queue.pushDetailed(item),'queued');
 assert.throws(()=>queue.clear(),/release failed/);
 assert.equal(queue.length,2);assert.deepEqual(released,[1,2]);
 assert.equal(queue.pushDetailed({group:4,image:second.image}),'ownership-conflict');
 assert.equal(queue.pushDetailed({group:4,image:third.image}),'ownership-conflict');
 fail=false;queue.clear();
 assert.equal(queue.length,0);assert.deepEqual(released,[1,2,2,3]);
 assert.equal(queue.pushDetailed({group:4,image:first.image}),'queued');queue.clear();
});
