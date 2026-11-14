/** Reads every frame of a share track off the main thread and keeps the newest few waiting.
 *
 * A `MediaStreamTrackProcessor` read on the main thread only hands over a frame when the main
 * thread gets a turn; while it is busy the processor's own buffer fills and the browser discards
 * frames there, unseen. Here the worker takes each frame as it arrives, keeps at most `limit` of
 * them (the oldest is dropped and counted) and gives the oldest waiting one to the main thread
 * when it asks. Which frames are lost is then this line's counted choice.
 *
 * A frame of a screen capture is a buffer of the capturer's small pool: while a few of them are
 * still open the browser hands out no more and discards what it captures (measured on real shares:
 * the reader got as many frames as were closed, about a third of those captured, and the line never
 * held more than two). So each frame is copied out of the pool as it arrives (`copyTo` into memory
 * and a new frame over that memory, same pixels, time and colour description) and the captured one
 * is closed at once. A frame that cannot be copied is kept as it is and counted.
 *
 * It also reads the list's scrollbar from every frame as it arrives (`bar`: where the scrollbar is,
 * from the last frame the main thread found the card window in) and sends its position at once
 * (`position`), so the progress window follows the scroll while waiting frames are still to be read.
 *
 * Messages in: `start` (the track's readable and the limit), `take` (send the next frame; answered
 * when one is there or the track has ended), `newest` (drop all waiting frames but the newest and
 * count them as passed), `bar`, `stop`. Messages out: `frame`, `position`, `done`. */
import {readScrollGeometry} from '../session/scroll-position';

export type TrackLineRequest=
  |{type:'start';readable:ReadableStream<VideoFrame>;limit:number;/** Copy each frame out of the capture pool (default true). */copy?:boolean}
  |{type:'take'}|{type:'newest'}|{type:'stop'}
  /** The scrollbar's box in frame pixels, or null when the card window was not found, and the thumb's
   * length (share of the bar) read there: a frame whose thumb is another length does not show the list. */
  |{type:'bar';box:{x:number;y:number;width:number;height:number}|null;span?:number};
export interface TrackLineStats {received:number;dropped:number;passed:number;longest:number;
  /** Frames copied out of the capture pool, frames kept as captured because copying failed, and the copying time in all (ms). */
  copied:number;uncopied:number;copyMs:number}
export type TrackLineReply=
  |{type:'frame';frame:VideoFrame;/** Arrival, ms since the epoch. */arrivedAt:number;stats:TrackLineStats}
  |{type:'done';stats:TrackLineStats}
  /** The scrollbar thumb's position (0 to 1) in a frame that just arrived, or null when it was not read. */
  |{type:'position';position:number|null;/** Arrival of the frame, ms since the epoch. */arrivedAt:number};

const scope=self as unknown as {onmessage:((event:MessageEvent<TrackLineRequest>)=>void)|null;postMessage(message:TrackLineReply,transfer?:Transferable[]):void};
const waiting:{frame:VideoFrame;arrivedAt:number}[]=[];
const stats:TrackLineStats={received:0,dropped:0,passed:0,longest:0,copied:0,uncopied:0,copyMs:0};
let copyFrames=true;

/** The same picture in memory of its own, so the captured frame can be closed. */
async function detach(frame:VideoFrame):Promise<VideoFrame> {
  if(!copyFrames||!frame.format){stats.uncopied++;return frame;}
  const began=performance.now();
  try{
    const data=new Uint8Array(frame.allocationSize());
    const layout=await frame.copyTo(data);
    const visible=frame.visibleRect;
    const copy=new VideoFrame(data,{format:frame.format,codedWidth:visible?.width??frame.codedWidth,codedHeight:visible?.height??frame.codedHeight,
      timestamp:frame.timestamp,duration:frame.duration??undefined,layout,displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,
      colorSpace:frame.colorSpace.toJSON()});
    frame.close();stats.copied++;stats.copyMs+=performance.now()-began;
    return copy;
  }catch{stats.uncopied++;return frame;}
}
let limit=12,asked=false,ended=false,stopped=false,reader:ReadableStreamDefaultReader<VideoFrame>|undefined;
let bar:{x:number;y:number;width:number;height:number}|null=null,barSpan:number|undefined,lastPosition:number|null|undefined;
const STRIP_WIDTH=16,STRIP_HEIGHT=942;
let strip:OffscreenCanvasRenderingContext2D|null|undefined;
/** The thumb position in this frame, sent when it changed (the same strip the main thread reads). */
function sendPosition(frame:VideoFrame,arrivedAt:number):void {
  if(!bar)return;
  try{
    strip??=new OffscreenCanvas(STRIP_WIDTH,STRIP_HEIGHT).getContext('2d',{willReadFrequently:true});
    if(!strip)return;
    strip.drawImage(frame,bar.x,bar.y,bar.width,bar.height,0,0,STRIP_WIDTH,STRIP_HEIGHT);
    const geometry=readScrollGeometry(strip.getImageData(0,0,STRIP_WIDTH,STRIP_HEIGHT).data,STRIP_WIDTH,STRIP_HEIGHT);
    // Something else over the list (another screen, a notice) can read as a thumb of another length.
    if(geometry&&barSpan!==undefined&&Math.abs(geometry.pageSpan-barSpan)>barSpan*.15)return;
    const position=geometry?.position??null;
    if(position===lastPosition)return;
    lastPosition=position;
    scope.postMessage({type:'position',position,arrivedAt});
  }catch{/* The frame cannot be drawn here; the main thread still reads the scrollbar. */}
}

function answer():void {
  if(!asked||stopped)return;
  const next=waiting.shift();
  if(next){asked=false;scope.postMessage({type:'frame',frame:next.frame,arrivedAt:next.arrivedAt,stats:{...stats}},[next.frame as unknown as Transferable]);}
  else if(ended){asked=false;scope.postMessage({type:'done',stats:{...stats}});}
}

scope.onmessage=event=>{
  const message=event.data;
  if(message.type==='start'){
    limit=Math.max(1,Math.round(message.limit));copyFrames=message.copy!==false;
    reader=message.readable.getReader();
    void (async()=>{
      try{
        for(;;){
          const next=await reader!.read();
          if(next.done)break;
          if(stopped){next.value.close();continue;}
          stats.received++;
          const arrivedAt=performance.timeOrigin+performance.now();
          sendPosition(next.value,arrivedAt);
          const frame=await detach(next.value);
          if(stopped){frame.close();continue;}
          waiting.push({frame,arrivedAt});
          while(waiting.length>limit){waiting.shift()!.frame.close();stats.dropped++;}
          stats.longest=Math.max(stats.longest,waiting.length);
          answer();
        }
      }catch{/* The track ended or reading was cancelled. */}
      finally{ended=true;answer();}
    })();
  }else if(message.type==='take'){asked=true;answer();}
  else if(message.type==='bar'){bar=message.box;barSpan=message.span;lastPosition=undefined;}
  else if(message.type==='newest'){
    while(waiting.length>1){waiting.shift()!.frame.close();stats.passed++;}
  }else if(message.type==='stop'){
    stopped=true;
    for(const item of waiting.splice(0))item.frame.close();
    void reader?.cancel().catch(()=>{});
  }
};
