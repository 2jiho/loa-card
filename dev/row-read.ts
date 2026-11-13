import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {createVisualClient} from '../src/features/card-scanner/recognition/visual-client';
import {createRecognizer} from '../src/features/card-scanner/recognition/recognizer';
import {readScrollGeometry} from '../src/features/card-scanner/session/scroll-position';
import {openRecordedShareStream} from './recorded-share-frames';
import {COLUMNS,EMPTY_REASON,GRID_ROWS,createRowReadSession,createThumbClock} from '../src/features/card-scanner/orchestration/row-session';
import type {RowReadNames,RowReadResult,RowReadVisual} from '../src/features/card-scanner/orchestration/row-session';

/** The replay harness of the row-centred reading (the session itself lives in
 * src/features/card-scanner/orchestration/row-session.ts). */
export * from '../src/features/card-scanner/orchestration/row-session';

export async function runRowRead(options:{recordingId:string;signal:AbortSignal;scrollSteps?:number;/** Read by name what the artwork cannot name. */names?:boolean;/** Seconds to hold a place after a refused text reading (default 1; 0 = no hold). */nameHoldSeconds?:number;onProgress?:(text:string)=>void}):Promise<RowReadResult> {
  const {recordingId,signal}=options,scrollSteps=options.scrollSteps??51;
  const stream=await openRecordedShareStream({recordingId,signal});
  const acquisition=createAcquisitionClient(signal);
  const visuals=[createVisualClient(signal),createVisualClient(signal)];
  if(visuals.some(visual=>!visual))throw Error('이 브라우저는 시각 판독 워커를 지원하지 않습니다.');
  const strip=Object.assign(document.createElement('canvas'),{width:16,height:942});
  const stripContext=strip.getContext('2d',{willReadFrequently:true})!;
  let recognizer:Awaited<ReturnType<typeof createRecognizer>>|undefined;
  try{
    await Promise.all([acquisition.ready(),...visuals.map(visual=>visual!.ready())]);
    if(options.names)recognizer=await createRecognizer(()=>{},signal);
    const reader=recognizer;
    const names:RowReadNames|undefined=reader?{
      async identify(image,stable,structural){const identity=await reader.identify(image,true,stable,structural);return identity?{id:identity.id,name:identity.name}:null;},
      async values(image,id){const values=await reader.read(image,id,false,false);return {awakening:values.awakening,extraCopies:values.extraCopies};},
      ranText:image=>reader.nameDiagnostics(image).some(attempt=>attempt.engine!=='quality'),
      attempts:image=>reader.nameDiagnostics(image).map(attempt=>`${attempt.variant} | "${attempt.text}" ${attempt.confidence.toFixed(2)} | ${attempt.reason??''}`),
    }:undefined;
    const session=createRowReadSession(visuals as RowReadVisual[],scrollSteps,Infinity,names,options.nameHoldSeconds),thumbClock=createThumbClock();
    let frames=0,located=0;
    const started=performance.now();
    for await(const frame of stream.frames()){
      signal.throwIfAborted();frames++;
      const acquired=await acquisition.detectAndAcquire(frame.element,frame.time);
      const release=()=>{for(const cell of acquired.cells)if(cell.image)cell.image.width=0;};
      if(!acquired.layout||acquired.cells.length!==COLUMNS*GRID_ROWS){release();continue;}
      located++;
      const bar=acquired.layout.scrollbar;
      stripContext.drawImage(frame.element,bar.x,bar.y,bar.width,bar.height,0,0,16,942);
      const thumb=thumbClock(frame.time,readScrollGeometry(stripContext.getImageData(0,0,16,942).data,16,942)?.position??null);
      await session.processFrame(frame.time,acquired.cells.map(cell=>({usable:cell.quality.usable,empty:cell.quality.reason===EMPTY_REASON,image:cell.image,fieldRevision:cell.fieldRevision})),thumb);
      release();
      if(frames%20===0)options.onProgress?.(`줄 중심 판독 · ${frames}/${stream.frameCount}프레임 · 카드 ${session.cards().length} · 읽은 크롭 ${session.stats.probeReads+session.stats.neededReads}`);
    }
    return {frames,locatedFrames:located,wallMs:Math.round(performance.now()-started),...session.stats,scrollSteps,table:session.summary(),cards:session.cards(),...(names?{names:session.names()}:{})};
  }finally{acquisition.dispose();for(const visual of visuals)visual?.dispose();await recognizer?.dispose();}
}
