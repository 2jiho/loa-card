import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {createVisualClient} from '../src/features/card-scanner/recognition/visual-client';
import {readScrollGeometry} from '../src/features/card-scanner/session/scroll-position';
import {openRecordedShareStream} from './recorded-share-frames';
import {EMPTY,UNIDENTIFIED,UNUSABLE} from './row-analysis';
import type {RowFrame} from './row-analysis';

/** Development measurement (docs/dev-recording.md, "줄 중심 설계의 타당성 측정"). Not a scanner.
 *
 * For every frame of a server recording that has a card window: what each of the 40 grid
 * slots showed and where the scrollbar thumb was. A slot is identified by the visual worker
 * (artwork only, as in dev/lean-scan.ts); crops with pixels already read reuse that reading.
 * Nothing is merged or decided here; dev/row-analysis.ts reads the result. */
export interface RowScanResult {
  readonly frames:number;readonly locatedFrames:number;readonly wallMs:number;
  /** Card id and name for each slot code >= 0. */
  readonly cards:readonly {readonly id:string;readonly name:string}[];
  readonly observations:readonly RowFrame[];
}

const EMPTY_REASON='미보유 카드 뒷면 · 빈 슬롯';

export async function runRowScan(options:{recordingId:string;signal:AbortSignal;onProgress?:(text:string)=>void}):Promise<RowScanResult> {
  const {recordingId,signal}=options;
  const stream=await openRecordedShareStream({recordingId,signal});
  const acquisition=createAcquisitionClient(signal);
  const visuals=[createVisualClient(signal),createVisualClient(signal)];
  if(visuals.some(visual=>!visual))throw Error('이 브라우저는 시각 판독 워커를 지원하지 않습니다.');
  const strip=Object.assign(document.createElement('canvas'),{width:16,height:942});
  const stripContext=strip.getContext('2d',{willReadFrequently:true})!;
  try{
    await Promise.all([acquisition.ready(),...visuals.map(visual=>visual!.ready())]);
    const cardIndex=new Map<string,number>(),cards:{id:string;name:string}[]=[];
    const keyIndex=new Map<string,number>(),read=new Map<string,number>();   // pixel key -> slot code
    const observations:RowFrame[]=[];
    let frames=0;
    const started=performance.now();
    for await(const frame of stream.frames()){
      signal.throwIfAborted();frames++;
      const acquired=await acquisition.detectAndAcquire(frame.element,frame.time);
      const release=()=>{for(const cell of acquired.cells)if(cell.image)cell.image.width=0;};
      if(!acquired.layout||acquired.cells.length!==40){release();continue;}
      const bar=acquired.layout.scrollbar;
      stripContext.drawImage(frame.element,bar.x,bar.y,bar.width,bar.height,0,0,16,942);
      const geometry=readScrollGeometry(stripContext.getImageData(0,0,16,942).data,16,942);
      // Read the usable crops whose pixels were not read before, two at a time.
      const fresh=acquired.cells.filter(cell=>cell.quality.usable&&cell.image&&!read.has(cell.pixelKey));
      let next=0;
      await Promise.all(visuals.map(async visual=>{
        for(;;){
          const cell=fresh[next++];if(!cell)return;
          const identity=(await visual!.read(cell.image)).identity;
          if(!identity){read.set(cell.pixelKey,UNIDENTIFIED);continue;}
          let code=cardIndex.get(identity.id);
          if(code===undefined){code=cards.length;cardIndex.set(identity.id,code);cards.push({id:identity.id,name:identity.name});}
          read.set(cell.pixelKey,code);
        }
      }));
      observations.push({time:frame.time,position:geometry?.position??null,pageSpan:geometry?.pageSpan??null,
        slots:acquired.cells.map(cell=>cell.quality.reason===EMPTY_REASON?EMPTY:!cell.quality.usable||!cell.image?UNUSABLE:read.get(cell.pixelKey)??UNUSABLE),
        keys:acquired.cells.map(cell=>{
          if(!cell.image)return -1;
          let key=keyIndex.get(cell.pixelKey);
          if(key===undefined){key=keyIndex.size;keyIndex.set(cell.pixelKey,key);}
          return key;
        })});
      release();
      if(frames%20===0)options.onProgress?.(`줄 관측 수집 · ${frames}/${stream.frameCount}프레임 · 카드 ${cards.length}`);
    }
    return {frames,locatedFrames:observations.length,wallMs:Math.round(performance.now()-started),cards,observations};
  }finally{acquisition.dispose();for(const visual of visuals)visual?.dispose();}
}
