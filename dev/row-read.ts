import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {listGuidance} from '../src/features/card-scanner/session/list-guidance';
import {createVisualClient} from '../src/features/card-scanner/recognition/visual-client';
import {createRecognizer} from '../src/features/card-scanner/recognition/recognizer';
import type {VisualResult} from '../src/features/card-scanner/recognition/visual-client';
import {readScrollGeometry} from '../src/features/card-scanner/session/scroll-position';
import {createListTable,SLOT_EMPTY,SLOT_UNIDENTIFIED,SLOT_UNUSABLE} from '../src/features/card-scanner/session/list-table';
import {openRecordedShareStream} from './recorded-share-frames';
import {planRow} from './row-read-plan';
import {createNameHold} from './name-hold';
import {settledFields} from '../src/features/card-scanner/acquisition/capture-quality';
import type {RowEvidence,RowEvidenceIdentity} from './row-evidence';
import type {ReadFieldValues} from '../src/features/card-scanner/session/field-acceptance';
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
  /** Only with name reading on (`names`): what it cost and which cards it named. */
  readonly names?:{
    /** Probe slots read in place of a probe the artwork could not name. */
    readonly substituteReads:number;
    /** Name readings run / that named a card / that named none. */
    readonly reads:number;readonly identified:number;readonly failed:number;
    /** Slots the artwork could not name that were NOT read by name: their list cell already holds a complete card. */
    readonly skippedKnown:number;
    /** Seconds a place is held after a text reading named no card (dev/name-hold.ts), and the
     * slots not read by name because of it. */
    readonly holdSeconds:number;readonly skippedHeld:number;
    /** Background name reading only (the frame loop does not wait for it): slots not read by name
     * because the one name lane was busy, and because that list cell was already named. */
    readonly background:boolean;readonly skippedBusy:number;readonly skippedNamed:number;
    /** Background name readings whose card was then placed in the list table, at the cell its own
     * frame had recorded as unidentified. */
    readonly placed:number;
    /** With evidence, background only: counts read again with the text reader because the crop's
     * own count was unconfirmed (as the scanner does), crops queued for it, and crops whose card
     * had used up its re-reads (at most 3 per card) and was recorded as read. */
    readonly countReads?:number;readonly countQueued?:number;readonly countGivenUp?:number;
    /** Crops not read in full and not recorded because the same field pixels of their card already were. */
    readonly countSame?:number;
    /** Background only: crops put in the lane's backlog, crops not queued because their cell was
     * already waiting or being read, the backlog's limit and its longest length, and the longest a
     * crop waited (ms). `skippedBusy` counts crops not queued because the backlog was full. */
    readonly queued:number;readonly skippedQueued:number;readonly backlogLimit:number;readonly longestBacklog:number;readonly backlogWaitMaxMs:number;
    readonly totalMs:number;readonly medianMs:number;readonly p95Ms:number;readonly maxMs:number;
    /** Frames with at least one name reading, and the largest number of name readings in one frame. */
    readonly frames:number;readonly maxPerFrame:number;
    /** Cards named by name reading: how many readings named each. */
    readonly cards:readonly {readonly id:string;readonly name:string;readonly reads:number}[];
    /** Every name reading, in order (at most 400): capture time, grid slot, whether its row was
     * recognised, ms since the thumb last moved, how long it took, the card named (or null),
     * whether both values were then read, and for a failure what the name reader reported. */
    readonly log:readonly {readonly time:number;readonly slot:number;readonly rowKnown:boolean;readonly settledMs:number|null;readonly ms:number;
      readonly name:string|null;readonly complete:boolean;readonly attempts?:readonly string[]}[];
    /** Crops of failed name readings (PNG data URLs, at most 24), keyed by "time slot". */
    readonly failures:Readonly<Record<string,string>>;
  };
}

/** The scanner's own name reading, for a slot the artwork matcher could not name. */
export interface RowReadNames {
  /** Name the card of a crop (the recognizer's full identify: artwork again, then the label). */
  /** `structural`: the crop's four borders line up (the scanner's border alignment of 0.8 or more).
   * The scanner then lets the name reader work on a label with few pixels and match its raw text. */
  identify(image:HTMLCanvasElement,stable:boolean,structural?:boolean):Promise<{id:string;name:string;/** The reader's whole identity, for the evidence. */full?:RowEvidenceIdentity}|null>;
  /** Whether the last identify of this crop ran the text reader (false: refused before it). */
  ranText?(image:HTMLCanvasElement):boolean;
  /** The crop's awakening and count for that card, by the visual reading alone. */
  values(image:HTMLCanvasElement,id:string):Promise<{awakening:number|null;extraCopies:number|null;/** The reader's whole values, for the evidence. */full?:ReadFieldValues}>;
  /** The crop's awakening and count read by the reader with the text reader allowed: the full
   * reading the scanner gives a crop outside its visual-only lane, or its corroborating re-read
   * of a count that is still unconfirmed. */
  count?(image:HTMLCanvasElement,id:string,/** false: the full reading; true: the corroborating re-read. */corroborate:boolean):Promise<{awakening:number|null;extraCopies:number|null;full?:ReadFieldValues}>;
  /** What the name reader tried on the crop it was last asked to identify (diagnosis only). */
  attempts?(image:HTMLCanvasElement):readonly string[];
}

export const EMPTY_REASON='미보유 카드 뒷면 · 빈 슬롯';
export const COLUMNS=10,GRID_ROWS=4;
/** Probe columns: two slots away from the row's edges and from each other. */
export const PROBE_COLUMNS=[2,7] as const;

/** What a slot of an acquired frame offers the reader. */
export interface RowReadCell {readonly usable:boolean;readonly empty:boolean;readonly image:HTMLCanvasElement|undefined;
  /** For the evidence only: the crop's field vector (to tell whether its fields matched the frame
   * before) and how well its four borders aligned. */
  readonly feature?:Uint8Array;readonly alignment?:number;
  /** The acquisition's key of the crop's raw field pixels: equal keys are byte-identical count and
   * awakening fields, so a full reading of one is the full reading of the other. */
  readonly fieldRevision?:string}
export type RowReadVisual=NonNullable<ReturnType<typeof createVisualClient>>;

/** The reading shared by the prototypes: probes, row plans, reads, the list table and the card
 * observations. A frame's cells are read according to the plan and nothing else. */
export function createRowReadSession(visuals:readonly RowReadVisual[],scrollSteps:number,
  /** After this many reads a slot this reader cannot finish (a card it cannot name, or values it
   * cannot read) counts as handed to the scanner's name reading and is not read again here.
   * Infinity keeps reading it in every frame. */
  handOverAfter=Infinity,
  /** With this, a slot the artwork cannot name is read by name, once per list cell where the
   * table can tell (see processFrame). Without it nothing changes. */
  names?:RowReadNames,
  /** Seconds a place is not read by name again after a text reading named no card. */
  nameHoldSeconds=1,
  /** Real-time use: name reading runs on one lane beside the frame loop, on a copy of the crop.
   * A frame never waits for it; crops the lane cannot take yet wait in a short backlog (one per
   * list cell), so a card is still read after its row has scrolled away. A card named this way is recorded with its capture time, and placed
   * in the list table at the cell its own frame recorded as unidentified, found again through a
   * card the same frame placed (the table may have joined or moved islands meanwhile). */
  backgroundNames=false,
  /** Whether a card the background lane named is placed in the list table (off: to measure what placing changes). */
  placeNames=true,
  /** With this, every named crop goes through the scanner's acceptance and merge (dev/row-evidence.ts),
   * and a card counts as finished for the row plan once that evidence confirms it, not after one
   * observation with both values. Without it nothing changes. */
  evidence?:RowEvidence) {
  const BACKLOG=16;
  const table=createListTable(),nameHold=createNameHold(nameHoldSeconds);
  let nameLane:Promise<void>|null=null;
  /** Crops waiting for the one background name lane, oldest first. Each is a copy, so it can be
   * read after its row has scrolled away. `cell` finds its list cell again through a card the
   * same frame placed (rows below that card, and the column). */
  type Waiting={copy:HTMLCanvasElement;time:number;slot:number;scrollRow:number|null;stable:boolean;settled:number|null;rowWasKnown:boolean;about:string;
    cell:{card:number;rows:number;column:number}|null;queuedAt:number;
    frameId:number;fieldStable:boolean;alignment:number;
    /** Set for a crop the artwork already named whose count is to be read again. */
    count?:{code:number;identity:RowEvidenceIdentity}};
  /** Count re-reads started per card. A card that stays unconfirmed is not re-read without end. */
  const countRereads=new Map<number,number>(),COUNT_REREADS=3;
  /** Per card: the field revisions already sent to the full reading. The same field pixels are
   * not read again and not recorded again (a repeat of the same pixels is not another observation). */
  const fullyRead=new Map<number,Set<string>>();
  const backlog:Waiting[]=[];
  let inFlight:Waiting|null=null;
  const cellOf=(item:{cell:Waiting['cell']})=>{
    if(!item.cell)return null;
    const beside=table.locate(item.cell.card);
    return beside?{island:beside.island,row:beside.row+item.cell.rows,column:item.cell.column}:null;
  };
  /** Work through the backlog, one crop at a time. */
  const runLane=async()=>{
    // The count re-read of a card that is already confirmed waits behind everything else: it
    // guards against a changed count and names nothing, while a full reading can hold the lane
    // for seconds and crops waiting for a name scroll away.
    const take=()=>{
      const index=backlog.findIndex(item=>!(item.count&&done(item.count.code)));
      return index>0?backlog.splice(index,1)[0]:backlog.shift();
    };
    for(let item=take();item;item=take()){
      inFlight=item;
      try{
        if(item.count){
          // The scanner's re-read of an unconfirmed count: one crop, one observation, recorded after it.
          const {code,identity}=item.count;
          // A confirmed card's crop is read too: the count may have changed since, and dropping the
          // re-read would let a later crop of the same card be accepted on its visual reading alone.
          const began=performance.now();nameStats.waitMs.push(began-item.queuedAt);
          let values=await names!.count!(item.copy,identity.id,false);nameStats.countReads++;
          if(values.full&&evidence!.needsCountReread({identity,values:values.full,stable:item.fieldStable,borderAlignment:item.alignment})){
            values=await names!.count!(item.copy,identity.id,true);nameStats.countReads++;
          }
          nameStats.ms.push(performance.now()-began);
          const accepted=evidence!.accept({identity,values:values.full??null,time:item.time,slot:item.slot,frameId:item.frameId,stable:item.fieldStable,borderAlignment:item.alignment,image:item.copy});
          cards[code].observations.push({time:item.time,awakening:accepted.awakening,extraCopies:accepted.extraCopies});
          if(accepted.awakening!==null&&accepted.extraCopies!==null)complete.add(code);
          continue;
        }
        // Named meanwhile from another frame's crop of the same cell: nothing left to do.
        const at=cellOf(item),now=at?table.cellAt(at.island,at.row,at.column):null;
        if(now?.state==='card'&&now.card!==null&&done(now.card)){nameStats.skippedNamed++;continue;}
        const began=performance.now();nameStats.waitMs.push(began-item.queuedAt);
        const identity=await names!.identify(item.copy,item.stable,item.alignment>=.8);
        let values=identity?await names!.values(item.copy,identity.id):null;
        if(evidence&&identity?.full&&values?.full&&names!.count&&
            evidence.needsCountReread({identity:identity.full,values:values.full,stable:item.fieldStable,borderAlignment:item.alignment})){
          values=await names!.count(item.copy,identity.id,true);nameStats.countReads++;
        }
        const took=performance.now()-began,both=!!values&&values.awakening!==null&&values.extraCopies!==null;
        nameStats.ms.push(took);nameStats.reads++;
        if(nameStats.log.length<400)nameStats.log.push({time:item.time,slot:item.slot,rowKnown:item.rowWasKnown,settledMs:item.settled,ms:Math.round(took),name:identity?.name??null,complete:both,
          ...(identity?{}:{attempts:names!.attempts?.(item.copy)??[]})});
        if(!identity){nameStats.failed++;if(names!.ranText?.(item.copy)??true)nameHold.refused(item.scrollRow,item.slot,item.time);continue;}
        nameStats.identified++;nameStats.cards.set(identity.id,(nameStats.cards.get(identity.id)??0)+1);
        let code=codes.get(identity.id);
        if(code===undefined){code=cards.length;codes.set(identity.id,code);cards.push({id:identity.id,name:identity.name,firstTime:item.time,observations:[]});}
        const accepted=evidence&&identity.full?evidence.accept({identity:identity.full,values:values?.full??null,time:item.time,slot:item.slot,frameId:item.frameId,
          stable:item.fieldStable,borderAlignment:item.alignment,image:item.copy}):null;
        cards[code].observations.push({time:item.time,awakening:accepted?accepted.awakening:values?.awakening??null,extraCopies:accepted?accepted.extraCopies:values?.extraCopies??null});
        if(accepted?accepted.awakening!==null&&accepted.extraCopies!==null:both)complete.add(code);
        // The cell this crop came from, by the card its frame placed beside it.
        const where=cellOf(item);
        if(placeNames&&where&&table.nameCell(where.island,where.row,where.column,code,item.time))nameStats.placed++;
      }catch{nameStats.failed++;}
      finally{item.copy.width=0;inFlight=null;}
    }
  };
  const nameStats={substituteReads:0,reads:0,identified:0,failed:0,skippedKnown:0,skippedHeld:0,skippedBusy:0,skippedNamed:0,skippedQueued:0,queued:0,countReads:0,countQueued:0,countGivenUp:0,countSame:0,longestBacklog:0,waitMs:[] as number[],placed:0,frames:0,maxPerFrame:0,ms:[] as number[],cards:new Map<string,number>(),
    log:[] as {time:number;slot:number;rowKnown:boolean;settledMs:number|null;ms:number;name:string|null;complete:boolean;attempts?:readonly string[]}[],failures:{} as Record<string,string>};
  const codes=new Map<string,number>(),cards:{id:string;name:string;firstTime:number;observations:LeanObservation[]}[]=[];
  // A card is complete for this reader once one observation gave both of its values.
  const complete=new Set<number>();
  /** Whether a card needs no more reading: confirmed by the evidence when there is one. */
  const done=(code:number)=>evidence?evidence.confirmed(cards[code].id):complete.has(code);
  /** Frames processed, and the field vectors of the frame before (the scanner's `stable` test). */
  let frameNumber=0,previousFeatures:Uint8Array[]=[];
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
    cellAt:table.cellAt,complete:card=>done(card)||cards[card].observations.length>=handOverAfter,
    handedOver:cell=>cell.looks>=handOverAfter});
  return {
    table,stats,readAll,planRow:plan,
    /** Resolves when the background name lane has nothing in flight. */
    async namesIdle(){while(nameLane)await nameLane;},
    names(){
      if(!names)return undefined;
      const sorted=[...nameStats.ms].sort((a,b)=>a-b),at=(share:number)=>sorted.length?Math.round(sorted[Math.min(sorted.length-1,Math.floor(share*sorted.length))]):0;
      return {substituteReads:nameStats.substituteReads,reads:nameStats.reads,identified:nameStats.identified,failed:nameStats.failed,skippedKnown:nameStats.skippedKnown,holdSeconds:nameHoldSeconds,skippedHeld:nameStats.skippedHeld,
        background:backgroundNames,skippedBusy:nameStats.skippedBusy,skippedNamed:nameStats.skippedNamed,placed:nameStats.placed,
        ...(evidence?{countReads:nameStats.countReads,countQueued:nameStats.countQueued,countGivenUp:nameStats.countGivenUp,countSame:nameStats.countSame}:{}),
        queued:nameStats.queued,skippedQueued:nameStats.skippedQueued,backlogLimit:BACKLOG,longestBacklog:nameStats.longestBacklog,backlogWaitMaxMs:Math.round(Math.max(0,...nameStats.waitMs)),
        totalMs:Math.round(sorted.reduce((a,b)=>a+b,0)),medianMs:at(.5),p95Ms:at(.95),maxMs:at(1),frames:nameStats.frames,maxPerFrame:nameStats.maxPerFrame,
        cards:[...nameStats.cards].map(([id,reads])=>({id,name:cards[codes.get(id)!].name,reads})).sort((a,b)=>b.reads-a.reads),
        log:nameStats.log,failures:nameStats.failures};
    },
    cards:()=>[...cards].sort((a,b)=>a.firstTime-b.firstTime),
    /** The code of a card already seen, without recording anything (the light check's probes). */
    knownCode:(id:string)=>codes.get(id)??null,
    /** Read one acquired frame by the row plan and record it in the table. */
    async processFrame(time:number,cells:readonly RowReadCell[],thumb:{position:number|null;settledMs:number|null}):Promise<void> {
      const usable=(slot:number)=>cells[slot].usable&&!!cells[slot].image;
      stats.usableCrops+=cells.filter((_,slot)=>usable(slot)).length;
      const slots:number[]=cells.map(cell=>cell.empty?SLOT_EMPTY:SLOT_UNUSABLE);
      /** Record what a read slot showed: its code for the table and its values for the card. */
      frameNumber++;
      const features=cells.map(cell=>cell.feature??new Uint8Array(0));
      const fieldStable=(slot:number)=>features[slot].length>0&&settledFields(features[slot],slot,previousFeatures);
      const recordCard=(slot:number,identity:{id:string;name:string},values:{awakening:number|null;extraCopies:number|null}|null,
        whole?:{identity:RowEvidenceIdentity;values:ReadFieldValues|null})=>{
        let code=codes.get(identity.id);
        if(code===undefined){code=cards.length;codes.set(identity.id,code);cards.push({id:identity.id,name:identity.name,firstTime:time,observations:[]});}
        slots[slot]=code;
        // A count the visual reading leaves unconfirmed is read in full (text reader allowed) before the
        // crop is accepted, as the scanner does outside its visual-only lane. That reading goes to the
        // name lane on a copy; this crop is then accepted there, once.
        if(evidence&&whole&&backgroundNames&&names?.count&&!whole.identity.review.length&&
            evidence.countUnconfirmed({identity:whole.identity,values:whole.values,stable:fieldStable(slot),borderAlignment:cells[slot].alignment??0})){
          const tried=countRereads.get(code)??0,revision=cells[slot].fieldRevision;
          if(revision&&fullyRead.get(code)?.has(revision)){
            // These field pixels were already read in full for this card.
            nameStats.countSame++;
            cards[code].observations.push({time,awakening:values?.awakening??null,extraCopies:null});
            return code;
          }
          const waitingAlready=[...backlog,...(inFlight?[inFlight]:[])].some(item=>item.count?.code===code);
          if(tried>=COUNT_REREADS)nameStats.countGivenUp++;
          else if(waitingAlready||backlog.length>=BACKLOG){
            // Its card is already being re-read, or there is no room: this crop is not recorded
            // (an unconfirmed count adds nothing the re-read will not).
            if(!waitingAlready)nameStats.skippedBusy++;
            cards[code].observations.push({time,awakening:values?.awakening??null,extraCopies:null});
            return code;
          }else{
            const source=cells[slot].image!,copy=Object.assign(document.createElement('canvas'),{width:source.width,height:source.height});
            copy.getContext('2d',{willReadFrequently:true})!.drawImage(source,0,0);
            backlog.push({copy,time,slot,scrollRow:null,stable:false,settled:null,rowWasKnown:false,about:`count:${code}`,cell:null,queuedAt:performance.now(),
              frameId:frameNumber,fieldStable:fieldStable(slot),alignment:cells[slot].alignment??0,count:{code,identity:whole.identity}});
            countRereads.set(code,tried+1);nameStats.countQueued++;
            if(revision){const seen=fullyRead.get(code)??new Set<string>();fullyRead.set(code,seen);seen.add(revision);}nameStats.longestBacklog=Math.max(nameStats.longestBacklog,backlog.length);
            if(!nameLane)nameLane=runLane().finally(()=>{nameLane=null;});
            cards[code].observations.push({time,awakening:values?.awakening??null,extraCopies:null});
            return code;
          }
        }
        // With evidence the values are the accepted ones (an unconfirmed zero is unread).
        const accepted=evidence&&whole?evidence.accept({identity:whole.identity,values:whole.values,time,slot,frameId:frameNumber,
          stable:fieldStable(slot),borderAlignment:cells[slot].alignment??0,image:cells[slot].image??undefined}):null;
        const awakening=accepted?accepted.awakening:values?.awakening??null,extraCopies=accepted?accepted.extraCopies:values?.extraCopies??null;
        cards[code].observations.push({time,awakening,extraCopies});
        if(awakening!==null&&extraCopies!==null)complete.add(code);
        return code;
      };
      /** Slots the artwork reading looked at and could not name, in the order read. */
      const unnamed:number[]=[];
      const record=(slot:number,result:VisualResult|null)=>{
        if(!result?.identity){slots[slot]=SLOT_UNIDENTIFIED;unnamed.push(slot);return null;}
        return recordCard(slot,result.identity,result.values,{identity:result.identity,values:result.values});
      };
      // 1. Probes of all four visible rows.
      const probeSlots=Array.from({length:GRID_ROWS},(_,row)=>PROBE_COLUMNS.map(column=>row*COLUMNS+column)).flat().filter(usable);
      const probeResults=await readAll(probeSlots.map(slot=>cells[slot].image!));
      stats.probeReads+=probeSlots.length;
      const probeCode=new Map<number,number|null>();
      probeSlots.forEach((slot,index)=>probeCode.set(slot,record(slot,probeResults[index])));
      // 1b. With name reading: a probe the artwork cannot name (a look-alike card sits there in every
      // frame) is replaced by the next slots to its right, so the row can still be recognised.
      const probeColumns=Array.from({length:GRID_ROWS},()=>[...PROBE_COLUMNS] as number[]);
      if(names)for(let step=1;step<=2;step++){
        const wanted:{row:number;index:number;slot:number}[]=[];
        for(let row=0;row<GRID_ROWS;row++)probeColumns[row].forEach((column,index)=>{
          const slot=row*COLUMNS+column,next=row*COLUMNS+PROBE_COLUMNS[index]+step;
          if(usable(slot)&&probeCode.get(slot)===null&&usable(next)&&!probeCode.has(next))wanted.push({row,index,slot:next});
        });
        if(!wanted.length)break;
        const results=await readAll(wanted.map(item=>cells[item.slot].image!));
        nameStats.substituteReads+=wanted.length;stats.probeReads+=wanted.length;
        wanted.forEach((item,index)=>{probeCode.set(item.slot,record(item.slot,results[index]));probeColumns[item.row][item.index]=item.slot%COLUMNS;});
      }
      // 2. Per row: what else has to be read.
      const more:number[]=[],rowKnown:({island:number;row:number}|null)[]=[];
      for(let row=0;row<GRID_ROWS;row++){
        const rowPlan=names?planRow({columns:COLUMNS,
          probes:probeColumns[row].map(column=>{const card=probeCode.get(row*COLUMNS+column)??null;return {column,card,place:card===null?null:table.locate(card)};}),
          usable:new Set(Array.from({length:COLUMNS},(_,column)=>column).filter(column=>usable(row*COLUMNS+column))),
          cellAt:table.cellAt,complete:card=>done(card)||cards[card].observations.length>=handOverAfter,handedOver:cell=>cell.looks>=handOverAfter})
          :plan(row,slot=>probeCode.get(slot)??null,usable);
        rowKnown.push(rowPlan.known);
        // A slot already read in this frame as a probe is not read again.
        const read=rowPlan.read.filter(column=>!probeCode.has(row*COLUMNS+column));
        if(!rowPlan.known)stats.rowsWhole++;else if(read.length)stats.rowsPartly++;else stats.rowsSkipped++;
        for(const column of read)more.push(row*COLUMNS+column);
      }
      const moreResults=await readAll(more.map(slot=>cells[slot].image!));
      stats.neededReads+=more.length;
      more.forEach((slot,index)=>{record(slot,moreResults[index]);});
      // 2b. Name reading of the slots the artwork could not name. Where the row is recognised and the
      // table already holds a complete card at that cell, the slot was named in an earlier frame
      // and is left alone: the table saves the work, it does not supply this frame's card.
      /** Slots for the background name lane, queued once the table has this frame. */
      const waiting:{slot:number;rowWasKnown:boolean;about:string}[]=[];
      const scrollRow=thumb.position===null?null:Math.round(thumb.position*scrollSteps);
      if(names){
        let inFrame=0;
        for(const slot of unnamed){
          const known=rowKnown[Math.floor(slot/COLUMNS)],cell=known?table.cellAt(known.island,known.row,slot%COLUMNS):null;
          if(cell?.state==='card'&&cell.card!==null&&done(cell.card)){nameStats.skippedKnown++;continue;}
          if(nameHold.held(scrollRow,slot,time)){nameStats.skippedHeld++;continue;}
          if(backgroundNames){
            waiting.push({slot,rowWasKnown:!!known,about:scrollRow===null?`?:${slot}`:`${scrollRow+Math.floor(slot/COLUMNS)}:${slot%COLUMNS}`});
            continue;
          }
          const image=cells[slot].image!,started=performance.now();
          const identity=await names.identify(image,(thumb.settledMs??0)>=200,(cells[slot].alignment??0)>=.8);
          const values=identity?await names.values(image,identity.id):null;
          const took=performance.now()-started;
          nameStats.ms.push(took);nameStats.reads++;inFrame++;
          if(nameStats.log.length<400)nameStats.log.push({time,slot,rowKnown:!!known,settledMs:thumb.settledMs===null?null:Math.round(thumb.settledMs),ms:Math.round(took),
            name:identity?.name??null,complete:!!values&&values.awakening!==null&&values.extraCopies!==null,...(identity?{}:{attempts:names.attempts?.(image)??[]})});
          if(!identity){
            nameStats.failed++;
            if(names.ranText?.(image)??true)nameHold.refused(scrollRow,slot,time);
            if(Object.keys(nameStats.failures).length<24)nameStats.failures[`${time.toFixed(2)} ${slot}`]=image.toDataURL('image/png');
            continue;
          }
          nameStats.identified++;nameStats.cards.set(identity.id,(nameStats.cards.get(identity.id)??0)+1);
          recordCard(slot,identity,values,identity.full?{identity:identity.full,values:values?.full??null}:undefined);
        }
        if(inFrame){nameStats.frames++;nameStats.maxPerFrame=Math.max(nameStats.maxPerFrame,inFrame);}
      }
      // 3. The table sees only what was read in this frame.
      table.observe({time,thumbRow:thumb.position===null?null:Math.round(thumb.position*scrollSteps),settledMs:thumb.settledMs,slots});
      // Queue this frame's crops for the name lane. The frame is in the table now, so each crop's
      // list cell is found through a card the same frame placed; a cell that already has its card,
      // or is already waiting, is not queued again.
      for(const candidate of waiting){
        const row=Math.floor(candidate.slot/COLUMNS),column=candidate.slot%COLUMNS;
        let cell:Waiting['cell']=null,named=false;
        for(let other=0;other<slots.length&&!cell&&!named;other++){
          if(slots[other]<0)continue;
          const at=table.locate(slots[other]);
          if(!at||at.column!==other%COLUMNS)continue;
          const rows=row-Math.floor(other/COLUMNS),seen=table.cellAt(at.island,at.row+rows,column);
          if(!seen||seen.lastTime!==time)continue;                  // not the cell this frame wrote
          if(seen.state==='card'&&seen.card!==null&&done(seen.card))named=true;
          else if(seen.state!=='empty')cell={card:slots[other],rows,column};
        }
        if(named){nameStats.skippedNamed++;continue;}
        const where=cellOf({cell});
        const twin=[...backlog,...(inFlight?[inFlight]:[])].some(old=>{
          const there=cellOf(old);
          return where&&there?there.island===where.island&&there.row===where.row&&there.column===where.column:!where&&!there&&old.about===candidate.about;
        });
        if(twin){nameStats.skippedQueued++;continue;}
        if(backlog.length>=BACKLOG){nameStats.skippedBusy++;continue;}
        const source=cells[candidate.slot].image!,copy=Object.assign(document.createElement('canvas'),{width:source.width,height:source.height});
        copy.getContext('2d',{willReadFrequently:true})!.drawImage(source,0,0);
        backlog.push({copy,time,slot:candidate.slot,scrollRow,stable:(thumb.settledMs??0)>=200,settled:thumb.settledMs===null?null:Math.round(thumb.settledMs),
          rowWasKnown:candidate.rowWasKnown,about:candidate.about,cell,queuedAt:performance.now(),
          frameId:frameNumber,fieldStable:fieldStable(candidate.slot),alignment:cells[candidate.slot].alignment??0});
        nameStats.queued++;nameStats.longestBacklog=Math.max(nameStats.longestBacklog,backlog.length);
      }
      if(backlog.length&&!nameLane)nameLane=runLane().finally(()=>{nameLane=null;});
      previousFeatures=features;
    },
    /** What to show again, from the table and the cards not confirmed yet (session/list-guidance.ts).
     * `totalRows`: rows of the whole list. Without the evidence merge a card counts as confirmed
     * once it has an observation with both values. */
    guidance(totalRows:number){
      const unconfirmed=new Map<number,{name:string;reasons:readonly string[]}>();
      if(evidence){
        for(const card of evidence.summary().cards)if(!card.confirmed){const code=codes.get(card.id);if(code!==undefined)unconfirmed.set(code,{name:card.name,reasons:card.review});}
      }else cards.forEach((card,code)=>{if(!complete.has(code))unconfirmed.set(code,{name:card.name,reasons:['각성·장수 확인']});});
      return listGuidance(table.snapshot(),{totalRows,unconfirmed});
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
      await session.processFrame(frame.time,acquired.cells.map(cell=>({usable:cell.quality.usable,empty:cell.quality.reason===EMPTY_REASON,image:cell.image})),thumb);
      release();
      if(frames%20===0)options.onProgress?.(`줄 중심 판독 · ${frames}/${stream.frameCount}프레임 · 카드 ${session.cards().length} · 읽은 크롭 ${session.stats.probeReads+session.stats.neededReads}`);
    }
    return {frames,locatedFrames:located,wallMs:Math.round(performance.now()-started),...session.stats,scrollSteps,table:session.summary(),cards:session.cards(),...(names?{names:session.names()}:{})};
  }finally{acquisition.dispose();for(const visual of visuals)visual?.dispose();await recognizer?.dispose();}
}
