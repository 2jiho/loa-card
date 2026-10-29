import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordingWorkQueue,type RecordingWorkLane} from '../src/features/card-scanner/recording-work-queue';

function held(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function turn(){await new Promise<void>(resolve=>setImmediate(resolve));}

test('queued events alternate with frames after a held first frame, preserving each FIFO',async()=>{
 const queue=createRecordingWorkQueue(),first=held(),order:string[]=[];
 queue.enqueue('frame',{async run(){order.push('f1');await first.promise;},release(){order.push('release1');}});
 for(const id of [2,3,4])queue.enqueue('frame',{run(){order.push(`f${id}`);}});
 for(const id of [1,2,3])queue.enqueue('event',{run(){order.push(`e${id}`);}});
 const done=queue.barrier(()=>{order.push('drain');});
 await turn();assert.deepEqual(order,['f1']);assert.deepEqual(queue.pending,{frame:4,event:3});
 first.release();await done;
 assert.deepEqual(order,['f1','release1','e1','f2','e2','f3','e3','f4','drain']);
 assert.deepEqual(queue.pending,{frame:0,event:0});
});

test('continuous arrivals in both lanes cannot starve either FIFO',async()=>{
 const queue=createRecordingWorkQueue(),first=held(),order:string[]=[];
 queue.enqueue('frame',{run:()=>first.promise});
 function add(lane:RecordingWorkLane,id:number){
  assert.equal(queue.enqueue(lane,{run(){order.push(`${lane}${id}`);if(id<12)add(lane,id+1);}}),true);
 }
 add('frame',1);add('event',1);first.release();
 // A barrier would intentionally hold later arrivals; join after both streams
 // have produced their full sequence instead.
 for(let tries=0;order.length<24;tries++){assert.ok(tries<20);await turn();}
 await queue.barrier();
 assert.deepEqual(order,Array.from({length:12},(_,i)=>[`event${i+1}`,`frame${i+1}`]).flat());
});

test('barriers close both lanes and join releases before any later arrival',async()=>{
 const queue=createRecordingWorkQueue(),release=held(),control=held(),order:string[]=[];
 queue.enqueue('frame',{run(){order.push('frame');},async release(){order.push('releasing');await release.promise;order.push('released');}});
 queue.enqueue('event',{run(){order.push('event');}});
 const barrier=queue.barrier(async()=>{order.push('read');await control.promise;order.push('read-done');});
 queue.enqueue('event',{run(){order.push('later-event');}});
 queue.enqueue('frame',{run(){order.push('later-frame');}});
 const finish=queue.barrier(()=>{order.push('finish');});
 await turn();assert.deepEqual(order,['frame','releasing']);
 release.release();await turn();assert.deepEqual(order,['frame','releasing','released','event','read']);
 control.release();await barrier;await finish;
 assert.deepEqual(order,['frame','releasing','released','event','read','read-done','later-frame','later-event','finish']);
});

test('errors and failed barriers still release owned inputs and join the entire preceding segment',async()=>{
 const queue=createRecordingWorkQueue(),release=held(),order:string[]=[],errors:string[]=[];
 queue.enqueue('frame',{run(){throw Error('frame failed');},async release(){await release.promise;order.push('release1');},onError(error){errors.push(String(error));}});
 queue.enqueue('event',{run(){order.push('event');throw Error('event failed');},release(){order.push('release-event');throw Error('release failed');},onError(error){errors.push(String(error));}});
 queue.enqueue('frame',{run(){order.push('skipped');},release(){order.push('release2');}});
 const failed=queue.barrier(()=>{order.push('failed-control');throw Error('control failed');});
 const rejection=assert.rejects(failed,/control failed/);
 queue.enqueue('event',{run(){order.push('after-control');}});
 const done=queue.barrier();
 await turn();assert.deepEqual(order,[]);release.release();await rejection;await done;
 assert.deepEqual(errors,['Error: frame failed','Error: event failed','Error: release failed']);
 assert.deepEqual(order,['release1','event','release-event','skipped','release2','failed-control','after-control']);
 assert.deepEqual(queue.pending,{frame:0,event:0});
});

test('lane bounds include active release and rejected work stays with its caller',async()=>{
 const queue=createRecordingWorkQueue({frame:2,event:1}),release=held();let ranRejected=false;
 assert.equal(queue.enqueue('frame',{run(){},async release(){await release.promise;}}),true);
 assert.equal(queue.enqueue('frame',{run(){}}),true);
 assert.equal(queue.enqueue('frame',{run(){ranRejected=true;}}),false);
 assert.equal(queue.enqueue('event',{run(){}}),true);
 assert.equal(queue.enqueue('event',{run(){ranRejected=true;}}),false);
 await turn();assert.deepEqual(queue.pending,{frame:2,event:1});release.release();await queue.barrier();
 assert.equal(ranRejected,false);assert.deepEqual(queue.pending,{frame:0,event:0});
 assert.equal(queue.enqueue('frame',{run(){}}),true);await queue.barrier();
 assert.throws(()=>createRecordingWorkQueue({frame:0,event:1}),/한도/);
});

test('a throwing error reporter cannot strand later cleanup or the final barrier',async()=>{
 const queue=createRecordingWorkQueue(),order:string[]=[];
 queue.enqueue('frame',{run(){throw Error('failed');},onError(){throw Error('reporter failed');},release(){order.push('release');}});
 queue.enqueue('event',{run(){order.push('event');}});
 await queue.barrier(()=>{order.push('finish');});
 assert.deepEqual(order,['release','event','finish']);assert.deepEqual(queue.pending,{frame:0,event:0});
});
