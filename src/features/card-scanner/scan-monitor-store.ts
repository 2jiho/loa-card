import type {ScannerState} from './scanner';
import type {ScanGridCell,ScanGridSnapshot} from './scan-grid';
import {scanMonitorInputFacts} from './scan-monitor-outcome';
import type {ScannerFeedback} from './scanner-feedback';

export type ScanMonitorState=Pick<ScannerState,'grid'|'currentRunRead'|'expected'|'capacity'|'interrupted'> &
  Partial<Pick<ScannerState,'queued'|'activeReadings'|'unresolvedFieldChanges'>> & {unresolvedCount?:number;hasInput?:boolean;unresolvedFieldChangesUnavailable?:true};
export type ScanMonitorInput=ScanMonitorState & Partial<Pick<ScannerState,'sampled'|'unidentified'>>;

/** Raw scanner state and lightweight feedback share the same image-free view. */
export function projectScanMonitorState(state:ScanMonitorInput):ScanMonitorState {
 return {grid:state.grid,currentRunRead:state.currentRunRead,expected:state.expected,capacity:state.capacity,interrupted:state.interrupted,
  queued:state.queued,activeReadings:state.activeReadings,...scanMonitorInputFacts(state)};
}

function sameCell(a:ScanGridCell|undefined,b:ScanGridCell|undefined) {
  return a===b||!!a&&!!b&&a.status===b.status&&a.reason===b.reason&&a.row===b.row;
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
  const cells=shareCells(previous.cells,next.cells)!;
  const inventory=shareCells(previous.inventory,next.inventory);
  const a=previous.recent,b=next.recent;
  const sameRecent=a===b||!!a&&!!b&&a.captured===b.captured&&a.read===b.read&&a.waiting===b.waiting&&(a.reading??0)===(b.reading??0)&&a.review===b.review;
  const recent=sameRecent?a:b;
  const oldFrame=previous.recentFrame,newFrame=next.recentFrame;
  const frameCells=shareCells(oldFrame?.cells,newFrame?.cells);
  const recentFrame=newFrame?oldFrame&&newFrame.frame===oldFrame.frame&&frameCells===oldFrame.cells?oldFrame:{...newFrame,cells:frameCells!}:undefined;
  if(cells===previous.cells&&inventory===previous.inventory&&sameRecent&&recentFrame===oldFrame&&
    next.located===previous.located&&next.totalRows===previous.totalRows&&next.estimatedTop===previous.estimatedTop&&
    next.liveTop===previous.liveTop&&next.liveTracking===previous.liveTracking)return previous;
  return {...next,cells,inventory,recent,...(recentFrame?{recentFrame}:{})};
}

/** The small progress window publishes independently of the card-list transition.
 * Retains no card crops, recording pixels, or recognition evidence. */
export function createScanMonitorStore() {
  let value:ScanMonitorState|null=null;
  let feedback:ScannerFeedback|undefined;
  const listeners=new Set<()=>void>();
  const notify=()=>listeners.forEach(listener=>listener());
  return {
    getSnapshot:()=>value,
    getFeedback:()=>feedback,
    setFeedback(next:ScannerFeedback|undefined){
      if(feedback===next)return;
      try{feedback?.cancel();}catch{/* Optional collector teardown cannot affect display. */}
      feedback=next;
    },
    subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    publish(input:ScanMonitorInput) {
      const next=projectScanMonitorState(input);
      const grid=shareGrid(value?.grid,next.grid);
      // Explicit transport through a newly allocated canonical clone. Reusing
      // an old equal grid must never lend its markers to a newer source/attempt.
      if(grid&&next.grid&&grid!==next.grid&&grid!==value?.grid){
        try{feedback?.grid(grid,[],next.grid);}catch{/* Exact sidecar transfer is optional. */}
      }
      if(value&&value.grid===grid&&value.currentRunRead===next.currentRunRead&&value.expected===next.expected&&
        value.capacity===next.capacity&&value.interrupted===next.interrupted&&
        (value.queued??0)===(next.queued??0)&&(value.activeReadings??0)===(next.activeReadings??0)&&
        value.unresolvedCount===next.unresolvedCount&&value.hasInput===next.hasInput&&
        value.unresolvedFieldChanges===next.unresolvedFieldChanges&&value.unresolvedFieldChangesUnavailable===next.unresolvedFieldChangesUnavailable){
        try{feedback?.publish(value,grid,true);}catch{/* Diagnostics do not create notifications. */}
        return;
      }
      value={...next,grid};
      try{feedback?.publish(value,grid);}catch{/* Display acceptance is independent of timing. */}
      notify();
    },
    clear(){try{feedback?.cancel();}catch{/* Display clear is independent of timing. */}feedback=undefined;if(value){value=null;notify();}},
  };
}
export type ScanMonitorStore=ReturnType<typeof createScanMonitorStore>;
