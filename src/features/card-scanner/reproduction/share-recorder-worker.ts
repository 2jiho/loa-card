/** Development/test only. Reads the frames of a shared screen, keeps the ones
 * around the times the scanner saw the card window, in their native layout, and
 * uploads them to the local recording server. See docs/dev-recording.md.
 *
 * The worker pulls frames from the track's stream itself, so a busy main thread
 * (the scanner) cannot starve the recorder. Every delivered frame is copied out
 * (cheap) into a short in-memory ring. When the scanner reports that it located
 * the card window, the ring (the scanner reports a little late) and the frames
 * of the next few seconds are uploaded; frames far from any card window are
 * never stored. The recording therefore holds ALL delivered frames of those
 * spans, not only the ones the scanner happened to process, so a faster or
 * different scanner can be replayed against it.
 *
 * Native I420/NV12 frames are copied as they are (no color conversion, 1.5
 * bytes per pixel), which is both the cheapest path and what lets a replay
 * hand the scanner the very same source bytes. Any other layout falls back to
 * RGBA. Uploads overlap (a few in flight) but carry a sequence number, so the
 * server still writes them in order. */
export type RecorderWorkerRequest=
  |{type:'start';base:string;id:string;environment:unknown;readable:ReadableStream<VideoFrame>}
  /** The scanner located the card window in a frame it just worked on. */
  |{type:'located'}
  |{type:'seal'};
export type RecorderWorkerReply=
  |{type:'stats';read:number;recorded:number;dropped:number;located:number;failure:string|null}
  |{type:'sealed';meta:unknown}
  |{type:'error';message:string};

export const PRE_ROLL_MS=2000,POST_ROLL_MS=2000,RING_BYTES=320_000_000,MAX_PENDING=60,MAX_UPLOADS=8;

interface Entry {body:Uint8Array<ArrayBuffer>|Uint8ClampedArray<ArrayBuffer>;deliveredAtMs:number;mediaTimeMs:number|null;convertMs:number}

let base='',id='',environment:unknown=null;
let failed=false,failure:string|null=null,layoutKnown=false,stopping=false;
let width=0,height=0,pixelFormat:'rgba'|'i420'|'nv12'='rgba',colorSpace:unknown=null,frameBytes=0;
let canvas:OffscreenCanvas|undefined,context:OffscreenCanvasRenderingContext2D|null=null;
let nextSeq=0,openUntilMs=-Infinity,active=0,t0=0;
let read=0,recorded=0,dropped=0,located=0,convertTotal=0,sendTotal=0;
let reader:ReadableStreamDefaultReader<VideoFrame>|undefined,loop:Promise<void>=Promise.resolve();
const ring:Entry[]=[],pending:Entry[]=[],uploads=new Set<Promise<void>>();
let startPromise:Promise<unknown>|undefined;
const post=(reply:RecorderWorkerReply)=>self.postMessage(reply);
const fail=(error:unknown)=>{
  failed=true;failure??=error instanceof Error?error.message:String(error);
  post({type:'error',message:failure});
};
const reportStats=()=>post({type:'stats',read,recorded,dropped,located,failure});
const dropReasons:Record<string,number>={};
/** Count a dropped frame; the first one of each kind is logged so a silent loss is visible. */
const drop=(reason:string)=>{
  dropped++;
  if(!dropReasons[reason])console.warn('[share-recorder] dropping frames:',reason);
  dropReasons[reason]=(dropReasons[reason]??0)+1;
};

async function request(path:string,init:RequestInit):Promise<Response> {
  const response=await fetch(`${base}/${encodeURIComponent(id)}${path}`,init);
  if(!response.ok)throw Error(`recording server ${response.status}: ${(await response.text()).slice(0,200)}`);
  return response;
}

function colorSpaceOf(frame:VideoFrame):unknown {
  const space=frame.colorSpace;
  return space?{primaries:space.primaries,transfer:space.transfer,matrix:space.matrix,fullRange:space.fullRange}:null;
}

function decideLayout(frame:VideoFrame):void {
  // The recorded size is even, as the encoder needs; an odd edge is cropped.
  width=frame.displayWidth-frame.displayWidth%2;height=frame.displayHeight-frame.displayHeight%2;
  const native=frame.format==='I420'||frame.format==='NV12';
  const nativeBytes=width*height*3/2;
  // Native only when the tightly packed copy has exactly the expected size.
  const size=native?frame.allocationSize({rect:{x:0,y:0,width,height}}):0;
  pixelFormat=native&&size===nativeBytes?(frame.format==='NV12'?'nv12':'i420'):'rgba';
  frameBytes=pixelFormat==='rgba'?width*height*4:nativeBytes;
  if(pixelFormat==='rgba'){
    canvas=new OffscreenCanvas(width,height);
    context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
    if(!context)throw Error('2D context unavailable');
  }
  colorSpace=colorSpaceOf(frame);layoutKnown=true;
}

function ensureStarted():Promise<unknown> {
  return startPromise??=request('/start',{method:'PUT',body:JSON.stringify({width,height,pixelFormat,colorSpace,environment})});
}

async function copyOut(frame:VideoFrame,deliveredAtMs:number):Promise<Entry|null> {
  if(frame.displayWidth-frame.displayWidth%2!==width||frame.displayHeight-frame.displayHeight%2!==height){drop('frame size changed');return null;}
  // A recording has one pixel layout. A frame of another layout is dropped and counted, never converted.
  if(pixelFormat!=='rgba'&&frame.format!==(pixelFormat==='nv12'?'NV12':'I420')){drop('frame layout changed');return null;}
  const started=performance.now();
  let body:Entry['body'];
  if(pixelFormat==='rgba'){
    context!.drawImage(frame,0,0);
    body=context!.getImageData(0,0,width,height).data;
  }else{
    body=new Uint8Array(frameBytes);
    await frame.copyTo(body,{rect:{x:0,y:0,width,height}});
  }
  return {body,deliveredAtMs,mediaTimeMs:Number.isFinite(frame.timestamp)?frame.timestamp/1000:null,convertMs:performance.now()-started};
}

function pump():void {
  while(!failed&&pending.length&&active<MAX_UPLOADS){
    const entry=pending.shift()!,seq=nextSeq++;
    active++;
    const task:Promise<void>=(async()=>{
      await ensureStarted();
      const sendStarted=performance.now();
      const response=await request('/frame',{method:'POST',body:entry.body,headers:{
        'x-delivered-at-ms':String(entry.deliveredAtMs),'x-seq':String(seq),
        ...(entry.mediaTimeMs!==null?{'x-media-time-ms':String(entry.mediaTimeMs)}:{})}});
      await response.json();
      recorded++;convertTotal+=entry.convertMs;sendTotal+=performance.now()-sendStarted;
    })().catch(fail).finally(()=>{active--;uploads.delete(task);pump();});
    uploads.add(task);
  }
}

function enqueue(entry:Entry):void {
  if(pending.length>=MAX_PENDING){drop('upload backlog');return;}
  pending.push(entry);pump();
}

async function handleFrame(frame:VideoFrame,deliveredAtMs:number):Promise<void> {
  try{
    if(failed){drop('recording failed earlier');return;}
    // Until the server has been told the size, a different size (a window that
    // was still resizing when the share began) just restarts the layout; frames
    // of the old size are discarded with it.
    const sizeChanged=layoutKnown&&(frame.displayWidth-frame.displayWidth%2!==width||frame.displayHeight-frame.displayHeight%2!==height);
    if(!layoutKnown||(sizeChanged&&!startPromise)){ring.length=0;pending.length=0;decideLayout(frame);}
    const entry=await copyOut(frame,deliveredAtMs);
    if(!entry)return;
    if(deliveredAtMs<=openUntilMs)enqueue(entry);
    else{
      ring.push(entry);
      const limit=Math.max(2,Math.floor(RING_BYTES/Math.max(1,frameBytes)));
      while(ring.length>limit)ring.shift();
    }
  }catch(error){fail(error);}
  finally{frame.close();}
}

function handleLocated():void {
  located++;
  const atMs=performance.now()-t0;
  openUntilMs=Math.max(openUntilMs,atMs+POST_ROLL_MS);
  // The scanner reports after it has worked on the frame, so the frames it
  // looked at are already in the ring: upload everything not older than the pre-roll.
  const from=atMs-PRE_ROLL_MS;
  while(ring.length){
    const entry=ring.shift()!;
    if(entry.deliveredAtMs>=from)enqueue(entry);
  }
}

async function readLoop(readable:ReadableStream<VideoFrame>):Promise<void> {
  reader=readable.getReader();
  let lastReport=0;
  try{
    for(;;){
      const {value:frame,done}=await reader.read();
      if(done||!frame)break;
      read++;
      if(stopping){frame.close();continue;}
      await handleFrame(frame,performance.now()-t0);
      const now=performance.now();
      if(now-lastReport>1000){lastReport=now;reportStats();}
    }
  }catch(error){if(!stopping)fail(error);}
}

async function seal():Promise<void> {
  stopping=true;
  try{await reader?.cancel();}catch{/* Already closed. */}
  await loop;
  try{
    // Whatever is still waiting to upload belongs to a card-window span.
    while(pending.length||uploads.size){pump();await Promise.all([...uploads]);}
    reportStats();
    if(!startPromise){post({type:'sealed',meta:null});return;}
    const note=`read ${read} frames, scanner located the card window ${located} times; recorded ${recorded}, dropped ${dropped}${dropped?` (${Object.entries(dropReasons).map(([k,v])=>`${k} ${v}`).join(', ')})`:''}; convert ${recorded?(convertTotal/recorded).toFixed(1):0}ms send ${recorded?(sendTotal/recorded).toFixed(1):0}ms per frame${failure?`; ${failure}`:''}`;
    const response=await request('/seal',{method:'POST',body:JSON.stringify({note})});
    post({type:'sealed',meta:await response.json()});
  }catch(error){fail(error);post({type:'sealed',meta:null});}
}

self.onmessage=(event:MessageEvent<RecorderWorkerRequest>)=>{
  const message=event.data;
  if(message.type==='start'){
    base=message.base;id=message.id;environment=message.environment;t0=performance.now();
    loop=readLoop(message.readable);return;
  }
  if(message.type==='located'){handleLocated();return;}
  void seal();
};
