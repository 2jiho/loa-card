import type {RecorderWorkerReply,RecorderWorkerRequest} from './share-recorder-worker';

/** Development/test only. Records a live shared-screen stream to the local
 * recording server, but only around the times the scanner saw the card window
 * (docs/dev-recording.md).
 *
 * The track's frame stream is handed to a worker, which reads every delivered
 * frame itself (a busy main thread cannot starve it), keeps a short ring and
 * uploads the ring plus the next few seconds whenever the scanner calls
 * `located()`. Idle time, other windows and the like therefore cost no disk,
 * while every delivered frame of a card-window span is kept, not just the ones
 * the scanner processed.
 *
 * This never competes with the scanner: the main thread does nothing per
 * frame; when the worker is behind, frames are dropped and counted instead of
 * queued, so recording cannot slow down or alter a scan. Dropped frames make
 * the recording incomplete and say so in its seal note. */
export interface ShareRecorderStats {
  readonly id:string;
  readonly read:number;
  readonly recorded:number;
  readonly dropped:number;
  readonly located:number;
  readonly failure:string|null;
}
export interface ShareRecorder {
  readonly id:string;
  /** The scanner located the card window in a frame it just worked on. */
  located():void;
  stats():ShareRecorderStats;
  /** Stops reading and seals the server recording. Safe to call twice. */
  stop():Promise<unknown>;
}

type TrackProcessorConstructor=new(init:{track:MediaStreamTrack;maxBufferSize?:number})=>{readable:ReadableStream<VideoFrame>};

export function newRecordingId(now=new Date(),random=Math.random):string {
  return `share-${now.toISOString().replace(/[-:.]/g,'').replace('T','-').replace('Z','')}-${Math.floor(random()*0x10000).toString(16).padStart(4,'0')}`;
}

export function startShareRecorder(stream:MediaStream,options:{base?:string;id?:string;environment?:unknown;onFailure?:(message:string)=>void}={}):ShareRecorder|null {
  const Processor=(globalThis as {MediaStreamTrackProcessor?:TrackProcessorConstructor}).MediaStreamTrackProcessor;
  const source=stream.getVideoTracks()[0];
  if(!Processor||!source||source.readyState!=='live')return null;
  const id=options.id??newRecordingId();
  const track=source.clone();
  const worker=new Worker(new URL('./share-recorder-worker.ts',import.meta.url),{type:'module'});
  let latest:ShareRecorderStats={id,read:0,recorded:0,dropped:0,located:0,failure:null},stopped=false;
  let resolveSealed!:(meta:unknown)=>void;
  const sealed=new Promise<unknown>(resolve=>{resolveSealed=resolve;});
  worker.onmessage=(event:MessageEvent<RecorderWorkerReply>)=>{
    const reply=event.data;
    if(reply.type==='stats')latest=Object.freeze({id,read:reply.read,recorded:reply.recorded,dropped:reply.dropped,located:reply.located,failure:reply.failure});
    else if(reply.type==='error')options.onFailure?.(reply.message);
    else if(reply.type==='sealed')resolveSealed(reply.meta);
  };
  worker.onerror=event=>{options.onFailure?.(event.message||'recorder worker error');resolveSealed(null);};
  // The stream is read in the worker; the main thread only creates it.
  const readable=new Processor({track,maxBufferSize:4}).readable;
  const start:RecorderWorkerRequest={type:'start',base:options.base??'/__rec',id,environment:options.environment??null,readable};
  worker.postMessage(start,[readable as unknown as Transferable]);
  const finish=async()=>{
    if(stopped)return sealed;
    stopped=true;
    source.removeEventListener('ended',finishOnEnd);clearInterval(poll);
    // Release the capture first. A cloned track keeps the screen capture (and
    // the browser's "sharing" indicator) alive for as long as it is live, so it
    // must never outlive the share the user stopped, nor wait for the upload.
    track.stop();
    const seal:RecorderWorkerRequest={type:'seal'};
    worker.postMessage(seal);
    const meta=await Promise.race([sealed,new Promise<null>(resolve=>setTimeout(()=>resolve(null),30_000))]);
    worker.terminate();
    return meta;
  };
  // The user stopped sharing: let go of the capture now, even while the scanner
  // is still finishing its work. The browser's own stop button fires `ended`,
  // but MediaStreamTrack.stop() (what the app calls) does not, so the state is
  // also polled.
  const finishOnEnd=()=>{void finish();};
  source.addEventListener('ended',finishOnEnd);
  const poll=setInterval(()=>{if(source.readyState==='ended')finishOnEnd();},300);
  return {id,stats:()=>latest,stop:finish,located:()=>{
    if(stopped)return;
    const message:RecorderWorkerRequest={type:'located'};
    worker.postMessage(message);
  }};
}
