import {createRecordedShareSchedule,summarizeDeliveryLateness} from './recorded-share-schedule';
import type {RecordedShareDeliveryStats} from './recorded-share-schedule';

/** Development only (docs/dev-recording.md). Delivers a server-side recording's frames to a
 * MediaStreamTrackGenerator's writable stream from a worker.
 *
 * A real shared screen reaches the page's video without the page's JavaScript doing any
 * per-frame work. Writing the frames from the main thread made the replay depend on how
 * busy the scanner kept that thread (frames arrived hundreds of milliseconds late and the
 * browser merged them). In a worker the recorded cadence holds while the scanner works,
 * and the browser still decides which frames the video presents, as for a real share. */
export type ShareWorkerRequest=
  |{type:'init';base:string;recordingId:string;writable:WritableStream<VideoFrame>;untilSeconds?:number}
  |{type:'start'}
  |{type:'stop'};
export type ShareWorkerReply=
  |{type:'ready';meta:unknown;lines:number;recordedLines:number;durationSeconds:number}
  |{type:'done';delivery:RecordedShareDeliveryStats&{frames:number};inputSeconds:number}
  |{type:'error';message:string};

interface Line {readonly seq:number;readonly mediaTimeMs:number|null;readonly deliveredAtMs:number}
const PREFETCH=12;
const post=(reply:ShareWorkerReply)=>self.postMessage(reply);

function sleep(ms:number,signal:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(signal.reason);return;}
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();};
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(done,ms);
    signal.addEventListener('abort',abort,{once:true});
  });
}

let state:{start:()=>void;stop:()=>void}|undefined;

async function init(message:Extract<ShareWorkerRequest,{type:'init'}>) {
  const {base,recordingId}=message,root=`${base}/${encodeURIComponent(recordingId)}`;
  const lifetime=new AbortController();
  const json=async<T>(url:string)=>{const response=await fetch(url,{cache:'no-store',signal:lifetime.signal});if(!response.ok)throw Error(`${url}: ${response.status}`);return await response.json() as T;};
  const meta=await json<{width:number;height:number;colorSpace:unknown}>(root);
  const {lines:allLines}=await json<{lines:Line[]}>(`${root}/lines`);
  // `untilSeconds` ends the share early (a share that stops while the card window is still shown).
  const lines=message.untilSeconds===undefined?allLines:allLines.filter(line=>line.deliveredAtMs/1000<=message.untilSeconds!);
  if(!lines.length)throw Error('기록에 프레임이 없습니다.');
  const response=await fetch(`${root}/frames`,{cache:'no-store',signal:lifetime.signal});
  if(!response.ok||!response.body)throw Error('기록 프레임을 열 수 없습니다.');
  const frameBytes=Number(response.headers.get('x-frame-bytes')),format=response.headers.get('x-pixel-format');
  if(!Number.isSafeInteger(frameBytes)||frameBytes<=0||(format!=='i420'&&format!=='rgba'))throw Error('기록 프레임 형식을 알 수 없습니다.');
  const reader=response.body.getReader(),writer=message.writable.getWriter();
  const colorSpace=meta.colorSpace&&typeof meta.colorSpace==='object'?meta.colorSpace as VideoColorSpaceInit:undefined;

  // Reassemble fixed-size frames from the byte stream, a bounded few ahead.
  const queue:{data:Uint8Array;line:Line}[]=[],wake:(()=>void)[]=[];
  let parts:Uint8Array[]=[],partsBytes=0,producerDone=false,producerError:unknown,decoded=0;
  const notify=()=>{for(const fn of wake.splice(0))fn();};
  const waitForQueue=()=>new Promise<void>(resolve=>{wake.push(resolve);});
  const takeFrame=():Uint8Array=>{
    const frame=new Uint8Array(frameBytes);let filled=0;
    while(filled<frameBytes){
      const part=parts[0],need=frameBytes-filled;
      if(part.length<=need){frame.set(part,filled);filled+=part.length;parts.shift();}
      else{frame.set(part.subarray(0,need),filled);parts[0]=part.subarray(need);filled+=need;}
    }
    partsBytes-=frameBytes;return frame;
  };
  void (async()=>{
    try{
      for(;;){
        while(queue.length>=PREFETCH&&!lifetime.signal.aborted)await waitForQueue();
        if(lifetime.signal.aborted)return;
        const {value,done}=await reader.read();
        if(done)return;
        parts.push(value);partsBytes+=value.length;
        while(partsBytes>=frameBytes&&decoded<lines.length)queue.push({data:takeFrame(),line:lines[decoded++]});
        notify();
        // Every wanted frame is queued: stop reading, so an early end (`untilSeconds`)
        // neither buffers the rest of the recording nor delays the end of the share.
        if(decoded>=lines.length){parts=[];partsBytes=0;void reader.cancel().catch(()=>undefined);return;}
      }
    }catch(error){if(!lifetime.signal.aborted)producerError=error;}
    finally{producerDone=true;notify();}
  })();

  const makeFrame=(entry:{data:Uint8Array;line:Line}):VideoFrame=>new VideoFrame(entry.data as unknown as BufferSource,{
    format:format==='i420'?'I420':'RGBA',codedWidth:meta.width,codedHeight:meta.height,
    timestamp:Math.round(entry.line.deliveredAtMs*1000),
    ...(colorSpace&&format==='i420'?{colorSpace}:{}),transfer:[entry.data.buffer],
  } as VideoFrameBufferInit);
  const schedule=createRecordedShareSchedule({});
  let delivered=0,lastMs=0,originMs:number|null=null;const late:number[]=[];
  const deliver=async(entry:{data:Uint8Array;line:Line})=>{
    const frame=makeFrame(entry);
    // The generator consumes asynchronously; a failed write releases the frame.
    void writer.write(frame).catch(()=>{try{frame.close();}catch{/* Already closed. */}});
    delivered++;lastMs=entry.line.deliveredAtMs;if(originMs===null)originMs=entry.line.deliveredAtMs;
  };

  // The first frame goes out while preparing: the video has nothing to play without one.
  while(!queue.length&&!producerDone)await waitForQueue();
  if(producerError)throw producerError;
  const head=queue.shift();
  if(!head)throw Error('기록 프레임을 디코딩하지 못했습니다.');
  notify();schedule.dueMs(head.line.deliveredAtMs/1000);
  await deliver(head);late.push(0);

  state={
    start(){
      void (async()=>{
        try{
          // Start the clock once the read-ahead is primed, so the first frames are not late
          // by the cost of reading them.
          while(queue.length<Math.min(PREFETCH/2,lines.length-1)&&!producerDone){await waitForQueue();lifetime.signal.throwIfAborted();}
          const t0=performance.now();
          for(;;){
            while(!queue.length&&!producerDone)await waitForQueue();
            lifetime.signal.throwIfAborted();
            if(producerError)throw producerError;
            const entry=queue.shift();notify();
            if(!entry)break;
            const wait=schedule.delayMs(entry.line.deliveredAtMs/1000,performance.now()-t0);
            if(wait>0)await sleep(wait,lifetime.signal);
            late.push(schedule.lateMs(entry.line.deliveredAtMs/1000,performance.now()-t0));
            await deliver(entry);
          }
          post({type:'done',delivery:{...summarizeDeliveryLateness(late),frames:delivered},inputSeconds:originMs===null?0:Math.max(0,(lastMs-originMs)/1000)});
        }catch(error){if(!lifetime.signal.aborted)post({type:'error',message:error instanceof Error?error.message:String(error)});}
      })();
    },
    stop(){lifetime.abort(new DOMException('Stopped','AbortError'));void reader.cancel().catch(()=>undefined);notify();},
  };
  post({type:'ready',meta,lines:lines.length,recordedLines:allLines.length,durationSeconds:(lines[lines.length-1].deliveredAtMs-lines[0].deliveredAtMs)/1000});
}

self.onmessage=(event:MessageEvent<ShareWorkerRequest>)=>{
  const message=event.data;
  if(message.type==='init'){void init(message).catch(error=>post({type:'error',message:error instanceof Error?error.message:String(error)}));return;}
  if(message.type==='start'){state?.start();return;}
  state?.stop();
};
