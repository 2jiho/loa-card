/** Development experiment: choose WHICH pending frozen frames to keep and to
 * acquire next from row coverage, instead of arrival order.
 *
 * Pure and deterministic: no clock, pixels, timers or callbacks. Row numbers
 * come from the frozen scrollbar hint, so they are scheduling hints only. They
 * are never card, absolute-position, freshness or completion evidence, and a
 * covered row here never replaces the scanner's own evidence. Frames without a
 * hint score zero and fall back to newest-first. */

export interface CoverageSelection {readonly rowStart:number;readonly rowCount:number}
export interface CoverageCandidate {
  readonly inputId:number;
  readonly capturedAt:number;
  readonly estimatedBytes:number;
  readonly selection:CoverageSelection|null;
}

export const COVERAGE_ROWS=55;
export const COVERAGE_COLUMNS=10;
const FULL_MASK=(1<<COVERAGE_COLUMNS)-1;

function bits(mask:number):number {
  let count=0;
  for(let value=mask&FULL_MASK;value;value&=value-1)count++;
  return count;
}

export interface CoverageFrameSelector {
  /** Keep the incoming frame plus the most useful older ones within the
   * count and byte budget. The result is ordered by capture time. */
  retain<T extends CoverageCandidate>(incoming:T,pending:readonly T[],maxPending:number,budgetBytes:number):T[];
  /** Choose the next frame to acquire. Older candidates are dropped so that
   * acquisition order stays monotonic in capture time. */
  choose<T extends CoverageCandidate>(pending:readonly T[]):{chosen:T;dropped:T[]};
  /** The frame that is now being acquired (null for an unhinted frame). */
  started(selection:CoverageSelection|null):void;
  /** Cells of the started frame that were accepted, empty or duplicate. A
   * false slot (incomplete border, rejected) stays uncovered. */
  outcome(slots:readonly boolean[]):void;
  /** Forget all row coverage, for example when the inventory changes. */
  reset():void;
  snapshot():Readonly<{complete:number;partial:number;none:number;chosen:number;dropped:number;scored:number}>;
}

export function createCoverageFrameSelector():CoverageFrameSelector {
  const rows=new Array<number>(COVERAGE_ROWS).fill(0);
  let current:CoverageSelection|null=null,chosen=0,droppedCount=0,scored=0;
  const gain=(selection:CoverageSelection|null):number=>{
    if(!selection)return 0;
    let total=0;
    const end=Math.min(COVERAGE_ROWS,selection.rowStart+selection.rowCount);
    for(let row=Math.max(0,selection.rowStart);row<end;row++)total+=COVERAGE_COLUMNS-bits(rows[row]);
    return total;
  };
  /** Higher is better. Ties favour the newer frame, then the larger input id. */
  const better=(a:CoverageCandidate,b:CoverageCandidate):boolean=>{
    const ga=gain(a.selection),gb=gain(b.selection);
    if(ga!==gb)return ga>gb;
    if(a.capturedAt!==b.capturedAt)return a.capturedAt>b.capturedAt;
    return a.inputId>b.inputId;
  };
  return {
    retain<T extends CoverageCandidate>(incoming:T,pending:readonly T[],maxPending:number,budgetBytes:number):T[] {
      scored+=pending.length;
      const kept:T[]=[];
      let bytes=incoming.estimatedBytes;
      if(bytes>budgetBytes)return [];
      // maxPending counts the incoming frame, like the arrival-order policy.
      for(const candidate of [...pending].sort((a,b)=>better(a,b)?-1:better(b,a)?1:0)){
        if(kept.length>=maxPending-1)break;
        if(bytes+candidate.estimatedBytes>budgetBytes)continue;
        kept.push(candidate);bytes+=candidate.estimatedBytes;
      }
      return [...kept,incoming].sort((a,b)=>a.capturedAt-b.capturedAt||a.inputId-b.inputId);
    },
    choose<T extends CoverageCandidate>(pending:readonly T[]):{chosen:T;dropped:T[]} {
      if(pending.length===0)throw new Error('No pending frame to choose');
      let best=pending[0];
      for(const candidate of pending.slice(1))if(better(candidate,best))best=candidate;
      const dropped=pending.filter(candidate=>candidate!==best&&(candidate.capturedAt<best.capturedAt||
        candidate.capturedAt===best.capturedAt&&candidate.inputId<best.inputId));
      chosen++;droppedCount+=dropped.length;
      return {chosen:best,dropped};
    },
    started(selection:CoverageSelection|null) {current=selection;},
    outcome(slots:readonly boolean[]) {
      const selection=current;current=null;
      if(!selection)return;
      for(let index=0;index<slots.length;index++){
        if(!slots[index])continue;
        const row=selection.rowStart+Math.floor(index/COVERAGE_COLUMNS);
        if(row<0||row>=COVERAGE_ROWS)continue;
        rows[row]|=1<<(index%COVERAGE_COLUMNS);
      }
    },
    reset() {rows.fill(0);current=null;},
    snapshot() {
      let complete=0,partial=0,none=0;
      for(const mask of rows){
        if((mask&FULL_MASK)===FULL_MASK)complete++;else if(mask&FULL_MASK)partial++;else none++;
      }
      return Object.freeze({complete,partial,none,chosen,dropped:droppedCount,scored});
    },
  };
}

/** Development-only opt-in, read once per scan: `?selector=coverage`. */
export function devCoverageSelectorRequested():boolean {
  try{return typeof location!=='undefined'&&new URLSearchParams(location.search).get('selector')==='coverage';}
  catch{return false;}
}
