import type {LiveVideoInput} from './live-video-input';
import {createRecordedShareSchedule,summarizeDeliveryLateness} from './recorded-share-schedule';
import type {RecordedShareDeliveryStats,RecordedShareScheduleOptions} from './recorded-share-schedule';

/** Development adapter: re-executes a server-side recording (docs/dev-recording.md)
 * through the real live path.
 *
 * The server decodes the lossless recording and streams the frames in the
 * layout they were received in (I420 for native YUV). Each is turned back into
 * a VideoFrame and written to a MediaStreamTrackGenerator, so the scanner gets
 * a real MediaStream track whose frames carry the original source bytes and
 * color description. Nothing is recolored on the way: the browser converts
 * them exactly as it does for a real share.
 *
 * Reproduced: the frames the recorder received (pixels, order, intervals).
 * Not reproduced: the OS capture clock, the original machine's speed, and
 * frames the recorder dropped (the recording says how many). Delivery
 * lateness is measured and reported; a replay that fell behind its schedule
 * says so. */
export interface RecordedShareMeta {
  readonly id:string;readonly width:number;readonly height:number;
  readonly pixelFormat:'rgba'|'i420'|'nv12';readonly colorSpace:unknown;
  readonly status:'open'|'sealed';readonly frames:number;readonly complete:boolean;
  readonly sha256:string|null;readonly note:string|null;
}
export interface RecordedShareDelivery extends RecordedShareDeliveryStats {
  readonly recordingId:string;
  readonly frames:number;
  /** Frames listed in the recording's timing file. */
  readonly declaredFrames:number;
  readonly recordingComplete:boolean;
  readonly recordingSha256:string|null;
}
export interface RecordedShareInput extends LiveVideoInput {
  readonly meta:RecordedShareMeta;
  /** Delivery faithfulness; meaningful once the input has ended. */
  delivery():RecordedShareDelivery;
}

interface Line {readonly seq:number;readonly mediaTimeMs:number|null;readonly deliveredAtMs:number}
type Generator=MediaStreamTrack&{writable:WritableStream<VideoFrame>;stop():void};
type GeneratorConstructor=new(init:{kind:'video'})=>Generator;
const PREFETCH=12;

function sleep(ms:number,signal:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(signal.reason);return;}
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();};
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(done,ms);
    signal.addEventListener('abort',abort,{once:true});
  });
}

async function getJson<T>(request:typeof fetch,url:string,signal:AbortSignal):Promise<T> {
  const response=await request(url,{signal,cache:'no-store'});
  if(!response.ok)throw Error(`${url}: ${response.status}`);
  return await response.json() as T;
}

export async function prepareRecordedShareInput(options:{
  recordingId:string;target:HTMLVideoElement;signal:AbortSignal;base?:string;request?:typeof fetch;
}&RecordedShareScheduleOptions):Promise<RecordedShareInput> {

  const {target,signal,recordingId}=options,base=options.base??'/__rec',request=options.request??fetch;
  signal.throwIfAborted();
  if(target.srcObject)throw Error('미리보기 영상이 이미 다른 입력에 연결되어 있습니다.');
  const Generator=(globalThis as {MediaStreamTrackGenerator?:GeneratorConstructor}).MediaStreamTrackGenerator;
  if(!Generator||typeof VideoFrame==='undefined')throw Error('이 브라우저는 MediaStreamTrackGenerator를 지원하지 않습니다.');
  const root=`${base}/${encodeURIComponent(recordingId)}`;
  const meta=await getJson<RecordedShareMeta>(request,root,signal);
  const {lines}=await getJson<{lines:Line[]}>(request,`${root}/lines`,signal);
  if(!lines.length)throw Error('기록에 프레임이 없습니다.');
  const response=await request(`${root}/frames`,{signal,cache:'no-store'});
  if(!response.ok||!response.body)throw Error('기록 프레임을 열 수 없습니다.');
  const frameBytes=Number(response.headers.get('x-frame-bytes')),format=response.headers.get('x-pixel-format');
  if(!Number.isSafeInteger(frameBytes)||frameBytes<=0||(format!=='i420'&&format!=='rgba'))throw Error('기록 프레임 형식을 알 수 없습니다.');
  const reader=response.body.getReader();

  // Reassemble fixed-size frames from the byte stream, a bounded few ahead.
  // Chunks are kept as they arrive and copied once per frame (never re-merged).
  const queue:{data:Uint8Array;line:Line}[]=[];
  const wake:(()=>void)[]=[];
  let parts:Uint8Array[]=[],partsBytes=0,producerDone=false,producerError:unknown,decoded=0;
  const notify=()=>{for(const fn of wake.splice(0))fn();};
  const waitForQueue=()=>new Promise<void>(resolve=>{wake.push(resolve);});
  const lifetime=new AbortController();
  /** Take exactly one frame from the front of the buffered chunks. */
  const takeFrame=():Uint8Array=>{
    const frame=new Uint8Array(frameBytes);
    let filled=0;
    while(filled<frameBytes){
      const part=parts[0],need=frameBytes-filled;
      if(part.length<=need){frame.set(part,filled);filled+=part.length;parts.shift();}
      else{frame.set(part.subarray(0,need),filled);parts[0]=part.subarray(need);filled+=need;}
    }
    partsBytes-=frameBytes;
    return frame;
  };
  const produce=async()=>{
    try{
      for(;;){
        while(queue.length>=PREFETCH&&!lifetime.signal.aborted)await waitForQueue();
        if(lifetime.signal.aborted)return;
        const {value,done}=await reader.read();
        if(done)return;
        parts.push(value);partsBytes+=value.length;
        while(partsBytes>=frameBytes&&decoded<lines.length)queue.push({data:takeFrame(),line:lines[decoded++]});
        notify();
      }
    }catch(error){if(!lifetime.signal.aborted)producerError=error;}
    finally{producerDone=true;notify();}
  };

  const generator=new Generator({kind:'video'});
  const writer=generator.writable.getWriter();
  const colorSpace=meta.colorSpace&&typeof meta.colorSpace==='object'?meta.colorSpace as VideoColorSpaceInit:undefined;
  const makeFrame=(entry:{data:Uint8Array;line:Line}):VideoFrame=>new VideoFrame(entry.data as unknown as BufferSource,{
    format:format==='i420'?'I420':'RGBA',codedWidth:meta.width,codedHeight:meta.height,
    // Monotonic by construction: the recorder's own delivery clock.
    timestamp:Math.round(entry.line.deliveredAtMs*1000),
    ...(colorSpace&&format==='i420'?{colorSpace}:{}),
    transfer:[entry.data.buffer],
  } as VideoFrameBufferInit);

  const schedule=createRecordedShareSchedule(options);
  let closed=false,ended=false,started=false;
  let delivered=0,lastMs=0,originMs:number|null=null;
  const late:number[]=[];
  let resolveCompletion!:()=>void,rejectCompletion!:(reason:unknown)=>void;
  const completion=new Promise<void>((resolve,reject)=>{resolveCompletion=resolve;rejectCompletion=reject;});
  void completion.catch(()=>{});
  const cleanup=()=>{
    if(closed)return;closed=true;lifetime.abort(new DOMException('Disposed','AbortError'));
    void reader.cancel().catch(()=>{});
    try{generator.stop();}catch{/* Already ended. */}
    for(const entry of queue.splice(0))void entry;
    notify();
    if(target.srcObject&&(target.srcObject as MediaStream).getTracks().includes(generator)){target.pause();target.srcObject=null;target.load();}
  };
  const abortFromOwner=()=>{if(!closed){cleanup();rejectCompletion(signal.reason);}};
  signal.addEventListener('abort',abortFromOwner,{once:true});

  const deliver=(entry:{data:Uint8Array;line:Line})=>{
    // The generator consumes asynchronously; the frame is closed after the write.
    const frame=makeFrame(entry);
    void writer.write(frame).catch(()=>{try{frame.close();}catch{/* Already closed. */}});
    delivered++;lastMs=entry.line.deliveredAtMs;
    if(originMs===null)originMs=entry.line.deliveredAtMs;
  };

  target.pause();target.muted=true;target.playsInline=true;target.srcObject=new MediaStream([generator]);
  void produce();
  // play() has nothing to resolve on until a first frame exists, so the first
  // recorded frame is delivered while preparing. Later frames are scheduled
  // relative to it; the scanner only starts consuming at start().
  while(!queue.length&&!producerDone)await waitForQueue();
  signal.throwIfAborted();
  if(producerError)throw producerError;
  const head=queue.shift();
  if(!head)throw Error('기록 프레임을 디코딩하지 못했습니다.');
  notify();
  schedule.dueMs(head.line.deliveredAtMs/1000);
  deliver(head);late.push(0);

  return {
    meta,
    start() {
      if(closed||ended)return Promise.reject(Error('이미 종료된 재실행 입력입니다.'));
      if(started)return completion;
      started=true;
      void (async()=>{
        try{
          await target.play();
          lifetime.signal.throwIfAborted();
          // Start the clock once the read-ahead is primed, so the first frames
          // are not late by the cost of reading them.
          while(queue.length<Math.min(PREFETCH/2,lines.length-1)&&!producerDone){await waitForQueue();lifetime.signal.throwIfAborted();}
          const t0=performance.now();
          for(;;){
            while(!queue.length&&!producerDone)await waitForQueue();
            lifetime.signal.throwIfAborted();
            if(producerError)throw producerError;
            const entry=queue.shift();
            notify();
            if(!entry)break;
            const wait=schedule.delayMs(entry.line.deliveredAtMs/1000,performance.now()-t0);
            if(wait>0)await sleep(wait,lifetime.signal);
            late.push(schedule.lateMs(entry.line.deliveredAtMs/1000,performance.now()-t0));
            deliver(entry);
          }
          // Give the last frame a callback turn, then end the share like a
          // user pressing stop: the track ends and the scanner drains.
          await sleep(250,lifetime.signal);
          ended=true;
          try{generator.stop();}catch{/* Already ended. */}
          resolveCompletion();
        }catch(error){
          if(closed&&lifetime.signal.aborted)return;
          cleanup();rejectCompletion(error);
        }
      })();
      return completion;
    },
    dispose() {
      signal.removeEventListener('abort',abortFromOwner);
      cleanup();resolveCompletion();
    },
    get inputSeconds() {return originMs===null?0:Math.max(0,(lastMs-originMs)/1000);},
    get durationSeconds() {return (lines[lines.length-1].deliveredAtMs-lines[0].deliveredAtMs)/1000;},
    get ended() {return ended;},
    completion,
    delivery() {
      return Object.freeze({...summarizeDeliveryLateness(late),recordingId,frames:delivered,declaredFrames:lines.length,
        recordingComplete:meta.complete,recordingSha256:meta.sha256});
    },
  };
}
