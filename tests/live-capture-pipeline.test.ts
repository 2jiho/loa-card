import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveCapturePipeline,parseLiveCaptureDecision} from '../src/features/card-scanner/live-capture-pipeline';
import type {LiveCaptureDecision} from '../src/features/card-scanner/live-capture-pipeline';
import {InputDecisionReplay} from '../src/features/card-scanner/live-input-decision-replay';

function deferred<T=void>() {
  let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function scheduler() {
  const tasks:ReturnType<typeof deferred>[]=[];
  return {tasks,yieldTask:()=>{const task=deferred();tasks.push(task);return task.promise;},
    async next(){await turn();assert.ok(tasks.length,'a task is scheduled');tasks.shift()!.resolve();await turn();}};
}
type Frame={id:number;pixels:Uint8Array;closed:boolean};
const frame=(id:number):Frame=>({id,pixels:new Uint8Array([id]),closed:false});

test('capture ownership, frozen pixels and timestamp stay together outside the input callback',async()=>{
  const clock=scheduler(),calls:{id:number;pixel:number;time:number}[]=[],released:number[]=[];
  let inCallback=true;
  const pipeline=createLiveCapturePipeline<Frame>({maxPendingFrames:1,yieldTask:clock.yieldTask,
    consume:(input,time)=>{assert.equal(inCallback,false);assert.equal(input.closed,false);calls.push({id:input.id,pixel:input.pixels[0],time});},
    release:input=>{assert.equal(input.closed,false);input.closed=true;released.push(input.id);},onError:assert.fail});
  const livePixels=new Uint8Array([7]),frozen={id:1,pixels:livePixels.slice(),closed:false};
  pipeline.offer(frozen,12.5);livePixels[0]=99;inCallback=false;
  assert.deepEqual(calls,[]);assert.equal(pipeline.busy,true);
  await clock.next();await pipeline.flush();
  assert.deepEqual(calls,[{id:1,pixel:7,time:12.5}]);assert.deepEqual(released,[1]);assert.equal(pipeline.busy,false);
});

test('many arrivals keep only the newest pending frame and never overlap consumers',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[];let active=0,peak=0;
  const pipeline=createLiveCapturePipeline<Frame>({maxPendingFrames:1,yieldTask:clock.yieldTask,
    consume:async input=>{active++;peak=Math.max(peak,active);seen.push(input.id);if(input.id===1)await held.promise;active--;},
    release:input=>{assert.equal(input.closed,false);input.closed=true;released.push(input.id);},onError:assert.fail});
  pipeline.offer(frame(1),1);await clock.next();
  for(let i=2;i<=100;i++)pipeline.offer(frame(i),i);
  assert.deepEqual(seen,[1]);assert.equal(released.length,98);assert.equal(released.includes(1),false);assert.equal(released.includes(100),false);
  held.resolve();await turn();assert.deepEqual(seen,[1]);
  await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[1,100]);assert.equal(peak,1);assert.equal(released.length,100);assert.equal(new Set(released).size,100);
});

test('replacement during the scheduled yield keeps the newest timestamp without consuming old frames',async()=>{
  const clock=scheduler(),seen:number[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:clock.yieldTask,consume:(input,time)=>{assert.equal(time,input*10);seen.push(input);},release:input=>{released.push(input);},onError:assert.fail});
  pipeline.offer(1,10);await turn();pipeline.offer(2,20);pipeline.offer(3,30);
  assert.deepEqual(released,[1,2]);await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[3]);assert.deepEqual(released,[1,2,3]);
});

test('flush drains active and final pending input and all callers observe release before completion',async()=>{
  const clock=scheduler(),first=deferred(),last=deferred(),released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:clock.yieldTask,consume:input=>input===1?first.promise:last.promise,release:input=>{released.push(input);},onError:assert.fail});
  pipeline.offer(1,10);await clock.next();pipeline.offer(2,20);
  let flushed=false;const a=pipeline.flush(),b=pipeline.flush();assert.equal(a,b);
  void a.then(()=>{flushed=true;});first.resolve();await turn();assert.equal(flushed,false);
  await clock.next();assert.equal(flushed,false);assert.equal(pipeline.busy,true);
  last.resolve();await a;assert.deepEqual(released,[1,2]);assert.equal(flushed,true);assert.equal(pipeline.busy,false);
});

test('abort disposes pending input immediately but releases active input only after consumption ends',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:clock.yieldTask,consume:input=>{seen.push(input);return held.promise;},release:input=>{released.push(input);},onError:assert.fail});
  pipeline.offer(1,10);await clock.next();pipeline.offer(2,20);pipeline.dispose();pipeline.dispose();pipeline.offer(3,30);
  assert.deepEqual(released,[2,3]);assert.equal(pipeline.busy,true);
  let drained=false;const done=pipeline.flush().then(()=>{drained=true;});await turn();assert.equal(drained,false);
  held.resolve();await done;assert.deepEqual(seen,[1]);assert.deepEqual(released,[2,3,1]);assert.equal(pipeline.busy,false);
});

test('abort before the yield finishes drains immediately and never starts a disposed resource',async()=>{
  const clock=scheduler(),released:number[]=[],errors:unknown[]=[];let consumed=0;
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:clock.yieldTask,consume:()=>{consumed++;},release:input=>{released.push(input);},onError:error=>{errors.push(error);}});
  pipeline.offer(1,10);await turn();const done=pipeline.flush();pipeline.dispose();await done;
  assert.equal(pipeline.busy,false);assert.deepEqual(released,[1]);await clock.next();assert.deepEqual(released,[1]);
  assert.equal(consumed,0);assert.deepEqual(errors,[]);
});

test('consumer failure reports once, releases active and pending input and handles later offers',async()=>{
  const clock=scheduler(),held=deferred(),failure=new Error('consumer failed'),errors:unknown[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:clock.yieldTask,consume:()=>held.promise,release:input=>{released.push(input);},onError:error=>{errors.push(error);}});
  pipeline.offer(1,10);await clock.next();pipeline.offer(2,20);const done=pipeline.flush();held.reject(failure);await done;
  pipeline.offer(3,30);await turn();assert.deepEqual(errors,[failure]);assert.deepEqual(released,[1,2,3]);assert.equal(pipeline.busy,false);
});

test('yield and reporting failures cannot orphan accepted resources or reject flush',async()=>{
  const clock=scheduler(),failure=new Error('scheduler failed'),errors:unknown[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:clock.yieldTask,consume:()=>assert.fail('failed yield'),release:input=>{released.push(input);},onError:error=>{errors.push(error);throw new Error('reporting failed');}});
  pipeline.offer(1,10);const done=pipeline.flush();await turn();clock.tasks.shift()!.reject(failure);await done;await turn();
  assert.deepEqual(errors,[failure]);assert.deepEqual(released,[1]);assert.equal(pipeline.busy,false);
});

test('even an immediately fulfilled yield runs heavy consumption after offer returns',async()=>{
  let offering=true;const order:string[]=[];
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:()=>Promise.resolve(),consume:()=>{assert.equal(offering,false);order.push('consume');},release:()=>{order.push('release');},onError:assert.fail});
  pipeline.offer(1,10);order.push('offer returned');offering=false;await pipeline.flush();
  assert.deepEqual(order,['offer returned','consume','release']);
});

test('synchronous consumer and release failures report once and finish cleanup without rejected tasks',async()=>{
  const failure=new Error('consume failed'),errors:unknown[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:()=>Promise.resolve(),consume:()=>{throw failure;},
    release:input=>{released.push(input);},onError:error=>{errors.push(error);}});
  pipeline.offer(1,10);await pipeline.flush();assert.deepEqual(errors,[failure]);assert.deepEqual(released,[1]);
  const clock=scheduler(),releaseFailure=new Error('release failed'),cleanupErrors:unknown[]=[],attempted:number[]=[];
  const failingRelease=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:clock.yieldTask,consume:()=>assert.fail('release already failed'),
    release:input=>{attempted.push(input);throw releaseFailure;},onError:error=>{cleanupErrors.push(error);}});
  failingRelease.offer(1,10);failingRelease.offer(2,20);await failingRelease.flush();
  assert.deepEqual(attempted,[1,2]);assert.deepEqual(cleanupErrors,[releaseFailure]);assert.equal(failingRelease.busy,false);
  await clock.next();assert.deepEqual(attempted,[1,2]);
});

test('decision recording preserves source identities and reports replacement before consuming only the latest frame',async()=>{
  const clock=scheduler(),events:LiveCaptureDecision[]=[],seen:number[]=[],released:number[]=[];let time=0;
  const pipeline=createLiveCapturePipeline<Frame>({maxPendingFrames:1,yieldTask:clock.yieldTask,now:()=>++time,
    consume:(input,captureTime)=>{seen.push(input.id);assert.equal(captureTime,2.5);},
    release:input=>{input.closed=true;released.push(input.id);},onError:assert.fail,onRecordError:assert.fail,
    onDecision:event=>{assert.equal(Object.isFrozen(event),true);events.push(parseLiveCaptureDecision(event));},
  });
  pipeline.offer(frame(1),1.5,{inputId:10,captureTime:1.5,observedAtMs:0});
  pipeline.offer(frame(2),2.5,{inputId:12,captureTime:2.5,observedAtMs:1});
  await clock.next();await pipeline.flush();
  assert.deepEqual(events.map(event=>event.kind),['offered','offered','replaced','released','started','finished','released']);
  assert.deepEqual(events.map(event=>event.seq),[1,2,3,4,5,6,7]);assert.deepEqual(events.map(event=>event.atMs),[1,2,3,4,5,6,7]);
  assert.deepEqual(events[2],{version:2,seq:3,atMs:3,kind:'replaced',oldInputId:10,newInputId:12});
  assert.deepEqual(events.filter(event=>event.kind==='started').map(event=>[event.inputId,event.captureTime]),[[12,2.5]]);
  assert.deepEqual(events.filter(event=>event.kind==='released').map(event=>[event.inputId,event.reason,event.failed]),[[10,'replaced',false],[12,'normal',false]]);
  assert.deepEqual(seen,[2]);assert.deepEqual(released,[1,2]);assert.equal(JSON.stringify(events).includes('pixels'),false);
});

test('disposal and rejected offers retain exactly-once cleanup while the active frame finishes normally',async()=>{
  const clock=scheduler(),held=deferred(),events:LiveCaptureDecision[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:clock.yieldTask,now:()=>0,
    consume:()=>held.promise,release:input=>{released.push(input);},onError:assert.fail,onDecision:event=>{events.push(event);},
  });
  pipeline.offer(1,1);await clock.next();pipeline.offer(2,2);pipeline.dispose();pipeline.offer(3,3);
  held.resolve();await pipeline.flush();
  assert.deepEqual(events.filter(event=>event.kind==='released').map(event=>[event.inputId,event.reason]),[[2,'disposed'],[3,'rejected'],[1,'normal']]);
  assert.deepEqual(released,[2,3,1]);assert.deepEqual(events.filter(event=>event.kind==='finished').map(event=>event.outcome),['completed']);
});

test('consumer and release failures are recorded without changing failure ownership',async()=>{
  const clock=scheduler(),held=deferred(),events:LiveCaptureDecision[]=[],released:number[]=[],failure=new Error('read failed'),errors:unknown[]=[];
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:clock.yieldTask,now:()=>0,consume:()=>held.promise,
    release:input=>{released.push(input);},onError:error=>{errors.push(error);},onDecision:event=>{events.push(event);},
  });
  pipeline.offer(1,1);await clock.next();pipeline.offer(2,2);const done=pipeline.flush();held.reject(failure);await done;
  pipeline.offer(3,3);
  assert.deepEqual(events.filter(event=>event.kind==='released').map(event=>[event.inputId,event.reason]),[[1,'error'],[2,'error'],[3,'rejected']]);
  assert.deepEqual(events.filter(event=>event.kind==='finished').map(event=>event.outcome),['error']);
  assert.deepEqual(released,[1,2,3]);assert.deepEqual(errors,[failure]);
  const badRelease:LiveCaptureDecision[]=[],attempted:number[]=[],releaseFailure=new Error('release failed'),releaseErrors:unknown[]=[];
  const cleanup=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:()=>Promise.resolve(),now:()=>0,consume:()=>{},
    release:input=>{attempted.push(input);throw releaseFailure;},onError:error=>{releaseErrors.push(error);},onDecision:event=>{badRelease.push(event);},
  });
  cleanup.offer(1,1);await cleanup.flush();assert.deepEqual(attempted,[1]);assert.deepEqual(releaseErrors,[releaseFailure]);
  assert.equal(badRelease.at(-1)?.kind,'released');assert.equal((badRelease.at(-1) as Extract<LiveCaptureDecision,{kind:'released'}>).failed,true);
});

test('synchronous and asynchronous recorder failures report loss without stopping scanning',async()=>{
  for(const asynchronous of [false,true]){
    const failure=new Error('recorder failed'),recordErrors:unknown[]=[],seen:number[]=[],released:number[]=[];
    let callbacks=0;
    const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:()=>Promise.resolve(),now:()=>0,
      consume:input=>{seen.push(input);},release:input=>{released.push(input);},onError:assert.fail,
      onDecision:()=>{callbacks++;if(asynchronous)return Promise.reject(failure);throw failure;},
      onRecordError:error=>{recordErrors.push(error);throw new Error('loss report failed too');},
    });
    pipeline.offer(1,1);await pipeline.flush();pipeline.offer(2,2);await pipeline.flush();await turn();
    assert.deepEqual(recordErrors,[failure]);assert.equal(callbacks,1);assert.deepEqual(seen,[1,2]);assert.deepEqual(released,[1,2]);
  }
});

test('invalid recording clocks and identities mark loss without changing the consumer input',async()=>{
  for(const clock of [()=>NaN,()=>-1,(()=>{let first=true;return()=>{const next=first?10:9;first=false;return next;};})()]){
    const seen:number[]=[],released:number[]=[],errors:unknown[]=[];
    const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:()=>Promise.resolve(),now:clock,
      consume:input=>{seen.push(input);},release:input=>{released.push(input);},onError:assert.fail,onDecision:()=>{},onRecordError:error=>{errors.push(error);},
    });
    pipeline.offer(1,1);await pipeline.flush();assert.equal(errors.length,1);assert.deepEqual(seen,[1]);assert.deepEqual(released,[1]);
  }
  let losses=0,seen=0,released=0;
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,yieldTask:()=>Promise.resolve(),consume:(input,time)=>{seen=input;assert.equal(time,1);},
    release:input=>{released=input;},onError:assert.fail,onDecision:()=>assert.fail('bad identity cannot be recorded'),onRecordError:()=>{losses++;},
  });
  pipeline.offer(1,1,{inputId:1,captureTime:2,observedAtMs:0});await pipeline.flush();
  assert.equal(losses,1);assert.equal(seen,1);assert.equal(released,1);
});

test('decision parser rejects unknown fields, invalid stamps, outcomes and ownership reasons',()=>{
  const valid={version:1,seq:1,atMs:0,kind:'offered',inputId:1,captureTime:0,observedAtMs:0};
  assert.deepEqual(parseLiveCaptureDecision(valid),valid);
  for(const value of [null,[],{},Object.create(valid), {...valid,version:2},{...valid,seq:0},{...valid,atMs:NaN},
    {...valid,inputId:'1'},{...valid,captureTime:-1},{...valid,pixels:new Uint8Array()},
    {version:1,seq:2,atMs:1,kind:'replaced',oldInputId:2,newInputId:1},
    {version:1,seq:2,atMs:1,kind:'finished',inputId:1,captureTime:0,outcome:'unknown'},
    {version:1,seq:2,atMs:1,kind:'released',inputId:1,captureTime:0,reason:'unknown',failed:false},
    {version:1,seq:2,atMs:1,kind:'released',inputId:1,captureTime:0,reason:'normal',failed:0},
  ])assert.throws(()=>parseLiveCaptureDecision(value));
});

test('representative queue retains oldest and newest unknown views with one active consumer',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[],events:LiveCaptureDecision[]=[];
  let active=0,peak=0,owned=0,peakOwned=0;
  const pipeline=createLiveCapturePipeline<Frame>({yieldTask:clock.yieldTask,
    consume:async input=>{active++;peak=Math.max(peak,active);seen.push(input.id);if(input.id===1)await held.promise;active--;},
    release:input=>{assert.equal(input.closed,false);input.closed=true;released.push(input.id);owned--;},onError:assert.fail,
    onDecision:event=>{events.push(event);if(event.kind==='offered'){owned++;peakOwned=Math.max(peakOwned,owned);}},
  });
  pipeline.offer(frame(1),1);await clock.next();
  for(let id=2;id<=100;id++)pipeline.offer(frame(id),id);
  assert.deepEqual(seen,[1]);assert.equal(released.length,97);assert.equal(owned,3);assert.equal(peakOwned,4);
  assert.equal(released.includes(2),false);assert.equal(released.includes(100),false);
  held.resolve();await turn();await clock.next();await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[1,2,100]);assert.equal(peak,1);assert.equal(owned,0);assert.equal(new Set(released).size,100);
  assert.deepEqual(events.filter(event=>event.kind==='started').map(event=>event.captureTime),[1,2,100]);
});

test('representatives retained before first yield are consumed FIFO while newest keeps its capture stamp',async()=>{
  const clock=scheduler(),seen:[number,number][]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({yieldTask:clock.yieldTask,consume:(input,time)=>{seen.push([input,time]);},
    release:input=>{released.push(input);},onError:assert.fail});
  pipeline.offer(1,10);pipeline.offer(2,20);pipeline.offer(3,30);
  assert.deepEqual(released,[2]);await clock.next();await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[[1,10],[3,30]]);assert.deepEqual(released,[2,1,3]);
});

test('same frozen row range coalesces to newest without losing a different pending view',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({yieldTask:clock.yieldTask,
    consume:input=>{seen.push(input);if(input===1)return held.promise;},release:input=>{released.push(input);},onError:assert.fail});
  pipeline.offer(1,1,undefined,{rowStart:0,rowCount:4});await clock.next();
  pipeline.offer(2,2,undefined,{rowStart:4,rowCount:4});
  pipeline.offer(3,3,undefined,{rowStart:8,rowCount:4});
  const hint={rowStart:4,rowCount:4};pipeline.offer(4,4,undefined,hint);hint.rowStart=100;
  assert.deepEqual(released,[2]);held.resolve();await turn();await clock.next();await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[1,3,4]);assert.deepEqual(released,[2,1,3,4]);
});

test('an older complete view survives later covered and transitional rasters with the same row hint',async()=>{
  type View={id:number;quality:'complete'|'covered'|'transitional';closed:boolean};
  const clock=scheduler(),held=deferred(),seen:{id:number;quality:View['quality'];time:number}[]=[],released:number[]=[],events:LiveCaptureDecision[]=[];
  const live=new InputDecisionReplay(new AbortController().signal);let now=0;
  const pipeline=createLiveCapturePipeline<View>({yieldTask:clock.yieldTask,now:()=>now++,
    consume:(input,time)=>{assert.equal(input.closed,false);seen.push({id:input.id,quality:input.quality,time});if(input.id===1)return held.promise;},
    release:input=>{assert.equal(input.closed,false);input.closed=true;released.push(input.id);},onError:assert.fail,onRecordError:assert.fail,
    onDecision:event=>{events.push(parseLiveCaptureDecision(event));live.pipeline(event);}});
  const offer=(id:number,quality:View['quality'])=>pipeline.offer({id,quality,closed:false},id+0.25,
    {inputId:id*10,captureTime:id+0.25,observedAtMs:id*100},{rowStart:4,rowCount:4});
  offer(1,'complete');await clock.next();offer(2,'complete');offer(3,'covered');offer(4,'transitional');
  assert.deepEqual(released,[3],'an equal hint is insufficient to discard the older readable raster');
  held.resolve();await turn();await clock.next();await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[{id:1,quality:'complete',time:1.25},{id:2,quality:'complete',time:2.25},{id:4,quality:'transitional',time:4.25}]);
  assert.deepEqual(events.filter(event=>event.kind==='started').map(event=>[event.inputId,event.captureTime]),[[10,1.25],[20,2.25],[40,4.25]]);
  assert.deepEqual(events.filter(event=>event.kind==='replaced').map(event=>[event.oldInputId,event.newInputId]),[[30,40]]);
  assert.deepEqual(events.map(event=>event.seq),events.map((_,index)=>index+1));assert.deepEqual(released,[3,1,2,4]);
  const captured=await live.summary(),replay=new InputDecisionReplay(new AbortController().signal);
  for(const event of events)replay.pipeline(event);replay.checkpoint({complete:true,hash:captured.hash});
  assert.equal(captured.settled,true);assert.equal(captured.pipeline.started,3);assert.equal((await replay.summary()).matchesCapturedState,true);
});

test('many identical row hints retain the oldest pending raster and the newest capture stamp',async()=>{
  const clock=scheduler(),held=deferred(),seen:[number,number][]=[],released:number[]=[],events:LiveCaptureDecision[]=[];
  const pipeline=createLiveCapturePipeline<Frame>({yieldTask:clock.yieldTask,
    consume:(input,time)=>{seen.push([input.id,time]);if(input.id===1)return held.promise;},
    release:input=>{assert.equal(input.closed,false);input.closed=true;released.push(input.id);},onError:assert.fail,
    onDecision:event=>{events.push(event);}});
  pipeline.offer(frame(1),0.1,undefined,{rowStart:0,rowCount:4});await clock.next();
  for(let id=2;id<=100;id++)pipeline.offer(frame(id),id/10,undefined,{rowStart:4,rowCount:4});
  assert.equal(released.length,97);assert.equal(released.includes(2),false);assert.equal(released.includes(100),false);
  held.resolve();await turn();await clock.next();await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[[1,0.1],[2,0.2],[100,10]]);assert.equal(released.length,100);assert.equal(new Set(released).size,100);
  assert.deepEqual(events.filter(event=>event.kind==='started').map(event=>event.inputId),[1,2,100]);
});

test('a fitting distinct row range keeps its preference even when active coverage ties the same-range raster',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({yieldTask:clock.yieldTask,
    consume:input=>{seen.push(input);if(input===1)return held.promise;},release:input=>{released.push(input);},onError:assert.fail});
  pipeline.offer(1,1,undefined,{rowStart:0,rowCount:4});await clock.next();
  pipeline.offer(2,2,undefined,{rowStart:4,rowCount:4});pipeline.offer(3,3,undefined,{rowStart:0,rowCount:4});
  pipeline.offer(4,4,undefined,{rowStart:4,rowCount:4});assert.deepEqual(released,[2]);
  held.resolve();await turn();await clock.next();await clock.next();await pipeline.flush();assert.deepEqual(seen,[1,3,4]);
});

test('same-range retention respects the byte cap and the explicit latest-only setting',async()=>{
  for(const [maxPendingFrames,maxRetainedBytes,expected] of [[2,3,[1,2,4]],[2,2,[1,4]],[1,3,[1,4]]] as const){
    const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[];
    const pipeline=createLiveCapturePipeline<number>({maxPendingFrames,maxRetainedBytes,frameBytes:()=>1,yieldTask:clock.yieldTask,
      consume:input=>{seen.push(input);if(input===1)return held.promise;},release:input=>{released.push(input);},onError:assert.fail});
    pipeline.offer(1,1,undefined,{rowStart:0,rowCount:4});await clock.next();
    for(const id of [2,3,4])pipeline.offer(id,id,undefined,{rowStart:4,rowCount:4});
    held.resolve();await turn();for(let index=1;index<expected.length;index++)await clock.next();await pipeline.flush();
    assert.deepEqual(seen,expected);assert.equal(new Set(released).size,4);assert.equal(released.length,4);
  }
});

test('historical v2 same-range replacement choices remain valid recorded ownership',async()=>{
  const replay=new InputDecisionReplay(new AbortController().signal);let seq=0;
  const event=(kind:string,inputId:number,extra:Record<string,unknown>={})=>({version:2,seq:++seq,atMs:seq,kind,inputId,captureTime:inputId,...extra});
  const offer=(inputId:number)=>event('offered',inputId,{observedAtMs:inputId,selection:{rowStart:4,rowCount:4},estimatedBytes:1,
    maxPendingFrames:2,maxRetainedBytes:3});
  replay.pipeline(offer(1));replay.pipeline(offer(2));
  replay.pipeline({version:2,seq:++seq,atMs:seq,kind:'replaced',oldInputId:1,newInputId:2});
  replay.pipeline(event('released',1,{reason:'replaced',failed:false}));replay.pipeline(offer(3));
  replay.pipeline({version:2,seq:++seq,atMs:seq,kind:'replaced',oldInputId:2,newInputId:3});
  replay.pipeline(event('released',2,{reason:'replaced',failed:false}));replay.pipeline(event('started',3));
  replay.pipeline(event('finished',3,{outcome:'completed'}));replay.pipeline(event('released',3,{reason:'normal',failed:false}));
  const summary=await replay.summary();assert.equal(summary.settled,true);assert.equal(summary.pipeline.started,1);assert.equal(summary.pipeline.replaced,2);
});

test('overflow preserves row coverage beyond active view instead of a duplicate active-range representative',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({yieldTask:clock.yieldTask,
    consume:input=>{seen.push(input);if(input===1)return held.promise;},release:input=>{released.push(input);},onError:assert.fail});
  pipeline.offer(1,1,undefined,{rowStart:0,rowCount:4});await clock.next();
  pipeline.offer(2,2,undefined,{rowStart:0,rowCount:4});pipeline.offer(3,3,undefined,{rowStart:4,rowCount:4});
  pipeline.offer(4,4,undefined,{rowStart:8,rowCount:4});assert.deepEqual(released,[2]);
  held.resolve();await turn();await clock.next();await clock.next();await pipeline.flush();assert.deepEqual(seen,[1,3,4]);
});

test('unknown selection falls back to an older representative and newest rather than inventing row certainty',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<number>({yieldTask:clock.yieldTask,
    consume:input=>{seen.push(input);if(input===1)return held.promise;},release:input=>{released.push(input);},onError:assert.fail});
  pipeline.offer(1,1,undefined,{rowStart:0,rowCount:4});await clock.next();
  pipeline.offer(2,2);pipeline.offer(3,3,undefined,{rowStart:20,rowCount:4});pipeline.offer(4,4,undefined,{rowStart:4,rowCount:4});
  assert.deepEqual(released,[3]);held.resolve();await turn();await clock.next();await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[1,2,4]);
});

test('active and retained raster byte cap reduces representatives at large resolutions',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[],events:LiveCaptureDecision[]=[];
  const bytes=3840*2160*4,cap=64*1024*1024;
  const pipeline=createLiveCapturePipeline<number>({yieldTask:clock.yieldTask,frameBytes:()=>bytes,maxRetainedBytes:cap,
    consume:input=>{seen.push(input);if(input===1)return held.promise;},release:input=>{released.push(input);},onError:assert.fail,
    onDecision:event=>{events.push(event);}});
  pipeline.offer(1,1);await clock.next();pipeline.offer(2,2);pipeline.offer(3,3);
  assert.deepEqual(released,[2]);assert.ok(bytes*2<=cap);assert.ok(bytes*3>cap);
  held.resolve();await turn();await clock.next();await pipeline.flush();assert.deepEqual(seen,[1,3]);
  assert.equal(events.every(event=>event.version===2),true);
  const offered=events.find(event=>event.kind==='offered');assert.equal(offered?.kind,'offered');
  if(offered?.kind==='offered'&&offered.version===2){assert.equal(offered.estimatedBytes,bytes);assert.equal(offered.maxRetainedBytes,cap);}
});

test('an incoming raster that cannot fit active-byte budget is released without failing scan or evicting pending',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[],events:LiveCaptureDecision[]=[];
  const pipeline=createLiveCapturePipeline<{id:number;bytes:number}>({yieldTask:clock.yieldTask,frameBytes:input=>input.bytes,maxRetainedBytes:100,
    consume:input=>{seen.push(input.id);if(input.id===1)return held.promise;},release:input=>{released.push(input.id);},onError:assert.fail,
    onDecision:event=>{events.push(event);}});
  pipeline.offer({id:1,bytes:60},1);await clock.next();pipeline.offer({id:2,bytes:20},2);pipeline.offer({id:3,bytes:50},3);
  assert.deepEqual(released,[3]);held.resolve();await turn();await clock.next();await pipeline.flush();
  pipeline.offer({id:4,bytes:101},4);await pipeline.flush();pipeline.offer({id:5,bytes:50},5);await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[1,2,5]);assert.deepEqual(released,[3,1,2,4,5]);
  assert.deepEqual(events.filter(event=>event.kind==='released'&&event.reason==='capacity').map(event=>event.inputId),[3,4]);
});

test('byte pressure may evict both old representatives to preserve newest within budget',async()=>{
  const clock=scheduler(),held=deferred(),seen:number[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline<{id:number;bytes:number}>({yieldTask:clock.yieldTask,frameBytes:input=>input.bytes,maxRetainedBytes:100,
    consume:input=>{seen.push(input.id);if(input.id===1)return held.promise;},release:input=>{released.push(input.id);},onError:assert.fail});
  pipeline.offer({id:1,bytes:40},1);await clock.next();pipeline.offer({id:2,bytes:20},2);pipeline.offer({id:3,bytes:30},3);
  pipeline.offer({id:4,bytes:50},4);assert.deepEqual(released,[2,3]);held.resolve();await turn();await clock.next();await pipeline.flush();
  assert.deepEqual(seen,[1,4]);
});

test('two pending representatives are released once on failure and active joins flush before settling',async()=>{
  const clock=scheduler(),held=deferred(),released:number[]=[],errors:unknown[]=[];const failure=new Error('active failed');
  const pipeline=createLiveCapturePipeline<number>({yieldTask:clock.yieldTask,consume:()=>held.promise,
    release:input=>{assert.equal(released.includes(input),false);released.push(input);},onError:error=>{errors.push(error);}});
  pipeline.offer(1,1);await clock.next();pipeline.offer(2,2);pipeline.offer(3,3);const done=pipeline.flush();held.reject(failure);await done;
  pipeline.dispose();pipeline.offer(4,4);assert.deepEqual(released,[1,2,3,4]);assert.deepEqual(errors,[failure]);
});

test('version two parser retains detached selection and source annotations while legacy version remains strict',()=>{
  const input={version:2,seq:1,atMs:0,kind:'offered',inputId:1,captureTime:0,observedAtMs:0,
    selection:{rowStart:4,rowCount:4},estimatedBytes:14_745_600,maxPendingFrames:2,maxRetainedBytes:64*1024*1024,
    source:{mediaTime:4.5,presentedFrames:136,frameTimestampUs:4_500_000}};
  const parsed=parseLiveCaptureDecision(input);input.selection.rowStart=99;input.source.mediaTime=99;
  assert.equal(parsed.kind,'offered');if(parsed.kind==='offered'&&parsed.version===2){
    assert.deepEqual(parsed.selection,{rowStart:4,rowCount:4});assert.equal(Object.isFrozen(parsed.selection),true);
    assert.equal(parsed.source?.mediaTime,4.5);assert.equal(Object.isFrozen(parsed.source),true);
  }
  for(const invalid of [{...input,estimatedBytes:0},{...input,maxPendingFrames:3},{...input,maxRetainedBytes:Infinity},
    {...input,selection:{rowStart:-1,rowCount:4}},{...input,selection:{rowStart:0,rowCount:0}},
    {...input,selection:{rowStart:0,rowCount:4,confidence:1}},{...input,source:{mediaTime:0,pixels:'private'}},
    {...input,version:1},{...input,version:3}])assert.throws(()=>parseLiveCaptureDecision(invalid));
  assert.throws(()=>parseLiveCaptureDecision({version:1,seq:1,atMs:0,kind:'released',inputId:1,captureTime:0,reason:'capacity',failed:false}));
  assert.deepEqual(parseLiveCaptureDecision({version:2,seq:1,atMs:0,kind:'released',inputId:1,captureTime:0,reason:'capacity',failed:false}),
    {version:2,seq:1,atMs:0,kind:'released',inputId:1,captureTime:0,reason:'capacity',failed:false});
});

test('invalid raster size marks recording incomplete and rejects only that resource',async()=>{
  const seen:number[]=[],released:number[]=[],losses:unknown[]=[];
  const pipeline=createLiveCapturePipeline<number>({yieldTask:()=>Promise.resolve(),frameBytes:input=>input===1?NaN:1,
    consume:input=>{seen.push(input);},release:input=>{released.push(input);},onError:assert.fail,onDecision:()=>{},onRecordError:error=>{losses.push(error);}});
  pipeline.offer(1,1);await pipeline.flush();pipeline.offer(2,2);await pipeline.flush();
  assert.deepEqual(seen,[2]);assert.deepEqual(released,[1,2]);assert.equal(losses.length,1);
});

test('release failure during two-pending byte eviction cleans every detached resource exactly once',async()=>{
  const clock=scheduler(),held=deferred(),released:number[]=[],errors:unknown[]=[];const failure=new Error('release two failed');
  const pipeline=createLiveCapturePipeline<{id:number;bytes:number}>({yieldTask:clock.yieldTask,maxRetainedBytes:100,frameBytes:input=>input.bytes,
    consume:input=>{if(input.id===1)return held.promise;assert.fail('failed queue cannot consume');},
    release:input=>{assert.equal(released.includes(input.id),false);released.push(input.id);if(input.id===2)throw failure;},
    onError:error=>{errors.push(error);}});
  pipeline.offer({id:1,bytes:40},1);await clock.next();pipeline.offer({id:2,bytes:20},2);pipeline.offer({id:3,bytes:30},3);
  pipeline.offer({id:4,bytes:50},4);assert.deepEqual(released,[2,4,3]);assert.deepEqual(errors,[failure]);
  let settled=false;const done=pipeline.flush().then(()=>{settled=true;});await turn();assert.equal(settled,false);
  held.resolve();await done;pipeline.dispose();assert.deepEqual(released,[2,4,3,1]);
});

test('consumer and pending-release callbacks may dispose without orphaning representatives',async()=>{
  const clock=scheduler(),held=deferred(),released:number[]=[],seen:number[]=[];
  let pipeline:ReturnType<typeof createLiveCapturePipeline<number>>;
  pipeline=createLiveCapturePipeline<number>({yieldTask:clock.yieldTask,
    consume:input=>{seen.push(input);return held.promise;},
    release:input=>{assert.equal(released.includes(input),false);released.push(input);if(input===3)pipeline.dispose();},onError:assert.fail});
  pipeline.offer(1,1);await clock.next();pipeline.offer(2,2);pipeline.offer(3,3);pipeline.offer(4,4);
  assert.deepEqual(released,[3,2,4]);held.resolve();await pipeline.flush();assert.deepEqual(released,[3,2,4,1]);assert.deepEqual(seen,[1]);
  const disposed:number[]=[];let sync:ReturnType<typeof createLiveCapturePipeline<number>>;
  sync=createLiveCapturePipeline<number>({yieldTask:()=>Promise.resolve(),consume:()=>sync.dispose(),release:input=>{disposed.push(input);},onError:assert.fail});
  sync.offer(1,1);sync.offer(2,2);await sync.flush();assert.deepEqual(disposed,[2,1]);
});
