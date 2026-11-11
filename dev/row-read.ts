import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {createVisualClient} from '../src/features/card-scanner/recognition/visual-client';
import type {VisualResult} from '../src/features/card-scanner/recognition/visual-client';
import {readScrollGeometry} from '../src/features/card-scanner/session/scroll-position';
import {createListTable,SLOT_EMPTY,SLOT_UNIDENTIFIED,SLOT_UNUSABLE} from '../src/features/card-scanner/session/list-table';
import {openRecordedShareStream} from './recorded-share-frames';
import {planRow} from './row-read-plan';
import type {LeanCard,LeanObservation} from './lean-scan';

/** Development prototype (docs/scanner-live-redesign.md 13.9, step 2). Not a scanner.
 *
 * Replays a server recording frame by frame and reads only what the list table does not have
 * yet: two probe slots per visible row decide whether the row is known (dev/row-read-plan.ts),
 * then only the missing slots of a known row, or the whole of an unknown row, are read.
 *
 * Reading is the visual worker alone (artwork identity, awakening, count), as in
 * dev/lean-scan.ts: raw single observations WITHOUT the scanner's reliability checks, name
 * reading, merge or completion. The card values are measurements to compare, never results.
 * The acquisition worker still crops all 40 slots of every frame; this step measures how
 * much READING the row policy saves and whether the values stay the same, not the frame cost. */
export interface RowReadResult {
  readonly frames:number;readonly locatedFrames:number;readonly wallMs:number;
  /** Usable crops offered / crops read as probes / read because the row or slot needed it. */
  readonly usableCrops:number;readonly probeReads:number;readonly neededReads:number;
  /** Visible rows: recognised as known with nothing left to read / known with slots to read / read whole. */
  readonly rowsSkipped:number;readonly rowsPartly:number;readonly rowsWhole:number;
  readonly scrollSteps:number;
  readonly table:{readonly anchoredRows:number;readonly floatingIslands:number;readonly floatingCards:number;
    readonly overlapConflicts:number;readonly anchorConflicts:number;readonly cellConflicts:number};
  readonly cards:readonly LeanCard[];
}

export const EMPTY_REASON='미보유 카드 뒷면 · 빈 슬롯';
export const COLUMNS=10,GRID_ROWS=4;
/** Probe columns: two slots away from the row's edges and from each other. */
export const PROBE_COLUMNS=[2,7] as const;

/** What a slot of an acquired frame offers the reader. */
export interface RowReadCell {readonly usable:boolean;readonly empty:boolean;readonly image:HTMLCanvasElement|undefined}
export type RowReadVisual=NonNullable<ReturnType<typeof createVisualClient>>;

/** The reading shared by the prototypes: probes, row plans, reads, the list table and the card
 * observations. A frame's cells are read according to the plan and nothing else. */
export function createRowReadSession(visuals:readonly RowReadVisual[],scrollSteps:number,
  /** After this many reads a slot this reader cannot finish (a card it cannot name, or values it
   * cannot read) counts as handed to the scanner's name reading and is not read again here.
   * Infinity keeps reading it in every frame. */
  handOverAfter=Infinity) {
  const table=createListTable();
  const codes=new Map<string,number>(),cards:{id:string;name:string;firstTime:number;observations:LeanObservation[]}[]=[];
  // A card is complete for this reader once one observation gave both of its values.
  const complete=new Set<number>();
  const stats={usableCrops:0,probeReads:0,neededReads:0,rowsSkipped:0,rowsPartly:0,rowsWhole:0};
  /** Read the given crops, one per visual worker at a time; results in the order given. */
  const readAll=async(images:readonly HTMLCanvasElement[])=>{
    const results:(VisualResult|null)[]=Array<VisualResult|null>(images.length).fill(null);
    let next=0;
    await Promise.all(visuals.map(async visual=>{
      for(;;){const index=next++;if(index>=images.length)return;results[index]=await visual.read(images[index]);}
    }));
    return results;
  };
  const plan=(row:number,probeCode:(slot:number)=>number|null,usable:(slot:number)=>boolean)=>planRow({columns:COLUMNS,
    probes:PROBE_COLUMNS.map(column=>{const card=probeCode(row*COLUMNS+column);return {column,card,place:card===null?null:table.locate(card)};}),
    usable:new Set(Array.from({length:COLUMNS},(_,column)=>column).filter(column=>usable(row*COLUMNS+column))),
    cellAt:table.cellAt,complete:card=>complete.has(card)||cards[card].observations.length>=handOverAfter,
    handedOver:cell=>cell.looks>=handOverAfter});
  return {
    table,stats,readAll,planRow:plan,
    cards:()=>[...cards].sort((a,b)=>a.firstTime-b.firstTime),
    /** The code of a card already seen, without recording anything (the light check's probes). */
    knownCode:(id:string)=>codes.get(id)??null,
    /** Read one acquired frame by the row plan and record it in the table. */
    async processFrame(time:number,cells:readonly RowReadCell[],thumb:{position:number|null;settledMs:number|null}):Promise<void> {
      const usable=(slot:number)=>cells[slot].usable&&!!cells[slot].image;
      stats.usableCrops+=cells.filter((_,slot)=>usable(slot)).length;
      const slots:number[]=cells.map(cell=>cell.empty?SLOT_EMPTY:SLOT_UNUSABLE);
      /** Record what a read slot showed: its code for the table and its values for the card. */
      const record=(slot:number,result:VisualResult|null)=>{
        if(!result?.identity){slots[slot]=SLOT_UNIDENTIFIED;return null;}
        let code=codes.get(result.identity.id);
        if(code===undefined){code=cards.length;codes.set(result.identity.id,code);cards.push({id:result.identity.id,name:result.identity.name,firstTime:time,observations:[]});}
        slots[slot]=code;
        const awakening=result.values?.awakening??null,extraCopies=result.values?.extraCopies??null;
        cards[code].observations.push({time,awakening,extraCopies});
        if(awakening!==null&&extraCopies!==null)complete.add(code);
        return code;
      };
      // 1. Probes of all four visible rows.
      const probeSlots=Array.from({length:GRID_ROWS},(_,row)=>PROBE_COLUMNS.map(column=>row*COLUMNS+column)).flat().filter(usable);
      const probeResults=await readAll(probeSlots.map(slot=>cells[slot].image!));
      stats.probeReads+=probeSlots.length;
      const probeCode=new Map<number,number|null>();
      probeSlots.forEach((slot,index)=>probeCode.set(slot,record(slot,probeResults[index])));
      // 2. Per row: what else has to be read.
      const more:number[]=[];
      for(let row=0;row<GRID_ROWS;row++){
        const rowPlan=plan(row,slot=>probeCode.get(slot)??null,usable);
        if(!rowPlan.known)stats.rowsWhole++;else if(rowPlan.read.length)stats.rowsPartly++;else stats.rowsSkipped++;
        for(const column of rowPlan.read)more.push(row*COLUMNS+column);
      }
      const moreResults=await readAll(more.map(slot=>cells[slot].image!));
      stats.neededReads+=more.length;
      more.forEach((slot,index)=>{record(slot,moreResults[index]);});
      // 3. The table sees only what was read in this frame.
      table.observe({time,thumbRow:thumb.position===null?null:Math.round(thumb.position*scrollSteps),settledMs:thumb.settledMs,slots});
    },
    summary(){
      const snapshot=table.snapshot();
      return {anchoredRows:snapshot.rows.size,floatingIslands:snapshot.floating.length,floatingCards:snapshot.floating.reduce((total,island)=>total+island.cards,0),
        overlapConflicts:snapshot.counts.overlapConflicts,anchorConflicts:snapshot.counts.anchorConflicts,cellConflicts:snapshot.counts.cellConflicts};
    },
  };
}

/** Thumb position with the time since it last moved, fed one frame at a time. */
export function createThumbClock() {
  let lastChange=-Infinity,previous:number|null=null;
  return (time:number,position:number|null):{position:number|null;settledMs:number|null}=>{
    if(position===null)return {position,settledMs:null};
    if(previous===null||Math.abs(position-previous)>1e-6){lastChange=time;previous=position;}
    return {position,settledMs:(time-lastChange)*1000};
  };
}

export async function runRowRead(options:{recordingId:string;signal:AbortSignal;scrollSteps?:number;onProgress?:(text:string)=>void}):Promise<RowReadResult> {
  const {recordingId,signal}=options,scrollSteps=options.scrollSteps??51;
  const stream=await openRecordedShareStream({recordingId,signal});
  const acquisition=createAcquisitionClient(signal);
  const visuals=[createVisualClient(signal),createVisualClient(signal)];
  if(visuals.some(visual=>!visual))throw Error('이 브라우저는 시각 판독 워커를 지원하지 않습니다.');
  const strip=Object.assign(document.createElement('canvas'),{width:16,height:942});
  const stripContext=strip.getContext('2d',{willReadFrequently:true})!;
  try{
    await Promise.all([acquisition.ready(),...visuals.map(visual=>visual!.ready())]);
    const session=createRowReadSession(visuals as RowReadVisual[],scrollSteps),thumbClock=createThumbClock();
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
      await session.processFrame(frame.time,acquired.cells.map(cell=>({usable:cell.quality.usable,empty:cell.quality.reason===EMPTY_REASON,image:cell.image})),thumb);
      release();
      if(frames%20===0)options.onProgress?.(`줄 중심 판독 · ${frames}/${stream.frameCount}프레임 · 카드 ${session.cards().length} · 읽은 크롭 ${session.stats.probeReads+session.stats.neededReads}`);
    }
    return {frames,locatedFrames:located,wallMs:Math.round(performance.now()-started),...session.stats,scrollSteps,table:session.summary(),cards:session.cards()};
  }finally{acquisition.dispose();for(const visual of visuals)visual?.dispose();}
}
