import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {RecorderWorkerReply} from '../src/features/card-scanner/reproduction/share-recorder-worker';

/** A minimal I420 frame, as the worker reads it. */
function fakeFrame(timestamp:number) {
  return {displayWidth:4,displayHeight:4,format:'I420',timestamp,colorSpace:null,
    allocationSize:()=>24,copyTo:async()=>undefined,close(){}};
}

test('sealing after a failed upload ends instead of waiting for frames that will never be sent', async()=>{
  const replies:RecorderWorkerReply[]=[];let sealed!:()=>void;
  const done=new Promise<void>(resolve=>{sealed=resolve;});
  const scope=globalThis as unknown as {self:unknown;fetch:unknown};
  const previousSelf=scope.self,previousFetch=scope.fetch;
  const worker:{postMessage(reply:RecorderWorkerReply):void;onmessage?:(event:{data:unknown})=>void}={
    postMessage(reply){replies.push(reply);if(reply.type==='sealed')sealed();}};
  const requests:string[]=[];
  scope.self=worker;
  scope.fetch=async(url:string)=>{
    requests.push(url.slice(url.lastIndexOf('/')));
    // The recording starts, then every frame upload is refused.
    if(url.endsWith('/frame'))return new Response('disk full',{status:500});
    return new Response('{}',{status:200});
  };
  try{
    await import('../src/features/card-scanner/reproduction/share-recorder-worker');
    // More frames than can be in flight at once, so some are still waiting when the first upload fails.
    const frames=Array.from({length:30},(_,index)=>fakeFrame(index*33_000));
    const readable=new ReadableStream({pull(controller){const frame=frames.shift();if(frame)controller.enqueue(frame);else controller.close();}});
    worker.onmessage!({data:{type:'start',base:'http://recorder.invalid/__rec',id:'t',environment:null,readable}});
    await new Promise(resolve=>setTimeout(resolve,50));
    worker.onmessage!({data:{type:'located'}});
    await new Promise(resolve=>setTimeout(resolve,50));
    worker.onmessage!({data:{type:'seal'}});
    const timedOut=await Promise.race([done.then(()=>false),new Promise<boolean>(resolve=>setTimeout(()=>resolve(true),3000).unref())]);
    assert.equal(timedOut,false,'the worker reported that it sealed');
    assert.ok(replies.some(reply=>reply.type==='error'),'the upload failure was reported');
    assert.ok(requests.includes('/seal'),'the recording was still sealed on the server');
  }finally{scope.self=previousSelf;scope.fetch=previousFetch;}
});
