import type {ScannerInputFrame} from '../src/features/card-scanner/capture/scanner-input-frame';

/** Development input: the frames of a server-side recording (docs/dev-recording.md)
 * in order, one at a time, as the scanner's sequential replay input.
 *
 * This is the deterministic replay mode: every recorded frame reaches the
 * scanner, in order, with its recorded capture time, independent of how busy
 * the machine is. It does not reproduce processing pressure (the scanner is
 * never offered frames faster than it can take them); use the realtime
 * adapter for that, knowing its result depends on machine load. */
/** Per delivered frame: time making the frame (YUV copy and canvas draw) and time
 * the scanner then spent on it before asking for the next one. */
export interface RecordedFrameTiming {readonly time:number;readonly prepMs:number;consumeMs:number}
export interface RecordedShareStream {
  readonly meta:RecordedShareStreamMeta;
  readonly frameCount:number;
  /** Frames delivered to the consumer so far. */
  delivered():number;
  timings():readonly RecordedFrameTiming[];
  /** Frames left out by `skipSimilar`. */
  skipped():number;
  frames():AsyncGenerator<ScannerInputFrame<HTMLCanvasElement>>;
}
export interface RecordedShareStreamMeta {
  readonly id:string;readonly width:number;readonly height:number;
  readonly pixelFormat:'rgba'|'i420'|'nv12';readonly colorSpace:unknown;
  readonly status:'open'|'sealed';readonly frames:number;readonly complete:boolean;
  readonly sha256:string|null;readonly note:string|null;
}
interface Line {readonly seq:number;readonly deliveredAtMs:number}

const THUMB_W=64,THUMB_H=36;
let thumbCanvas:HTMLCanvasElement|undefined;
/** 64x36 luma thumbnail of a canvas. */
function thumbnail(source:HTMLCanvasElement):Uint8Array {
  thumbCanvas??=Object.assign(document.createElement('canvas'),{width:THUMB_W,height:THUMB_H});
  const context=thumbCanvas.getContext('2d',{willReadFrequently:true})!;
  context.imageSmoothingQuality='high';context.drawImage(source,0,0,THUMB_W,THUMB_H);
  const rgba=context.getImageData(0,0,THUMB_W,THUMB_H).data,luma=new Uint8Array(THUMB_W*THUMB_H);
  for(let i=0;i<luma.length;i++)luma[i]=(rgba[i*4]*299+rgba[i*4+1]*587+rgba[i*4+2]*114)/1000;
  return luma;
}
function meanAbsDiff(a:Uint8Array,b:Uint8Array):number {
  let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return sum/a.length;
}

async function getJson<T>(request:typeof fetch,url:string,signal:AbortSignal):Promise<T> {
  const response=await request(url,{signal,cache:'no-store'});
  if(!response.ok)throw Error(`${url}: ${response.status}`);
  return await response.json() as T;
}

export async function openRecordedShareStream(options:{recordingId:string;signal:AbortSignal;base?:string;request?:typeof fetch;
  /** Experiment: deliver only frames whose capture time (seconds) is listed. */
  only?:ReadonlySet<number>;
  /** Experiment: skip a frame whose 64x36 luma thumbnail differs from the last
   * frame that was delivered by at most this mean absolute difference (0..255). */
  skipSimilar?:number}):Promise<RecordedShareStream> {
  const {recordingId,signal}=options,base=options.base??'/__rec',request=options.request??fetch;
  if(typeof VideoFrame==='undefined')throw Error('이 브라우저는 VideoFrame을 지원하지 않습니다.');
  const root=`${base}/${encodeURIComponent(recordingId)}`;
  const meta=await getJson<RecordedShareStreamMeta>(request,root,signal);
  const {lines}=await getJson<{lines:Line[]}>(request,`${root}/lines`,signal);
  if(!lines.length)throw Error('기록에 프레임이 없습니다.');
  let delivered=0;
  const timings:RecordedFrameTiming[]=[];
  let skipped=0;
  // With a frame filter, input ends after the last wanted frame: decoding the
  // skipped tail would only look like a stall to the scanner's watchdog.
  let lastWanted=lines.length-1;
  if(options.only){lastWanted=-1;lines.forEach((line,i)=>{if(options.only!.has(line.deliveredAtMs/1000))lastWanted=i;});}
  async function* frames():AsyncGenerator<ScannerInputFrame<HTMLCanvasElement>> {
    const response=await request(`${root}/frames`,{signal,cache:'no-store'});
    if(!response.ok||!response.body)throw Error('기록 프레임을 열 수 없습니다.');
    const frameBytes=Number(response.headers.get('x-frame-bytes')),format=response.headers.get('x-pixel-format');
    if(!Number.isSafeInteger(frameBytes)||frameBytes<=0||(format!=='i420'&&format!=='rgba'))throw Error('기록 프레임 형식을 알 수 없습니다.');
    const colorSpace=meta.colorSpace&&typeof meta.colorSpace==='object'?meta.colorSpace as VideoColorSpaceInit:undefined;
    const reader=response.body.getReader();
    let parts:Uint8Array[]=[],bytes=0,index=0,lastThumb:Uint8Array|undefined;
    try{
      for(;;){
        const {value,done}=await reader.read();
        if(done)break;
        parts.push(value);bytes+=value.length;
        while(bytes>=frameBytes&&index<lines.length){
          // One copy per frame, never re-merging earlier chunks.
          const data=new Uint8Array(frameBytes);
          let filled=0;
          while(filled<frameBytes){
            const part=parts[0],need=frameBytes-filled;
            if(part.length<=need){data.set(part,filled);filled+=part.length;parts.shift();}
            else{data.set(part.subarray(0,need),filled);parts[0]=part.subarray(need);filled+=need;}
          }
          bytes-=frameBytes;
          const line=lines[index];
          if(options.only&&!options.only.has(line.deliveredAtMs/1000)){index++;continue;}
          const prepStart=performance.now();
          const frame=new VideoFrame(data as unknown as BufferSource,{
            format:format==='i420'?'I420':'RGBA',codedWidth:meta.width,codedHeight:meta.height,
            timestamp:Math.round(line.deliveredAtMs*1000),
            ...(colorSpace&&format==='i420'?{colorSpace}:{}),
          } as VideoFrameBufferInit);
          // A fresh canvas per frame: the scanner may keep a frame while it works.
          const canvas=document.createElement('canvas');canvas.width=meta.width;canvas.height=meta.height;
          const context=canvas.getContext('2d',{alpha:false});
          if(!context){frame.close();throw Error('2D context unavailable');}
          // The browser's own YUV-to-RGB conversion, as for a live share.
          context.drawImage(frame,0,0);
          frame.close();
          if(options.skipSimilar!==undefined){
            const thumb=thumbnail(canvas);
            if(lastThumb&&meanAbsDiff(thumb,lastThumb)<=options.skipSimilar){skipped++;index++;canvas.width=0;canvas.height=0;continue;}
            lastThumb=thumb;
          }
          index++;delivered++;
          const timing:RecordedFrameTiming={time:line.deliveredAtMs/1000,prepMs:performance.now()-prepStart,consumeMs:0};
          timings.push(timing);
          const yieldedAt=performance.now();
          yield {element:canvas,time:line.deliveredAtMs/1000,percent:index/lines.length*100};
          timing.consumeMs=performance.now()-yieldedAt;
        }
        if(index>=lines.length||index>lastWanted)break;
      }
    }finally{await reader.cancel().catch(()=>undefined);}
  }
  return {meta,frameCount:lines.length,delivered:()=>delivered,skipped:()=>skipped,timings:()=>timings,frames};
}
