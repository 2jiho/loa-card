import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {createVisualClient} from '../src/features/card-scanner/recognition/visual-client';
import type {VisualResult} from '../src/features/card-scanner/recognition/visual-client';
import {openRecordedShareStream} from './recorded-share-frames';

/** Development prototype (measurement notes: fixtures/local/notes/, kept with the private recordings). Not a scanner.
 *
 * Feeds every frame of a server recording through the pieces a lean live path would keep
 * and nothing else: the acquisition worker (card window, 40 crops, the quality checks) and
 * the visual worker (artwork identity, awakening, count). There is no queue, retry, name
 * OCR, merge, completion check, preview or UI update. A crop whose pixels were already read
 * (the acquisition worker's exact-pixel key) is not read again.
 *
 * It answers two questions: how long does a frame take when only this is done, and how much
 * of what the scanner finally reports do these two pieces already see. Its card values are
 * raw single observations WITHOUT the scanner's reliability checks; they are measurements
 * to compare, never results to show a user. */
export interface LeanObservation {readonly time:number;readonly awakening:number|null;readonly extraCopies:number|null}
export interface LeanCard {
  readonly id:string;readonly name:string;readonly firstTime:number;
  /** Reads that named this card, in capture order. */
  readonly observations:readonly LeanObservation[];
}
export interface LeanScanResult {
  readonly frames:number;readonly locatedFrames:number;
  /** Crops the quality checks accepted / of those, crops with pixels not read before / reads that named a card. */
  readonly usableCrops:number;readonly newCrops:number;readonly identifiedCrops:number;
  readonly wallMs:number;
  /** Mean per frame with a card window: the acquisition round trip, and reading that frame's new crops. */
  readonly locatedFrame:{readonly acquireMs:number;readonly readMs:number;readonly totalMs:number;readonly p95TotalMs:number};
  readonly otherFrameMs:number;
  readonly readMsPerCrop:number;
  readonly lanes:number;
  readonly cards:readonly LeanCard[];
}

const mean=(values:readonly number[])=>values.length?values.reduce((a,b)=>a+b,0)/values.length:0;
const round=(value:number)=>Math.round(value*10)/10;

export async function runLeanScan(options:{recordingId:string;signal:AbortSignal;lanes?:number;onProgress?:(text:string)=>void}):Promise<LeanScanResult> {
  const {recordingId,signal}=options,lanes=Math.max(1,options.lanes??2);
  const stream=await openRecordedShareStream({recordingId,signal});
  const acquisition=createAcquisitionClient(signal);
  const visuals=Array.from({length:lanes},()=>createVisualClient(signal));
  if(visuals.some(visual=>!visual))throw Error('이 브라우저는 시각 판독 워커를 지원하지 않습니다.');
  try{
    await Promise.all([acquisition.ready(),...visuals.map(visual=>visual!.ready())]);
    const read=new Set<string>(),cards=new Map<string,{id:string;name:string;firstTime:number;observations:LeanObservation[]}>();
    const acquireMs:number[]=[],readMs:number[]=[],totalMs:number[]=[],otherMs:number[]=[];
    let frames=0,usableCrops=0,newCrops=0,identifiedCrops=0,readTotal=0;
    const started=performance.now();
    for await(const frame of stream.frames()){
      signal.throwIfAborted();frames++;
      const t0=performance.now();
      const acquired=await acquisition.detectAndAcquire(frame.element,frame.time);
      const t1=performance.now();
      if(!acquired.layout){otherMs.push(t1-t0);for(const cell of acquired.cells)if(cell.image)cell.image.width=0;continue;}
      const usable=acquired.cells.filter(cell=>cell.quality.usable&&cell.image);
      const fresh=usable.filter(cell=>!read.has(cell.pixelKey));
      usableCrops+=usable.length;newCrops+=fresh.length;
      // Each visual client reads one crop at a time; the lanes share this frame's new crops.
      let next=0;
      const results:(VisualResult|null)[]=Array<VisualResult|null>(fresh.length).fill(null);
      await Promise.all(visuals.map(async visual=>{
        for(;;){const index=next++;if(index>=fresh.length)return;results[index]=await visual!.read(fresh[index].image);}
      }));
      const t2=performance.now();
      fresh.forEach((cell,index)=>{
        read.add(cell.pixelKey);
        const result=results[index];
        if(!result?.identity)return;
        identifiedCrops++;
        let card=cards.get(result.identity.id);
        if(!card){card={id:result.identity.id,name:result.identity.name,firstTime:frame.time,observations:[]};cards.set(card.id,card);}
        card.observations.push({time:frame.time,awakening:result.values?.awakening??null,extraCopies:result.values?.extraCopies??null});
      });
      for(const cell of acquired.cells)if(cell.image)cell.image.width=0;
      acquireMs.push(t1-t0);readMs.push(t2-t1);totalMs.push(t2-t0);readTotal+=t2-t1;
      if(frames%20===0)options.onProgress?.(`가벼운 경로 시제품 · ${frames}/${stream.frameCount}프레임 · 카드 ${cards.size}`);
    }
    const sorted=[...totalMs].sort((a,b)=>a-b);
    return {frames,locatedFrames:totalMs.length,usableCrops,newCrops,identifiedCrops,wallMs:Math.round(performance.now()-started),
      locatedFrame:{acquireMs:round(mean(acquireMs)),readMs:round(mean(readMs)),totalMs:round(mean(totalMs)),
        p95TotalMs:round(sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]:0)},
      otherFrameMs:round(mean(otherMs)),readMsPerCrop:newCrops?round(readTotal/newCrops):0,lanes,
      cards:[...cards.values()].sort((a,b)=>a.firstTime-b.firstTime)};
  }finally{acquisition.dispose();for(const visual of visuals)visual?.dispose();}
}

export interface LeanComparison {
  /** Cards both saw / cards only the scanner reported / cards only the prototype named. */
  readonly both:number;readonly onlyScanner:readonly string[];readonly onlyLean:readonly string[];
  /** Of the cards both saw: the prototype's latest observation agrees with the scanner's value. */
  readonly awakening:{readonly same:number;readonly different:readonly string[];readonly leanUnread:number;readonly scannerUnread:number};
  readonly extraCopies:{readonly same:number;readonly different:readonly string[];readonly leanUnread:number;readonly scannerUnread:number};
  /** Cards whose prototype observations disagree with each other on a read value. */
  readonly unstable:readonly string[];
}

/** Compare the prototype's raw observations with a scanner run of the same recording.
 * The scanner run is program output, not a human-checked expectation. */
export function compareLean(lean:readonly LeanCard[],scanner:readonly {id:string;name:string;awakening:number|null;extraCopies:number|null}[]):LeanComparison {
  const byId=new Map(scanner.map(card=>[card.id,card]));
  const seen=new Set(lean.map(card=>card.id));
  const field=(key:'awakening'|'extraCopies')=>{
    let same=0,leanUnread=0,scannerUnread=0;const different:string[]=[];
    for(const card of lean){
      const other=byId.get(card.id);if(!other)continue;
      // The latest observation that read this field, as a "latest capture" rule would pick.
      const value=[...card.observations].reverse().find(observation=>observation[key]!==null)?.[key]??null;
      if(other[key]===null)scannerUnread++;
      else if(value===null)leanUnread++;
      else if(value===other[key])same++;
      else different.push(`${card.name}: 시제품 ${value}, 스캐너 ${other[key]}`);
    }
    return {same,different,leanUnread,scannerUnread};
  };
  const unstable=lean.filter(card=>(['awakening','extraCopies'] as const).some(key=>
    new Set(card.observations.map(observation=>observation[key]).filter(value=>value!==null)).size>1)).map(card=>card.name);
  return {both:lean.filter(card=>byId.has(card.id)).length,
    onlyScanner:scanner.filter(card=>!seen.has(card.id)).map(card=>card.name),
    onlyLean:lean.filter(card=>!byId.has(card.id)).map(card=>card.name),
    awakening:field('awakening'),extraCopies:field('extraCopies'),unstable};
}
