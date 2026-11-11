import {UnknownSourceLifecycle,hashUnknownSourceLifecycle} from './unknown-lifecycle';
import {UnknownDiagnosticSidecars} from './unknown-diagnostic-sidecars';
import {UNKNOWN_LIFECYCLE_LIMITS} from './unknown-lifecycle-types';
import type {UnknownFact,UnknownLimits,UnknownUpsert} from './unknown-lifecycle-types';
import type {UnknownSourceLoss,UnknownSourceSeed} from './unknown-lifecycle';
import type {ObservationSource} from './observation-execution';
import type {InventorySource} from './inventory-evidence';

type Diagnostic=Parameters<UnknownDiagnosticSidecars['remember']>[1];
type GroupKey=Extract<UnknownFact['key'],{kind:'group'}>;
type Recorder={
  /** A synchronous queue receipt, not a durable-storage guarantee. */
  record(type:'unknown-seed'|'unknown-event'|'unknown-checkpoint',value:unknown):boolean;
  incomplete(loss:UnknownSourceLoss):void;
};

/** A fuzzy group only schedules work. Replacing an unknown retry with a
 * different observation would discard the only pixels able to resolve it. */
export function unknownRetryCandidateIndex<T extends {group:number;source:InventorySource}>(queue:readonly T[],candidate:T):number {
  const b=candidate.source;
  return queue.findIndex(item=>{
    const a=item.source;
    return item.group===candidate.group&&a.sessionId===b.sessionId&&a.frameId===b.frameId&&
      a.observationId===b.observationId&&a.captureOrder===b.captureOrder&&a.captureTime===b.captureTime&&
      a.phase===b.phase&&a.slot===b.slot&&a.frame===b.frame;
  });
}

/** Source-scoped live state shared by normal capture and saved-input scans.
 * Images are optional sidecars; source evidence is never inferred from them. */
export class UnknownScanSession {
  readonly seed:UnknownSourceSeed;
  private readonly lifecycle:UnknownSourceLifecycle;
  private readonly diagnostics:UnknownDiagnosticSidecars;
  private readonly recording?:Recorder;
  constructor(options:{sessionId:string;limits?:UnknownLimits;recording?:Recorder;
    onEvidenceLoss?:(loss:UnknownSourceLoss)=>void}) {
    this.seed={version:2,sessionId:options.sessionId,origin:'scan',limits:options.limits??UNKNOWN_LIFECYCLE_LIMITS};
    this.recording=options.recording;
    this.diagnostics=new UnknownDiagnosticSidecars(undefined,'source');
    this.lifecycle=new UnknownSourceLifecycle(this.seed,{
      ...(options.recording?{onEvent:fact=>options.recording!.record('unknown-event',fact)}:{}),
      onIncomplete:loss=>{
        if(loss==='active-limit'||loss==='proof-limit'||loss==='identity-conflict'){
          try{options.onEvidenceLoss?.(loss);}catch{/* User feedback cannot corrupt evidence. */}
        }
        try{options.recording?.incomplete(loss);}catch{/* Optional recording failure. */}
      },
    });
    if(this.recording){
      let recorded=false;
      try{recorded=this.recording.record('unknown-seed',this.seed);}catch{/* Optional recorder. */}
      if(!recorded)this.lifecycle.markIncomplete('event-sink-failed');
    }
  }
  report(fact:UnknownUpsert,diagnostic:Diagnostic) {
    const effect=this.lifecycle.apply(fact);
    if(effect.upserted)this.diagnostics.remember(effect.upserted,diagnostic);
    return effect;
  }
  confirmName(key:GroupKey,cardId:string,source:ObservationSource,review:readonly string[]) {
    const effect=this.lifecycle.confirmName(key,cardId,source,review);
    if(effect?.retiredVersions.length)this.diagnostics.retire(effect.retiredVersions);
    return effect;
  }
  active(){return this.diagnostics.project(this.lifecycle.active());}
  unresolved(){return this.lifecycle.unresolved();}
  hasEvidenceLoss(){return this.lifecycle.hasEvidenceLoss();}
  /** A failed queue receipt is recorded as incomplete, never as lost live input. */
  async checkpoint():Promise<boolean> {
    if(!this.recording)return false;
    const snapshot=this.lifecycle.snapshot();
    let recorded=false;
    try{recorded=this.recording.record('unknown-checkpoint',{version:1,complete:snapshot.complete,
      events:snapshot.facts,hash:await hashUnknownSourceLifecycle(snapshot)});}catch{/* Optional recorder. */}
    if(!recorded){
      this.lifecycle.markIncomplete('event-sink-failed');
      try{this.recording.record('unknown-checkpoint',{version:1,complete:false,events:snapshot.facts,hash:null});}catch{/* Optional recorder. */}
    }
    return recorded;
  }
  /** Exposed for diagnostics, not to infer missing physical pixels. */
  snapshot(){return this.lifecycle.snapshot();}
}

