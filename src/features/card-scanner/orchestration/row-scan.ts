import type {TrackLineReply,TrackLineRequest,TrackLineStats} from '../capture/track-line-worker';
import type {ScannedCard} from '../recognition/recognizer-types';
import {describeListGuidance,listGuidanceMap,holdNewCardTargets,surelyShownRows} from '../session/list-guidance';
import type {ListGuidance,ListGuidanceMap} from '../session/list-guidance';
import {createAcquisitionClient} from '../acquisition/acquisition-client';
import {createVisualClient} from '../recognition/visual-client';
import {createRecognizer} from '../recognition/recognizer';
import {readScrollGeometry} from '../session/scroll-position';
import {addDetectorProfile} from '../acquisition/detector-profile';
import {COLUMNS,EMPTY_REASON,GRID_ROWS,createRowReadSession,createThumbClock} from './row-session';
import {createRowEvidence} from '../session/row-evidence';
import type {RowEvidence} from '../session/row-evidence';
import type {RowReadNames,RowReadResult,RowReadVisual} from './row-session';

/** The row-centred scan of a shared screen (docs/scanner-pipeline.md): the app's scan since v0.3.0,
 * and the same code a recording replay runs (dev/recording.ts).
 *
 * Frames are taken from the share's track itself (MediaStreamTrackProcessor, in
 * capture/track-line-worker.ts), not from the video element: the element shows at most one frame
 * per screen refresh, so of two frames a few ms apart it never presents one, and a row that was on
 * screen for that one frame is lost. Each frame waits in a short line (12 by default) and the loop
 * reads them in order, taking the next frame while the one before is still being read; a frame the
 * line has no room for is dropped and counted (a missed frame). Frames captured before the share
 * ended are read to the end; nothing is recovered from frames that were dropped.
 *
 * Every frame: acquisition (worker), scrollbar position, the row reading (row-session.ts), and the
 * storage header (read early, and again at the end). Snapshots go to the caller about every 0.2 s
 * while frames are taken. Completion is decided by the caller from the snapshot
 * (row-scanner-state.ts), never here. Real-time runs differ from run to run with the machine's
 * load. */
export interface RowLiveResult extends RowReadResult {
  readonly live:{
    /** Seconds from the first frame taken to the end of the share. */
    readonly shareSeconds:number;
    /** Frames the source gave while the loop was watching (the track's frames, or with the video
     * source the frames the element presented) / frames this loop read. */
    readonly presentedFrames:number;readonly readFrames:number;
    /** Where the frames came from, and with the track source the frames the browser discarded
     * before this loop took them (absent when the browser does not count them). */
    /** Worker line: frames copied out of the capture pool, frames kept as captured, and the mean copying time. */
    readonly lineCopy?:{readonly copied:number;readonly uncopied:number;readonly meanMs:number};
    /** The growth points of the storage header, when read. */
    readonly growthPoints:{readonly current:number;readonly maximum:number|null}|null;
    /** The displayed total: as first read (with the frame time), as read again from the last frame, and the readings made and failed. */
    readonly header:{readonly expected:number|null;readonly capacity:number|null;readonly finalExpected:number|null;readonly firstAtSeconds:number|null;readonly reads:number;readonly failures:number};
    /** After everything was read: what the list table would ask to be shown again (session/list-guidance.ts) and the same as lines. */
    readonly guidance:ListGuidance&{readonly totalRows:number;readonly asks:readonly string[];readonly notes:readonly string[]};
    /** The browser's own counts for the track reader (Chrome): frames it saw in all. */
    readonly sourceTotal?:number;
    /** The share track's frame rate setting and the browser's delivered/discarded/total counts for it. */
    readonly track?:{readonly frameRate:number|null;readonly stats:{readonly deliveredFrames:number;readonly discardedFrames:number;readonly totalFrames:number}|null};
    readonly source:'track'|'video';/** Where the track is read: a worker that keeps the line, or the main thread. */readonly reader?:'worker'|'main';
    /** The longest the main thread went without a turn, and how often for more than 100 ms. */
    readonly mainThread:{readonly maxGapMs:number;readonly gapsOver100Ms:number;
      /** Screen rows sent at once by the line worker: from the frame's arrival there to the main thread (ms). */
      readonly positionDelay?:{readonly count:number;readonly median:number;readonly p95:number;readonly max:number}};readonly sourceDiscarded?:number;
    /** Per frame read: milliseconds from taking the frame to the end of its reading. */
    readonly frameMs:{readonly median:number;readonly p95:number;readonly max:number};
    /** Where a frame's time goes, median and 95th percentile ms per frame read: drawing the video
     * to a canvas, freezing it for the worker, the worker's window detection and cropping, the rest
     * of the round trip (transfer and waiting), painting the crops to canvases, reading the thumb,
     * and the row reading itself. */
    /** Per frame read, the mean number of slots the acquisition found unchanged, found moved by a
     * row, and inspected anew. */
    readonly slots:{readonly exact:number;readonly moved:number;readonly inspected:number};
    /** Window detection: the detector's own stage totals (calls, calls answered from its cache,
     * ms), and the frames whose detection took over 100 ms with how many of them found the window
     * and their capture times (at most 40). */
    readonly detection:{readonly stages:Readonly<Record<string,{readonly calls:number;readonly cached:number;readonly ms:number}>>;
      readonly slowFrames:number;readonly slowLocated:number;readonly slowTimes:readonly number[];readonly unlocatedFrames:number};
    /** Every frame read (at most 800): capture time, ms from taking it to handing it to the
     * reading, whether the window was found, usable slots, and the thumb row. */
    readonly frameLog:readonly (readonly [time:number,ms:number,located:0|1,usable:number,thumbRow:number|null])[];
    readonly stages:Readonly<Record<'draw'|'freeze'|'detect'|'crop'|'transfer'|'materialize'|'thumb'|'read',{readonly median:number;readonly p95:number}>>;
    /** Cards named so far and cards with both values, once per second of the share. */
    readonly timeline:readonly {readonly t:number;readonly cards:number;readonly complete:number}[];
    /** Cards named and cards with both values when the share ended. */
    /** `confirmed` (with evidence only): cards whose values the scanner's merge confirms, counted as the scanner counts its "read" cards. */
    readonly atShareEnd:{readonly cards:number;readonly complete:number;readonly confirmed?:number};
    /** The line of waiting frames: its limit, the most that waited at once, frames dropped from it,
     * frames passed over while no card window was found,
     * ms a frame waited before it was taken, ms after the share ended until the frames captured
     * before the end were all read, and the cards then. */
    readonly line:{readonly limit:number;readonly longest:number;readonly dropped:number;readonly passedWithoutWindow:number;readonly waitMs:{readonly median:number;readonly p95:number;readonly max:number};
      readonly catchUpMs:number;readonly afterFrames:{readonly cards:number;readonly complete:number}};
    /** The same once the name reading in flight at the end of the share had finished. */
    readonly afterNames:{readonly cards:number;readonly complete:number;readonly confirmed?:number};
    /** With evidence: the scanner's end-of-scan zero check of kept crops, run after the name
     * readings finished: cards that needed it, cards it confirmed as zero, crops re-read, the
     * time it took and the confirmed cards then. It is not part of the share-end count. */
    readonly afterZeroCheck?:{readonly checked:number;readonly resolved:readonly string[];readonly previewReads:number;readonly withoutPreview:number;readonly ms:number;readonly confirmed:number};
    /** With evidence: the zero check's runs while the share went on (about one a second): runs,
     * their time in all, crops re-read and the cards confirmed as zero (a card may appear again
     * when a later crop cancelled its result). Their cards are part of the share-end count. */
    readonly zeroDuringShare?:{readonly runs:number;readonly ms:number;readonly previewReads:number;readonly resolved:readonly string[]};
    /** With evidence: the merged cards after everything was read. */
    readonly evidence?:ReturnType<RowEvidence['summary']>;
  };
}

function trackStats(track:MediaStreamTrack):{deliveredFrames:number;discardedFrames:number;totalFrames:number}|null {
  const stats=(track as MediaStreamTrack&{stats?:{deliveredFrames?:number;discardedFrames?:number;totalFrames?:number}}).stats;
  return stats&&typeof stats.totalFrames==='number'?{deliveredFrames:stats.deliveredFrames??0,discardedFrames:stats.discardedFrames??0,totalFrames:stats.totalFrames}:null;
}

type FrameCallbackVideo=HTMLVideoElement&{requestVideoFrameCallback(callback:(now:number,metadata:{mediaTime:number;presentedFrames:number})=>void):number};

/** What the row-centred scan knows at one moment, for a caller that shows it. */
export interface RowScanSnapshot {
  /** `capture`: the share goes on. `reading`: the share ended, frames and names taken before the end are still read.
   * `verifying`: the final zero check. `done`: everything was read. */
  readonly phase:'capture'|'reading'|'verifying'|'done';
  readonly frames:number;readonly locatedFrames:number;
  /** Work finished so far (frames read, name and count readings, header and zero-check readings):
   * it grows while the scan makes progress, also after the share when no frame arrives. */
  readonly workDone:number;
  /** Whether the last frame read showed the card window. */
  readonly located:boolean;
  /** Frames waiting to be read and frames dropped from the line. */
  readonly waitingFrames:number;readonly droppedFrames:number;
  /** Crops waiting for a name or a full count reading. */
  readonly waitingReads:number;
  /** The merged cards (with the evidence merge) and how many are confirmed. */
  readonly cards:readonly ScannedCard[];readonly confirmed:number;
  /** The confirmed count to show: until the scan is done a dip shorter than COUNT_DIP_HOLD_MS (a
   * newer view of a confirmed card waiting to be read) is not shown. Display only: completion and
   * the automatic end of the share use `confirmed`. */
  readonly displayConfirmed?:number;
  /** The displayed total and capacity of the storage header ("398 / 450") as first read, and the
   * total read again from the last frame after everything else (null until then, or when unread). */
  readonly expected:number|null;readonly capacity:number|null;readonly finalExpected:number|null;
  /** The total read again while every card of it was confirmed (during the share); null otherwise. */
  readonly freshExpected:number|null;
  /** The growth points of the storage header, when read. */
  readonly growthPoints:{readonly current:number;readonly maximum:number|null}|null;
  /** Cells seen but not named (in anchored rows and in rows without a place). */
  readonly unidentifiedCells:number;
  /** The interface's card strip: cards as first read (session/row-evidence.ts, activity()). */
  readonly activity:readonly {readonly id:number;readonly image:string;readonly name:string;readonly status:'read'|'review'}[];
  readonly guidance:{readonly asks:readonly string[];readonly notes:readonly string[];
    /** The same rows on a picture of the list, with the rows on screen now (session/list-guidance.ts). */
    readonly map?:ListGuidanceMap};
}

/** How often the scan state is published while frames are taken (the progress map follows the scroll). */
const SNAPSHOT_MS=200;
/** After the share each snapshot re-projects every card; the map no longer follows a scroll. */
const READING_SNAPSHOT_MS=400;
/** Until the scan is done, a card highlight is drawn once it has lasted this long (holdNewCardTargets). */
const CARD_TARGET_HOLD_MS=1500;
/** Until the scan is done, a dip of the shown confirmed count is shown once it has lasted this long
 * (a newer view of a confirmed card can take two seconds to be read on a 5120x2880 share). */
const COUNT_DIP_HOLD_MS=3000;
export async function runRowScan(options:{
  /** The share: the caller has already put its stream on `target`. `start` resolves when the share ends. */
  input:{start():Promise<void>;dispose():void};
  /** Live input: called once the readers are loaded and frames are being taken. */onReady?:()=>void;
  /** Called for each frame the card window was found in (the development recorder keeps those spans). */onLocated?:()=>void;
  /** Called about once a second with the cards named and confirmed so far, and what to show again (lines for a person). */onCounts?:(counts:{cards:number;complete:number;confirmed?:number},guidance:{readonly asks:readonly string[];readonly notes:readonly string[]})=>void;
  /** Keep the captured frames in the line as they are instead of copying them out of the capture pool (as before); for comparison. */heldFrames?:boolean;
  /** Read the track on the main thread instead of in the worker that keeps the line (as before); for comparison. */mainReader?:boolean;
  /** Called a few times a second and at each change of phase with what is known now. */
  onSnapshot?:(snapshot:RowScanSnapshot)=>void;
  /** The list row at the top of the screen, as soon as a frame shows it moved: read from every frame
   * as it arrives (capture/track-line-worker.ts), ahead of the frames still waiting to be read. */
  onPosition?:(row:number)=>void;
  /** Development diagnosis: card ids whose accepted crops and readings the report keeps (session/row-evidence.ts). */
  traceCards?:readonly string[];
  /** Frame times count from the first frame taken (a live track's timestamps start anywhere). */relativeTime?:boolean;
  target:HTMLVideoElement;signal:AbortSignal;scrollSteps?:number;names?:boolean;nameHoldSeconds?:number;/** Name reading beside the frame loop (default) or inside it. */backgroundNames?:boolean;/** Place background-named cards in the list table (default). */placeNames?:boolean;/** Draw each video frame to a canvas kept in main memory (as before) instead of a graphics-backed one; for comparison. */softwareFrame?:boolean;/** Finish reading a frame before the next one is taken (as before); for comparison. */serial?:boolean;/** Visual reading workers (default 2). */readers?:number;/** Presented frames kept waiting for the reader, oldest dropped beyond this (default 12; 1 = only the newest frame, as before). */queue?:number;/** Run one name reading on a blank crop before the share starts (default). */warmNames?:boolean;/** After the share, run the scanner's zero check on kept crops (default; needs evidence). */zeroCheck?:boolean|'diagnose'|'end';/** Take frames from the video element's frame callback (as before) instead of the track; for comparison. */videoSource?:boolean;/** Put named crops through the scanner's acceptance and merge (default; needs name reading). */evidence?:boolean;
  /** Readers prepared before the share (session/scanner-preparation.ts): used instead of loading
   * new ones, and released by their owner, not here. */
  prepared?:{readonly acquisition:ReturnType<typeof createAcquisitionClient>;readonly visuals:readonly ReturnType<typeof createVisualClient>[];
    readonly recognizer:Awaited<ReturnType<typeof createRecognizer>>};
  onProgress?:(text:string)=>void}):Promise<RowLiveResult> {
  const {signal}=options,scrollSteps=options.scrollSteps??51,video=options.target as FrameCallbackVideo;
  if(options.videoSource&&typeof video.requestVideoFrameCallback!=='function')throw Error('이 브라우저는 requestVideoFrameCallback을 지원하지 않습니다.');
  const prepared=options.prepared;
  const acquisition=prepared?.acquisition??createAcquisitionClient(signal);
  const visuals=prepared?[...prepared.visuals]:Array.from({length:Math.min(8,Math.max(1,Math.round(options.readers??2)))},()=>createVisualClient(signal));
  if(visuals.some(visual=>!visual)){
    if(!prepared){acquisition.dispose();for(const visual of visuals)visual?.dispose();}
    throw Error('이 브라우저는 시각 판독 워커를 지원하지 않습니다.');
  }
  const strip=Object.assign(document.createElement('canvas'),{width:16,height:942}),stripContext=strip.getContext('2d',{willReadFrequently:true})!;
  // The frame canvas is only drawn to, frozen for the worker and sampled for the thin scrollbar
  // strip, so it stays graphics-backed: a canvas marked for frequent reading copies every video
  // frame into main memory first.
  const frame=document.createElement('canvas'),frameContext=frame.getContext('2d',options.softwareFrame?{willReadFrequently:true}:{})!;
  let recognizer:Awaited<ReturnType<typeof createRecognizer>>|undefined,closeWaiting=()=>{},stopLag=()=>{},endWorker=()=>{},endEvidence=()=>{},stopHeartbeat=()=>{};
  /** Joins the work still running when the scan stops early (frame reading, the name lane). */
  let settleWork=async()=>{};
  const input=options.input;
  try{
    await Promise.all([acquisition.ready(),...visuals.map(visual=>visual!.ready())]);
    if(prepared)recognizer=prepared.recognizer;
    else if(options.names!==false)recognizer=await createRecognizer(()=>{},signal);
    const reader=recognizer;
    // The first name reading loads the text reader (seconds). Do it on a blank crop before the
    // share starts, so the first real reading does not hold the one name lane that long.
    // A prepared reader was warmed when it was prepared.
    if(reader&&!prepared&&options.warmNames!==false){
      const blank=Object.assign(document.createElement('canvas'),{width:140,height:210});
      blank.getContext('2d',{willReadFrequently:true})!.fillRect(0,0,140,210);
      try{await reader.identify(blank,true,true);}catch{/* Warm-up only. */}
      blank.width=0;
    }
    const names:RowReadNames|undefined=reader?{
      // The name lane also runs the artwork match with fractional registration (the scanner's
      // refined match for structurally intact crops). At 1920x1080 a crop is 105x158 pixels and
      // the whole-cell artwork match misses cards it names at 2560x1440; the refined one names
      // them (docs/dev-recording.md). ?refine=0 turns it off, for comparison.
      async identify(image,stable,structural){const identity=await reader.identify(image,true,stable,structural,undefined,
        typeof location==='undefined'||new URLSearchParams(location.search).get('refine')!=='0');return identity?{id:identity.id,name:identity.name,full:identity}:null;},
      async values(image,id){const values=await reader.read(image,id,false,false);return {awakening:values.awakening,extraCopies:values.extraCopies,full:values};},
      ranText:image=>reader.nameDiagnostics(image).some(attempt=>attempt.engine!=='quality'),
      attempts:image=>reader.nameDiagnostics(image).slice(0,12).map(attempt=>`${attempt.engine??''}|${attempt.variant??''}|${attempt.text}|${Math.round(attempt.confidence)}|${attempt.reason??''}|${(attempt.candidates??[]).slice(0,2).map(candidate=>`${candidate.name}:${Math.round(candidate.score*100)}`).join(',')}`),
      async count(image,id,corroborate){const values=await reader.read(image,id,corroborate,true);return {awakening:values.awakening,extraCopies:values.extraCopies,full:values};},
    }:undefined;
    // The scanner's acceptance and merge for what this reading names (needs the reader's catalogue).
    const evidence:RowEvidence|undefined=reader&&options.evidence!==false?createRowEvidence(reader.catalog,150,{trace:options.traceCards??[]}):undefined;
    if(evidence)endEvidence=()=>evidence.dispose();
    // Set below once the session and the reading exist.
    let zeroWork=0;
    const session=createRowReadSession(visuals as RowReadVisual[],scrollSteps,Infinity,names,options.nameHoldSeconds,options.backgroundNames!==false,options.placeNames!==false,evidence);
    const thumbClock=createThumbClock();
    // Presented frames wait in a short line, each a graphics-memory snapshot taken in the frame
    // callback with its media time. A fast flick shows rows for one or two frames about 30 ms apart,
    // less than one acquisition takes; the line lets the reader catch up once the list rests. Beyond
    // `limit` the oldest waiting frame is dropped and counted.
    const limit=Math.max(1,Math.round(options.queue??12));
    const waiting:{snapshot:VideoFrame;mediaTime:number;at:number}[]=[];
    closeWaiting=()=>{ended=true;closedLine=true;stopSource();for(const item of waiting.splice(0))item.snapshot.close();};
    let closedLine=false,stopSource=()=>{};
    let lineWorker:Worker|undefined,workerLine:TrackLineStats|undefined,askNext=()=>{},skipToNewest=()=>{};
    // How long the main thread went without a turn (a 20 ms timer's lateness): a busy main thread
    // is what makes a track read here lose frames.
    let lagLast=performance.now(),lagMax=0,lagOver100=0;
    /** From a frame's arrival in the line worker to its new screen row reaching the main thread (ms). */
    const positionDelays:number[]=[];
    const lagTimer=setInterval(()=>{const now=performance.now(),late=now-lagLast-20;lagLast=now;if(late>lagMax)lagMax=late;if(late>100)lagOver100++;},20);
    stopLag=()=>clearInterval(lagTimer);
    let ended=false,wake:(()=>void)|undefined,dropped=0,passed=0,longestLine=0;
    let firstPresented:number|null=null,lastPresented=0;
    const enqueue=(snapshot:VideoFrame,mediaTime:number)=>{
      waiting.push({snapshot,mediaTime,at:performance.now()});
      while(waiting.length>limit){waiting.shift()!.snapshot.close();dropped++;}
      longestLine=Math.max(longestLine,waiting.length);
      wake?.();
    };
    const watch=()=>video.requestVideoFrameCallback((_now,metadata)=>{
      firstPresented??=metadata.presentedFrames;lastPresented=metadata.presentedFrames;
      if(!ended){
        try{enqueue(new VideoFrame(video),metadata.mediaTime);}catch{/* No frame to snapshot yet. */}
        watch();
      }
    });
    // The track's own frames, every one of them, with the time the replay gave each (its recorded
    // delivery time). The video element keeps playing the same track; it is only not read.
    const track=(video.srcObject as MediaStream|null)?.getVideoTracks()[0];
    const Processor=(globalThis as {MediaStreamTrackProcessor?:new(init:{track:MediaStreamTrack;maxBufferSize:number})=>{readable:ReadableStream<VideoFrame>;discardedFrames?:number;totalFrames?:number}}).MediaStreamTrackProcessor;
    const processor=!options.videoSource&&track&&Processor?new Processor({track,maxBufferSize:limit}):undefined;
    if(!options.videoSource&&!processor)throw Error('이 브라우저는 MediaStreamTrackProcessor를 지원하지 않습니다.');
    let sourceDone=!processor,trackFrames=0,firstStamp:number|null=null,sourceError:Error|undefined;
    // The track is read in a worker (dev/track-line-worker.ts), which keeps the line of waiting
    // frames; the main thread holds at most the one it asked for. `mainReader`: read the track
    // here instead, as before, for comparison.
    if(processor&&!options.mainReader){
      const worker=new Worker(new URL('../capture/track-line-worker.ts',import.meta.url),{type:'module'});
      lineWorker=worker;endWorker=()=>worker.terminate();
      const ask=()=>worker.postMessage({type:'take'} satisfies TrackLineRequest);
      worker.onmessage=(event:MessageEvent<TrackLineReply>)=>{
        const reply=event.data;
        if(reply.type==='position'){

          const row=reply.position===null?null:Math.round(reply.position*scrollSteps);
          if(row!==null&&row!==liveRow&&!ended){
            liveRow=row;
            if(positionDelays.length<4000)positionDelays.push(performance.timeOrigin+performance.now()-reply.arrivedAt);
            try{options.onPosition?.(row);}catch{/* A display callback cannot stop the scan. */}
          }
          return;
        }
        workerLine=reply.stats;trackFrames=reply.stats.received;
        if(reply.type==='done'){sourceDone=true;wake?.();return;}
        firstStamp??=reply.frame.timestamp;
        // Frames the track still held when the share ended were captured before the end: they are read.
        if(closedLine){reply.frame.close();return;}
        waiting.push({snapshot:reply.frame,mediaTime:(reply.frame.timestamp-(options.relativeTime?firstStamp:0))/1e6,at:reply.arrivedAt-performance.timeOrigin});
        wake?.();
      };
      // A line worker that fails ends the scan with an error, not a silent wait for frames.
      worker.onerror=event=>{sourceError??=Error('화면 프레임을 받는 작업을 시작하지 못했습니다'+(event.message?`: ${event.message}`:'')+'. 페이지를 새로고침해 주세요.');sourceDone=true;wake?.();};
      worker.onmessageerror=()=>{sourceError??=Error('화면 프레임을 받지 못했습니다. 페이지를 새로고침해 주세요.');sourceDone=true;wake?.();};
      worker.postMessage({type:'start',readable:processor.readable,limit,copy:!options.heldFrames} satisfies TrackLineRequest,[processor.readable as unknown as Transferable]);
      stopSource=()=>worker.postMessage({type:'stop'} satisfies TrackLineRequest);
      askNext=ask;skipToNewest=()=>worker.postMessage({type:'newest'} satisfies TrackLineRequest);
      ask();
    }
    const trackReader=lineWorker?undefined:processor?.readable.getReader();
    if(trackReader)stopSource=()=>{void trackReader.cancel().catch(()=>{});};
    if(trackReader)void (async()=>{
      try{
        for(;;){
          const next=await trackReader.read();
          if(next.done)break;
          trackFrames++;
          // Frames the track still held when the share ended were captured before the end: they are read.
          firstStamp??=next.value.timestamp;
          if(closedLine)next.value.close();else enqueue(next.value,(next.value.timestamp-(options.relativeTime?firstStamp:0))/1e6);
        }
      }catch{/* The track ended or the run was aborted. */}
      finally{sourceDone=true;wake?.();}
    })();
    else if(!lineWorker)watch();
    let shareEnd:{at:number;cards:number;complete:number;confirmed?:number}|null=null;
    options.onReady?.();
    let lastLocated=false,lastSnapshot=-Infinity;
    /** The list row at the top of the screen in the latest frame the scrollbar was read in. */
    let screenRow:number|null=null,lastThumbRow:number|null=null;
    /** The row the newest arrived frame shows (the line worker reads it), and where its scrollbar is. */
    let liveRow:number|null=null,barKey='';
    const tellBar=(box:{x:number;y:number;width:number;height:number}|null,span?:number)=>{
      const key=box?`${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)},${span===undefined?'?':Math.round(span*50)}`:'none';
      if(key===barKey||!lineWorker)return;
      barKey=key;if(!box)liveRow=null;
      lineWorker.postMessage({type:'bar',box:box?{x:box.x,y:box.y,width:box.width,height:box.height}:null,...(span===undefined?{}:{span})} satisfies TrackLineRequest);
    };
    const headerCanvas=document.createElement('canvas'),headerContext=headerCanvas.getContext('2d',{willReadFrequently:true})!;
    const header={expected:null as number|null,capacity:null as number|null,finalExpected:null as number|null,time:0,kept:false,nextTry:-Infinity,
      firstAt:null as number|null,reads:0,failures:0,fresh:null as number|null,freshTried:-Infinity,freshToken:0,
      /** A total read again later that differs from the first one: replaces it once read twice in a row. */
      recheckAt:-Infinity,differing:null as {owned:number;capacity:number}|null};
    let headerRun:Promise<void>|null=null;
    const growth={points:null as {current:number;maximum:number|null}|null,nextTry:-Infinity,reads:0};
    let growthRun:Promise<void>|null=null;
    /** Read the displayed total from a copy of the kept header (the kept one changes with every frame). */
    const readHeader=async():Promise<{owned:number;capacity:number}|null>=>{
      if(!reader||!header.kept)return null;
      const copy=Object.assign(document.createElement('canvas'),{width:headerCanvas.width,height:headerCanvas.height});
      copy.getContext('2d',{willReadFrequently:true})!.drawImage(headerCanvas,0,0);
      header.reads++;
      try{
        const total=await reader.total(copy,{x:0,y:0,width:copy.width,height:copy.height},false);
        if(!total)header.failures++;
        return total?{owned:total.owned,capacity:total.capacity}:null;
      }catch{header.failures++;return null;}
      finally{copy.width=0;}
    };
    const cardTargetSince=new Map<number,number>(),drawnRead=new Set<number>();
    // Until the scan is done, a dip of the shown confirmed count (a newer view of a confirmed card, not read yet)
    // is shown once it has lasted COUNT_DIP_HOLD_MS (displayConfirmed); the final count is never held.
    let shownConfirmed={value:0,dipSince:null as number|null};
    const publishSnapshot=(phase:RowScanSnapshot['phase'])=>{
      if(!options.onSnapshot)return;
      lastSnapshot=performance.now();
      // Pictures of the cards to check once the share has ended (encoding them while frames are
      // taken would cost the scan main-thread time).
      const merged=evidence?.cards(phase!=='capture')??{cards:[],confirmed:0},totalRows=scrollSteps+GRID_ROWS;
      // While every card of the displayed total is confirmed, the total is read again (about once
      // a second) so that a caller may end the share on a total that is current.
      if(phase==='capture'&&header.expected!==null&&merged.cards.length===header.expected&&merged.confirmed===header.expected){
        // Each card's newest look still waiting for a full reading is read now: the share ends only
        // on the latest looks.
        session.flushFull();
        if(!headerRun&&performance.now()-header.freshTried>=1000){
          header.freshTried=performance.now();
          const token=header.freshToken;
          headerRun=readHeader().then(total=>{if(token===header.freshToken)header.fresh=total?.owned??null;}).finally(()=>{headerRun=null;});
        }
      }else{header.fresh=null;header.freshToken++;}
      const guidance=session.guidance(totalRows,header.capacity,header.expected);
      try{options.onSnapshot({phase,frames,locatedFrames:located,located:lastLocated,
        workDone:frames+session.workDone()+zeroWork+header.reads+growth.reads,
        waitingFrames:Math.max(waiting.length,workerLine?workerLine.received-workerLine.dropped-workerLine.passed-frames:0),
        droppedFrames:dropped+(workerLine?.dropped??0),waitingReads:session.waitingReads(),
        cards:merged.cards,confirmed:merged.confirmed,displayConfirmed:(()=>{
          const now=performance.now();
          if(phase==='done'||merged.confirmed>=shownConfirmed.value){shownConfirmed={value:merged.confirmed,dipSince:null};return merged.confirmed;}
          shownConfirmed.dipSince??=now;
          if(now-shownConfirmed.dipSince>=COUNT_DIP_HOLD_MS)shownConfirmed={value:merged.confirmed,dipSince:null};
          return shownConfirmed.value;})(),expected:header.expected,capacity:header.capacity,finalExpected:header.finalExpected,freshExpected:header.fresh,
        growthPoints:growth.points,
        activity:evidence?.activity()??[],
        unidentifiedCells:guidance.cells.filter(cell=>cell.kind==='unidentified').length+guidance.unplaced.unidentified,
        guidance:(()=>{return {...describeListGuidance(guidance,{totalRows}),
          map:(()=>{const map=listGuidanceMap(guidance,{totalRows,visibleRows:GRID_ROWS,currentRow:phase==='capture'?liveRow??screenRow:screenRow});
            const shown=phase!=='done'?holdNewCardTargets(map,cardTargetSince,performance.now(),CARD_TARGET_HOLD_MS,drawnRead):map;
            drawnRead.clear();for(const run of shown.done??[])for(let row=run.from;row<=run.to;row++)drawnRead.add(row);
            return shown;})()};})()});}catch{/* A display callback cannot stop the scan. */}
    };
    // After the share no frame arrives to publish the state; the remaining reading (frames taken
    // before the end, the name lane, the final checks) is published twice a second so that its
    // progress is seen. `postPhase` is the phase to publish.
    let postPhase:'reading'|'verifying'|null=null;
    const heartbeat=()=>{const timer=setInterval(()=>{if(postPhase)publishSnapshot(postPhase);},500);stopHeartbeat=()=>clearInterval(timer);};
    const completion=input.start().finally(()=>{ended=true;shareEnd={at:performance.now(),...counts()};wake?.();postPhase='reading';publishSnapshot('reading');heartbeat();
      // Frames the line worker still held are read; a worker that never says it is done does not keep the scan waiting.
      setTimeout(()=>{if(!sourceDone){sourceDone=true;wake?.();}},5000);});
    settleWork=async()=>{try{await reading.catch(()=>{});}catch{/* Not started. */}await session.stop();};
    const counts=()=>{const cards=session.cards();return {cards:cards.length,complete:cards.filter(card=>card.observations.some(observation=>observation.awakening!==null&&observation.extraCopies!==null)).length,
      ...(evidence?{confirmed:evidence.summary().confirmed}:{})};};
    const timeline:{t:number;cards:number;complete:number}[]=[],frameMs:number[]=[],waitMs:number[]=[];
    let frames=0,located=0,started:number|null=null,nextTick=1;
    let reading:Promise<void>=Promise.resolve(),missedWindow=false;
    let zeroRun:Promise<void>|null=null;
    const zeroLive={runs:0,ms:0,previewReads:0,resolved:[] as string[]};
    const frameLog:[number,number,0|1,number,number|null][]=[];
    let detectorTotals:ReturnType<typeof addDetectorProfile>;const slow={frames:0,located:0,times:[] as number[]};
    const slotSum={exact:0,moved:0,inspected:0,frames:0};
    const stage={draw:[] as number[],freeze:[] as number[],detect:[] as number[],crop:[] as number[],transfer:[] as number[],materialize:[] as number[],thumb:[] as number[],read:[] as number[]};
    for(;;){
      signal.throwIfAborted();
      if(sourceError)throw sourceError;
      const current=waiting.shift();
      if(!current){
        if(ended&&sourceDone)break;
        await new Promise<void>(resolve=>{wake=resolve;});wake=undefined;
        continue;
      }
      askNext();
      const began=performance.now();started??=current.at;waitMs.push(began-current.at);
      const {snapshot}=current;
      if(frame.width!==snapshot.displayWidth||frame.height!==snapshot.displayHeight){frame.width=snapshot.displayWidth;frame.height=snapshot.displayHeight;}
      if(!frame.width||!frame.height){snapshot.close();continue;}
      frameContext.drawImage(snapshot,0,0);snapshot.close();
      frames++;stage.draw.push(performance.now()-began);
      const time=current.mediaTime;
      const acquired=await acquisition.detectAndAcquire(frame,time);
      const timing=acquired.timing;
      detectorTotals=addDetectorProfile(detectorTotals,timing?.detectorProfile);
      if((timing?.detectMs??0)>100){slow.frames++;if(acquired.layout)slow.located++;if(slow.times.length<40)slow.times.push(Math.round(time*100)/100);}
      if(timing?.profile){slotSum.exact+=timing.profile.exact;slotSum.moved+=timing.profile.moved;slotSum.inspected+=timing.profile.inspected;slotSum.frames++;}
      if(timing){stage.freeze.push(timing.freezeMs);stage.detect.push(timing.detectMs);stage.crop.push(timing.cropMs);stage.transfer.push(timing.roundTripMs-timing.workerMs);stage.materialize.push(timing.materializeMs);}
      // No card window in this frame: looking for it is slow, and frames without it hold no cards.
      // Only the newest waiting frame is kept, so the line is empty when the window appears.
      // A frame now and then without it (a notice, a fast scroll) does not mean the window is gone: the
      // waiting frames are passed over only after two such frames in a row.
      if(!acquired.layout){tellBar(null);if(missedWindow){skipToNewest();while(waiting.length>1){waiting.shift()!.snapshot.close();passed++;}}}
      missedWindow=!acquired.layout;
      const release=()=>{for(const cell of acquired.cells)if(cell.image)cell.image.width=0;};
      let read:(()=>Promise<void>)|undefined,thumbRow:number|null=null;
      if(acquired.layout&&acquired.cells.length===COLUMNS*GRID_ROWS){
        located++;
        try{options.onLocated?.();}catch{/* Development recording is optional. */}
        // The storage header of this frame is kept (a small copy) so that the displayed total can
        // be read from it: once early, and again from the last frame when everything was read.
        if(reader){
          const box=acquired.layout.header,width=Math.max(1,Math.round(box.width)),height=Math.max(1,Math.round(box.height));
          if(headerCanvas.width!==width)headerCanvas.width=width;
          if(headerCanvas.height!==height)headerCanvas.height=height;
          headerContext.drawImage(frame,box.x,box.y,box.width,box.height,0,0,width,height);
          header.time=time;header.kept=true;
          if(growth.points===null&&!growthRun&&time>=growth.nextTry){
            // The reader crops its regions from the frame at once, before the frame canvas changes.
            growth.nextTry=time+1;growth.reads++;
            growthRun=reader.metadata(frame,acquired.layout).then(reading=>{if(reading?.growthPoints)growth.points=reading.growthPoints;})
              .catch(()=>{/* Read again from a later frame. */}).finally(()=>{growthRun=null;});
          }
          if(header.expected===null&&!headerRun&&time>=header.nextTry){
            header.nextTry=time+1;
            headerRun=readHeader().then(total=>{
              if(total&&header.expected===null){header.expected=total.owned;header.capacity=total.capacity;header.firstAt=Math.round(time*1000)/1000;}
            }).finally(()=>{headerRun=null;});
          }else if(header.expected!==null&&!headerRun&&time>=header.recheckAt){
            // The first reading is not final: one misread (a covered or changing header) would leave
            // the scan unable to finish. A different total read twice in a row replaces it.
            header.recheckAt=time+3;
            headerRun=readHeader().then(total=>{
              if(!total)return;
              if(total.owned===header.expected&&total.capacity===header.capacity){header.differing=null;return;}
              if(header.differing&&header.differing.owned===total.owned&&header.differing.capacity===total.capacity){
                header.expected=total.owned;header.capacity=total.capacity;header.differing=null;header.freshToken++;header.fresh=null;
              }else header.differing=total;
            }).finally(()=>{headerRun=null;});
          }
        }
        const thumbStarted=performance.now();
        const bar=acquired.layout.scrollbar;
        stripContext.clearRect(0,0,16,942);stripContext.drawImage(frame,bar.x,bar.y,bar.width,bar.height,0,0,16,942);
        const geometry=readScrollGeometry(stripContext.getImageData(0,0,16,942).data,16,942);
        if(geometry)tellBar(bar,geometry.pageSpan);
        const thumb=thumbClock(time,geometry?.position??null);
        stage.thumb.push(performance.now()-thumbStarted);thumbRow=thumb.position===null?null:Math.round(thumb.position*scrollSteps);
        if(thumbRow!==null){screenRow=thumbRow;
          const moving=lastThumbRow===null||thumbRow===lastThumbRow?null:thumbRow>lastThumbRow?'down' as const:'up' as const;
          session.view(thumbRow,surelyShownRows(Array.from({length:GRID_ROWS},(_,row)=>
            // Seen only when every cell of the row was readable or an empty slot: a row passed with cells
            // covered is not drawn read (those cells are asked for).
            acquired.cells.slice(row*COLUMNS,row*COLUMNS+COLUMNS).every(cell=>cell.quality.usable||cell.quality.reason===EMPTY_REASON)),(thumb.settledMs??0)>=200,moving));
          lastThumbRow=thumbRow;}
        read=async()=>{
          const readStarted=performance.now();
          await session.processFrame(time,acquired.cells.map(cell=>({usable:cell.quality.usable,empty:cell.quality.reason===EMPTY_REASON,image:cell.image,feature:cell.feature,alignment:cell.alignment,fieldRevision:cell.fieldRevision})),thumb);
          stage.read.push(performance.now()-readStarted);
        };
      }
      // Frames are read strictly in order. The next frame is taken and acquired while this one is
      // being read (the acquisition worker and the reading workers are different workers); a frame
      // waits here only for the reading of the frame before it.
      await reading;
      reading=(read?read():Promise.resolve()).finally(release);
      if(options.serial)await reading;
      const now=performance.now();frameMs.push(now-began);
      if(frameLog.length<800)frameLog.push([Math.round(time*1000)/1000,Math.round(now-began),read?1:0,acquired.cells.filter(cell=>cell.quality.usable).length,thumbRow]);
      while((now-started)/1000>=nextTick){const tick=counts();timeline.push({t:nextTick,...tick});nextTick++;
        // The zero check also runs while the share goes on (about once a second, one run at a time),
        // so a card with no extra copies is confirmed when its crops show it, not only at the end.
        if(evidence&&reader&&options.zeroCheck!==false&&options.zeroCheck!=='end'&&!zeroRun){
          const began=performance.now();
          zeroRun=evidence.confirmZeros((image,id,width)=>{zeroWork++;return reader.read(image,id,true,false,undefined,width);}).then(check=>{
            zeroLive.runs++;zeroLive.ms+=performance.now()-began;zeroLive.previewReads+=check.previewReads;zeroLive.resolved.push(...check.resolved);
          }).catch(()=>{}).finally(()=>{zeroRun=null;});
        }
        if(options.onCounts)options.onCounts(tick,describeListGuidance(session.guidance(scrollSteps+GRID_ROWS,header.capacity,header.expected),{totalRows:scrollSteps+GRID_ROWS}));}
      lastLocated=!!acquired.layout;
      if(performance.now()-lastSnapshot>=(ended?READING_SNAPSHOT_MS:SNAPSHOT_MS))publishSnapshot(ended?'reading':'capture');
      if(frames%10===0)options.onProgress?.(`줄 중심 실시간 · 읽은 프레임 ${frames} · 카드 ${session.cards().length}`);
    }
    await completion.catch(()=>{});
    // The frame still being read when the share ended is counted after the share, like a name reading.
    // Frames still waiting or being read when the share ended are read after it; what was known at
    // the end of the share was counted then.
    await reading;
    const finished=performance.now(),end=shareEnd as {at:number;cards:number;complete:number;confirmed?:number}|null;
    const shareSeconds=started===null||!end?0:Math.round((end.at-started)/100)/10,atShareEnd=end?{cards:end.cards,complete:end.complete,...(end.confirmed===undefined?{}:{confirmed:end.confirmed})}:counts();
    const afterFrames=counts(),catchUpMs=end?Math.round(finished-end.at):0;
    // A name reading still in flight when the share ended finishes; it is counted after the share.
    await session.namesIdle();
    const afterNames=counts();
    postPhase='verifying';publishSnapshot('verifying');
    // The displayed total of the last frame that showed the card window, read after everything else.
    if(headerRun)await headerRun;
    if(growthRun)await growthRun;
    if(reader&&header.kept){
      const total=await readHeader();
      if(total){header.finalExpected=total.owned;if(header.expected===null){header.expected=total.owned;header.capacity=total.capacity;}}
    }
    let afterZeroCheck:RowLiveResult['live']['afterZeroCheck'];
    if(zeroRun)await zeroRun;
    if(evidence&&reader&&options.zeroCheck!==false){
      const zeroStarted=performance.now();
      const brief=(values:Awaited<ReturnType<typeof reader.read>>)=>({awakening:values.awakening,extraCopies:values.extraCopies,diagnostics:values.countDiagnostics});
      // `diagnose`: also read each unresolved card's preferred crop three more ways and keep its picture (adds to the time reported).
      const check=await evidence.confirmZeros((image,id,width)=>{zeroWork++;return reader.read(image,id,true,false,undefined,width);},options.zeroCheck!=='diagnose'?undefined:async(image,id,width)=>({
        visual:brief(await reader.read(image,id,false,false,undefined,width)),full:brief(await reader.read(image,id,false,true,undefined,width)),corroborated:brief(await reader.read(image,id,true,true,undefined,width))}));
      afterZeroCheck={...check,ms:Math.round(performance.now()-zeroStarted),confirmed:evidence.summary().confirmed};
    }
    // The card pictures still being encoded belong in the final list (a picture never holds the end up for long).
    if(evidence)await Promise.race([evidence.picturesSettled(),new Promise(resolve=>setTimeout(resolve,3000))]);
    postPhase=null;stopHeartbeat();
    publishSnapshot('done');
    const sorted=[...frameMs].sort((a,b)=>a-b),at=(share:number)=>sorted.length?Math.round(sorted[Math.min(sorted.length-1,Math.floor(share*sorted.length))]):0;
    const namesSummary=session.names();
    const share=(values:number[])=>{const ordered=[...values].sort((a,b)=>a-b),pick=(part:number)=>ordered.length?Math.round(ordered[Math.min(ordered.length-1,Math.floor(part*ordered.length))]*10)/10:0;return {median:pick(.5),p95:pick(.95)};};
    return {frames,locatedFrames:located,wallMs:Math.round(shareSeconds*1000),...session.stats,scrollSteps,table:session.summary(),cards:session.cards(),
      ...(namesSummary?{names:namesSummary}:{}),
      live:{shareSeconds,presentedFrames:processor?trackFrames:firstPresented===null?0:lastPresented-firstPresented+1,readFrames:frames,
        source:processor?'track':'video',...(processor?{reader:lineWorker?'worker' as const:'main' as const}:{}),
        ...(workerLine?{lineCopy:{copied:workerLine.copied,uncopied:workerLine.uncopied,meanMs:workerLine.copied?Math.round(workerLine.copyMs/workerLine.copied*10)/10:0}}:{}),
        mainThread:{maxGapMs:Math.round(lagMax),gapsOver100Ms:lagOver100,
          ...(positionDelays.length?{positionDelay:{count:positionDelays.length,...share(positionDelays),max:Math.round(Math.max(...positionDelays))}}:{})},
        growthPoints:growth.points,
        header:{expected:header.expected,capacity:header.capacity,finalExpected:header.finalExpected,firstAtSeconds:header.firstAt,reads:header.reads,failures:header.failures},
        guidance:(()=>{const totalRows=scrollSteps+GRID_ROWS,guidance=session.guidance(totalRows,header.capacity,header.expected);return {totalRows,...guidance,...describeListGuidance(guidance,{totalRows})};})(),
        ...(typeof processor?.totalFrames==='number'?{sourceTotal:processor.totalFrames}:{}),
        ...(track?{track:{frameRate:track.getSettings().frameRate??null,stats:trackStats(track)}}:{}),...(typeof processor?.discardedFrames==='number'?{sourceDiscarded:processor.discardedFrames}:{}),
        frameMs:{median:at(.5),p95:at(.95),max:at(1)},timeline,
        slots:{exact:Math.round(slotSum.exact/Math.max(1,slotSum.frames)*10)/10,moved:Math.round(slotSum.moved/Math.max(1,slotSum.frames)*10)/10,inspected:Math.round(slotSum.inspected/Math.max(1,slotSum.frames)*10)/10},
        detection:{stages:Object.fromEntries(Object.entries(detectorTotals??{}).map(([name,row])=>[name,{calls:row.calls,cached:row.cached,ms:Math.round(row.elapsedMs)}])),
          slowFrames:slow.frames,slowLocated:slow.located,slowTimes:slow.times,unlocatedFrames:frames-located},
        line:{limit,longest:Math.max(longestLine,workerLine?.longest??0),dropped:dropped+(workerLine?.dropped??0),passedWithoutWindow:passed+(workerLine?.passed??0),waitMs:(()=>{const ordered=[...waitMs].sort((a,b)=>a-b),pick=(part:number)=>ordered.length?Math.round(ordered[Math.min(ordered.length-1,Math.floor(part*ordered.length))]):0;return {median:pick(.5),p95:pick(.95),max:pick(1)};})(),catchUpMs,afterFrames},
        ...(evidence?{evidence:evidence.summary(true)}:{}),
        frameLog,
        stages:{draw:share(stage.draw),freeze:share(stage.freeze),detect:share(stage.detect),crop:share(stage.crop),transfer:share(stage.transfer),materialize:share(stage.materialize),thumb:share(stage.thumb),read:share(stage.read)},atShareEnd,afterNames,...(afterZeroCheck?{afterZeroCheck}:{}),
        ...(zeroLive.runs?{zeroDuringShare:{runs:zeroLive.runs,ms:Math.round(zeroLive.ms),previewReads:zeroLive.previewReads,resolved:zeroLive.resolved}}:{})}};
  }finally{
    stopHeartbeat();
    // Work still running when the scan stopped early finishes (or stops) before its readers go.
    await settleWork().catch(()=>{});
    closeWaiting();stopLag();endWorker();endEvidence();input.dispose();
    if(!prepared){acquisition.dispose();for(const visual of visuals)visual?.dispose();await recognizer?.dispose();}
    frame.width=0;strip.width=0;
  }
}
