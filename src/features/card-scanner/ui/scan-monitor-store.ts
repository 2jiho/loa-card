import type {ScanGridCell,ScanGridSnapshot} from '../session/scan-grid';
import {scanMonitorInputFacts} from '../session/scan-monitor-outcome';
import type {ScannerFeedback} from './scanner-feedback';
import type {AutoCompletionDiagnostic} from '../session/auto-completion-diagnostics';
import type {LiveObstructionHint} from '../session/live-obstruction-hint';

interface MonitorStateSource {
  grid?: ScanGridSnapshot;
  currentRunRead?: number;
  currentRunNames?: number;
  review?: number;
  cards?: readonly {review: readonly string[]}[];
  expected: number | null;
  capacity: number | null;
  interrupted?: 'stalled' | 'cancelled' | 'failed';
  queued?: number;
  activeReadings?: number;
  unresolvedFieldChanges?: number;
  autoCompletionDiagnostic?: AutoCompletionDiagnostic;
  droppedFrames?: number;
  headerConflict?: boolean;
  sampled?: number;
  unidentified?: readonly unknown[];
  unresolvedObservations?: number;
}

export type ScanMonitorState=Pick<MonitorStateSource,'grid'|'currentRunRead'|'currentRunNames'|'review'|'expected'|'capacity'|'interrupted'> &
  Partial<Pick<MonitorStateSource,'queued'|'activeReadings'|'unresolvedFieldChanges'|'autoCompletionDiagnostic'|'droppedFrames'|'headerConflict'>> & {unresolvedCount?:number;unresolvedCountUnavailable?:true;hasInput?:boolean;unresolvedFieldChangesUnavailable?:true;liveObstructionHint?:LiveObstructionHint};
export type ScanMonitorInput=ScanMonitorState & Partial<Pick<MonitorStateSource,'sampled'|'unidentified'|'unresolvedObservations'|'cards'>>;

/** Raw scanner state and lightweight feedback share the same image-free view. */
export function projectScanMonitorState(state:ScanMonitorInput):ScanMonitorState {
 const review=state.review??(state.cards?.some(card=>Array.isArray(card?.review))
   ?state.cards.filter(card=>Array.isArray(card?.review)&&card.review.length>0).length:undefined);
 return {grid:state.grid,currentRunRead:state.currentRunRead,
  ...(state.currentRunNames===undefined?{}:{currentRunNames:state.currentRunNames}),...(review===undefined?{}:{review}),
  expected:state.expected,capacity:state.capacity,interrupted:state.interrupted,
  queued:state.queued,activeReadings:state.activeReadings,...(state.autoCompletionDiagnostic?{autoCompletionDiagnostic:state.autoCompletionDiagnostic}:{}),
  ...(state.liveObstructionHint?{liveObstructionHint:state.liveObstructionHint}:{}),...scanMonitorInputFacts(state)};
}

function sameCell(a:ScanGridCell|undefined,b:ScanGridCell|undefined) {
  return a===b||!!a&&!!b&&a.status===b.status&&a.reason===b.reason&&a.row===b.row&&a.historical===b.historical;
}
function shareCells(previous:ScanGridCell[]|undefined,next:ScanGridCell[]|undefined) {
  if(!previous||!next||previous===next)return next;
  let unchanged=previous.length===next.length;
  const cells=next.map((cell,index)=>{
    if(sameCell(previous[index],cell))return previous[index];
    unchanged=false;return cell;
  });
  return unchanged?previous:cells;
}
/** Canonicalize display values only. Fresh failed proof may revoke any green
 * marker, and position/reason changes are just as significant as new reads. */
function shareGrid(previous:ScanGridSnapshot|undefined,next:ScanGridSnapshot|undefined) {
  if(!previous||!next||previous===next)return next;
  // begin() clears the current cells before the next record(). Keep the last
  // committed display cells so the live map does not blink unknown every frame.
  const cleared=next.cells.length===40&&next.cells.every(cell=>cell.status==='unknown');
  const cells=cleared&&previous.cells.some(cell=>cell.status!=='unknown')?previous.cells:shareCells(previous.cells,next.cells)!;
  const inventory=shareCells(previous.inventory,next.inventory);
  const a=previous.recent,b=next.recent;
  const sameRecent=b===undefined||a===b||!!a&&!!b&&a.captured===b.captured&&a.read===b.read&&a.waiting===b.waiting&&(a.reading??0)===(b.reading??0)&&a.review===b.review;
  const recent=sameRecent?a:b;
  const oldFrame=previous.recentFrame,newFrame=next.recentFrame;
  const frameCells=shareCells(oldFrame?.cells,newFrame?.cells);
  // Retain the last committed frame across the same begin()/record() gap.
  const recentFrame=newFrame?oldFrame&&newFrame.frame===oldFrame.frame&&newFrame.capturedTop===oldFrame.capturedTop&&frameCells===oldFrame.cells?oldFrame:{...newFrame,cells:frameCells!}:oldFrame;
  if(cells===previous.cells&&inventory===previous.inventory&&sameRecent&&recentFrame===oldFrame&&
    next.located===previous.located&&next.totalRows===previous.totalRows&&next.estimatedTop===previous.estimatedTop&&
    next.liveTop===previous.liveTop&&next.liveTracking===previous.liveTracking)return previous;
  return {...next,cells,inventory,recent,...(recentFrame?{recentFrame}:{})};
}

/** The small progress window publishes independently of the card-list transition.
 * Retains no card crops, recording pixels, or recognition evidence. */
export function createScanMonitorStore(options:{notifyIntervalMs?:number}={}) {
  let value:ScanMonitorState|null=null;
  let liveObstructionHint:LiveObstructionHint|undefined;
  let feedback:ScannerFeedback|undefined;
  // Display-only hold: liveTop can be briefly absent at a frame boundary even
  // though the user is still looking at the same rows. Do not blank the map.
  let stableLiveTop:number|undefined, stableLiveTracking=false;
  const listeners=new Set<()=>void>();
  const notifyInterval=options.notifyIntervalMs??0;
  let notifyTimer:ReturnType<typeof setTimeout>|undefined;
  const flush=()=>{notifyTimer=undefined;listeners.forEach(listener=>listener());};
  const notify=(immediate=false)=>{
    if(notifyInterval<=0||immediate){if(notifyTimer!==undefined){clearTimeout(notifyTimer);notifyTimer=undefined;}flush();return;}
    if(notifyTimer===undefined)notifyTimer=setTimeout(flush,notifyInterval);
  };
  return {
    getSnapshot:()=>value,
    getFeedback:()=>feedback,
    setFeedback(next:ScannerFeedback|undefined){
      if(feedback===next)return;
      try{feedback?.cancel();}catch{/* Optional collector teardown cannot affect display. */}
      feedback=next;
    },
    subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    /** UI-only: does not touch grid, inventory, or feedback recording. */
    publishAutoCompletion(next:AutoCompletionDiagnostic){
      if(!value||value.autoCompletionDiagnostic?.gate===next.gate)return;
      value={...value,autoCompletionDiagnostic:next};notify(true);
    },
    /** An advisory only: this lane never changes grid or scan evidence. */
    publishLiveObstructionHint(next:LiveObstructionHint){
      if(liveObstructionHint&&(next.sessionId!==liveObstructionHint.sessionId||next.inputId<=liveObstructionHint.inputId))return;
      liveObstructionHint=next;
      if(value){value={...value,liveObstructionHint:next};notify(true);}
    },
    publish(input:ScanMonitorInput) {
      let next=projectScanMonitorState(input);
      const gridTop=next.grid?.liveTop;
      const top=next.grid?.liveTracking&&typeof gridTop==='number'&&Number.isInteger(gridTop)&&gridTop>=1&&gridTop<=52
        ?gridTop:undefined;
      if(top!==undefined){stableLiveTop=top;stableLiveTracking=true;}
      else if(next.grid&&stableLiveTracking&&stableLiveTop!==undefined&&
        (next.grid.liveTop===undefined||next.grid.recentFrame===undefined)){
        // Keep the last known row visible across frame boundaries. A newer
        // scroll position replaces it immediately; clearing the store resets it.
        next={...next,grid:{...next.grid,liveTracking:true,liveTop:stableLiveTop}};
      }else if(next.grid?.liveTracking===false&&next.grid.liveTop!==undefined){
        // An explicit stop with a real row is not a transient frame boundary.
        stableLiveTop=undefined;stableLiveTracking=false;
      }
      if(liveObstructionHint)next.liveObstructionHint=liveObstructionHint;
      // Lightweight grid updates may have been produced before the latest
      // diagnostic. Only the dedicated lane owns the current UI gate.
      if(value?.autoCompletionDiagnostic)next.autoCompletionDiagnostic=value.autoCompletionDiagnostic;
      const grid=shareGrid(value?.grid,next.grid);
      // Explicit transport through a newly allocated canonical clone. Reusing
      // an old equal grid must never lend its markers to a newer source/attempt.
      if(grid&&next.grid&&grid!==next.grid&&grid!==value?.grid){
        try{feedback?.grid(grid,[],next.grid);}catch{/* Exact sidecar transfer is optional. */}
      }
      if(value&&value.grid===grid&&value.currentRunRead===next.currentRunRead&&value.currentRunNames===next.currentRunNames&&
        value.review===next.review&&value.expected===next.expected&&
        value.capacity===next.capacity&&value.interrupted===next.interrupted&&
        (value.queued??0)===(next.queued??0)&&(value.activeReadings??0)===(next.activeReadings??0)&&
        value.unresolvedCount===next.unresolvedCount&&value.unresolvedCountUnavailable===next.unresolvedCountUnavailable&&
        value.droppedFrames===next.droppedFrames&&value.hasInput===next.hasInput&&value.headerConflict===next.headerConflict&&
        value.unresolvedFieldChanges===next.unresolvedFieldChanges&&value.unresolvedFieldChangesUnavailable===next.unresolvedFieldChangesUnavailable){
        try{feedback?.publish(value,grid,true);}catch{/* Diagnostics do not create notifications. */}
        return;
      }
      value={...next,grid};
      try{feedback?.publish(value,grid);}catch{/* Display acceptance is independent of timing. */}
      notify();
    },
    clear(){try{feedback?.cancel();}catch{/* Display clear is independent of timing. */}feedback=undefined;liveObstructionHint=undefined;
      stableLiveTop=undefined;stableLiveTracking=false;if(value){value=null;notify(true);}},
  };
}
export type ScanMonitorStore=ReturnType<typeof createScanMonitorStore>;
