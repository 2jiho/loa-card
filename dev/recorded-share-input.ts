import type {LiveVideoInput} from './live-video-input';
import type {RecordedShareDeliveryStats,RecordedShareScheduleOptions} from './recorded-share-schedule';
import type {ShareWorkerReply,ShareWorkerRequest} from './recorded-share-worker';

/** Development adapter: re-executes a server-side recording (docs/dev-recording.md)
 * through the real live path.
 *
 * A worker decodes the lossless recording stream and writes each frame, at its
 * recorded time, to a MediaStreamTrackGenerator's writable stream (transferred to
 * the worker). The scanner gets a real MediaStream track whose frames carry the
 * original source bytes and color description, and the page's main thread does no
 * per-frame work for the delivery, as for a real share. Nothing is recolored on the
 * way: the browser converts the frames exactly as it does for a real share.
 *
 * Reproduced: the frames the recorder received (pixels, order, intervals). Not
 * reproduced: the OS capture clock, the original machine's speed, and frames the
 * recorder dropped (the recording says how many). Delivery lateness is measured in
 * the worker and reported; a replay that fell behind its schedule says so.
 *
 * The page must be visible. A hidden or covered page is throttled by the browser
 * (rAF about once a second), which starves the video pipeline whatever the worker
 * does; scripts/run-recording-replay.mjs runs the page in a headless browser. */
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
  /** Frames in the recording, before any early end (`untilSeconds`). */
  readonly recordedFrames:number;
}

type Generator=MediaStreamTrack&{writable:WritableStream<VideoFrame>;stop():void};
type GeneratorConstructor=new(init:{kind:'video'})=>Generator;

async function getJson<T>(request:typeof fetch,url:string,signal:AbortSignal):Promise<T> {
  const response=await request(url,{signal,cache:'no-store'});
  if(!response.ok)throw Error(`${url}: ${response.status}`);
  return await response.json() as T;
}

export async function prepareRecordedShareInput(options:{
  recordingId:string;target:HTMLVideoElement;signal:AbortSignal;base?:string;request?:typeof fetch;
  /** End the share after this recorded time (seconds). */
  untilSeconds?:number;
}&RecordedShareScheduleOptions):Promise<RecordedShareInput> {
  const {target,signal,recordingId}=options,base=options.base??'/__rec',request=options.request??fetch;
  signal.throwIfAborted();
  if(target.srcObject)throw Error('미리보기 영상이 이미 다른 입력에 연결되어 있습니다.');
  const Generator=(globalThis as {MediaStreamTrackGenerator?:GeneratorConstructor}).MediaStreamTrackGenerator;
  if(!Generator||typeof VideoFrame==='undefined')throw Error('이 브라우저는 MediaStreamTrackGenerator를 지원하지 않습니다.');
  const meta=await getJson<RecordedShareMeta>(request,`${base}/${encodeURIComponent(recordingId)}`,signal);

  const generator=new Generator({kind:'video'});
  const worker=new Worker(new URL('./recorded-share-worker.ts',import.meta.url),{type:'module'});
  let resolveReady!:(value:{lines:number;durationSeconds:number})=>void,rejectReady!:(reason:unknown)=>void;
  const ready=new Promise<{lines:number;durationSeconds:number}>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  let resolveCompletion!:()=>void,rejectCompletion!:(reason:unknown)=>void;
  const completion=new Promise<void>((resolve,reject)=>{resolveCompletion=resolve;rejectCompletion=reject;});
  void completion.catch(()=>{});
  let closed=false,ended=false,started=false,declaredFrames=0,recordedFrames=0,duration=0;
  let workerDelivery:(RecordedShareDeliveryStats&{frames:number})|undefined,inputSeconds=0;

  const cleanup=()=>{
    if(closed)return;closed=true;
    try{worker.postMessage({type:'stop'} satisfies ShareWorkerRequest);}catch{/* Worker gone. */}
    worker.terminate();
    try{generator.stop();}catch{/* Already ended. */}
    if(target.srcObject&&(target.srcObject as MediaStream).getTracks().includes(generator)){target.pause();target.srcObject=null;target.load();}
  };
  const abortFromOwner=()=>{if(!closed){cleanup();rejectCompletion(signal.reason);rejectReady(signal.reason);}};
  signal.addEventListener('abort',abortFromOwner,{once:true});
  worker.onmessage=(event:MessageEvent<ShareWorkerReply>)=>{
    const reply=event.data;
    if(reply.type==='ready'){declaredFrames=reply.lines;recordedFrames=reply.recordedLines;duration=reply.durationSeconds;resolveReady({lines:reply.lines,durationSeconds:reply.durationSeconds});return;}
    if(reply.type==='error'){const error=Error(reply.message);rejectReady(error);if(!closed){cleanup();rejectCompletion(error);}return;}
    // done: give the last frame a callback turn, then end the share like a user pressing stop.
    workerDelivery=reply.delivery;inputSeconds=reply.inputSeconds;
    setTimeout(()=>{if(closed)return;ended=true;try{generator.stop();}catch{/* Already ended. */}resolveCompletion();},250);
  };
  worker.onerror=event=>{const error=Error(event.message||'재생 워커 오류');rejectReady(error);if(!closed){cleanup();rejectCompletion(error);}};

  target.pause();target.muted=true;target.playsInline=true;target.srcObject=new MediaStream([generator]);
  const init:ShareWorkerRequest={type:'init',base,recordingId,writable:generator.writable,...(options.untilSeconds!==undefined?{untilSeconds:options.untilSeconds}:{})};
  worker.postMessage(init,[generator.writable as unknown as Transferable]);
  await ready;
  signal.throwIfAborted();

  return {
    meta,
    start() {
      if(closed||ended)return Promise.reject(Error('이미 종료된 재실행 입력입니다.'));
      if(started)return completion;
      started=true;
      void (async()=>{
        try{
          // play() resolves once the first frame (delivered while preparing) is shown.
          await target.play();
          if(closed)return;
          worker.postMessage({type:'start'} satisfies ShareWorkerRequest);
        }catch(error){if(!closed){cleanup();rejectCompletion(error);}}
      })();
      return completion;
    },
    dispose() {
      signal.removeEventListener('abort',abortFromOwner);
      cleanup();resolveCompletion();
    },
    get inputSeconds() {return inputSeconds;},
    get durationSeconds() {return duration;},
    get ended() {return ended;},
    get recordedFrames() {return recordedFrames;},
    completion,
    delivery() {
      const delivery=workerDelivery??{delivered:0,meanLateMs:0,maxLateMs:0,lateOver33Ms:0,frames:0};
      return Object.freeze({...delivery,recordingId,frames:delivery.frames,declaredFrames,
        recordingComplete:meta.complete,recordingSha256:meta.sha256});
    },
  };
}
