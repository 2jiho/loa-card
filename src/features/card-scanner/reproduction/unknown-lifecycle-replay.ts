import {UnknownLifecycle,UnknownSourceLifecycle,hashUnknownLifecycle,hashUnknownSourceLifecycle,
  parseUnknownCheckpoint,parseUnknownFact,parseUnknownReplaySeed} from '../session/unknown-lifecycle';
import {yieldForCapture} from '../capture/input-source';
import type {UnknownCheckpoint} from '../session/unknown-lifecycle-types';
import {UnknownRecoveryClaimReplay,parseUnknownRecoveryClaim,parseUnknownRecoveryClaimSeed} from './unknown-recovery-claim-replay';

/** Version 3 is deliberately opt-in; legacy parsers and hashes remain unchanged. */
export function parseRecordedUnknownSeed(value:unknown) {
  const version=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'version'):undefined;
  return version&&'value' in version&&version.value===3?parseUnknownRecoveryClaimSeed(value):parseUnknownReplaySeed(value);
}

export interface UnknownReplaySummary {
  readonly supported:boolean;
  readonly events:number;
  readonly active:number;
  readonly pending:number;
  readonly final:number;
  readonly complete:boolean;
  readonly hash:string|null;
  readonly expectedHash:string|null;
  readonly matchesCapturedState:boolean|null;
  /** Separately reconstructed live authority; null means the recorded event
   * stream cannot prove absence of loss. This is not part of the v1 hash. */
  readonly liveEvidenceLost:boolean|null;
  /** Producer state-accounting only; neither source pixels nor OCR are certified. */
  readonly producerClaim?:{
    readonly scope:'producer-claimed-recovery-replay';
    readonly pixelsAuthenticated:false;
    readonly recognitionAuthenticated:false;
    readonly liveAuthorization:false;
    readonly matchesClaimedState:boolean|null;
  };
}

/** Replays the same warning authority used by the live scanner. Image sidecars,
 * OCR diagnostics and the final diagnostic count are never state inputs here.
 * Archive consumers separately validate their complete ordered event envelope. */
export class UnknownLifecycleReplay {
  private readonly signal:AbortSignal;
  private lifecycle:UnknownLifecycle|UnknownSourceLifecycle|UnknownRecoveryClaimReplay|undefined;
  private events=0;
  private latestCheckpoint:UnknownCheckpoint|null=null;
  private invalid=false;
  private unknownTypeSeen=false;

  constructor(signal:AbortSignal){this.signal=signal;}

  private apply(action:()=>void):void {
    this.signal.throwIfAborted();
    if(this.invalid)throw Error('유효하지 않은 미식별 상태 기록');
    try{action();}catch(error){this.invalid=true;throw error;}
  }

  seed(value:unknown):void {
    this.apply(()=>{
      const seed=parseRecordedUnknownSeed(value);
      if(this.lifecycle)throw Error('미식별 시작 상태가 중복되었습니다.');
      if(seed.version===3&&this.unknownTypeSeen)throw Error('버전 3 미식별 기록에 알 수 없는 이벤트가 있습니다.');
      this.lifecycle=seed.version===1?new UnknownLifecycle(seed):seed.version===2?new UnknownSourceLifecycle(seed):new UnknownRecoveryClaimReplay(seed);
      this.latestCheckpoint=null;
    });
  }

  /** Keep legacy unknown metadata compatible, but never certify a v3 stream
   * when an unknown lifecycle event might have changed its claimed state. */
  unrecognizedType():void {
    this.apply(()=>{
      this.unknownTypeSeen=true;
      if(this.lifecycle instanceof UnknownRecoveryClaimReplay)throw Error('버전 3 미식별 기록에 알 수 없는 이벤트가 있습니다.');
    });
  }

  acceptRecoveryClaim(value:unknown):void {
    this.apply(()=>{
      const claim=parseUnknownRecoveryClaim(value);
      if(!(this.lifecycle instanceof UnknownRecoveryClaimReplay))throw Error('복구 주장은 버전 3 기록에서만 재생할 수 있습니다.');
      this.lifecycle.apply(claim);this.events++;this.latestCheckpoint=null;
    });
  }

  accept(value:unknown):void {
    this.apply(()=>{
      const fact=parseUnknownFact(value);
      if(!this.lifecycle)throw Error('미식별 시작 상태 없이 이벤트를 재생할 수 없습니다.');
      this.lifecycle.apply(fact);this.events++;this.latestCheckpoint=null;
    });
  }

  checkpoint(value:unknown):void {
    this.apply(()=>{
      const checkpoint=parseUnknownCheckpoint(value);
      if(!this.lifecycle)throw Error('미식별 시작 상태 없이 검증점을 재생할 수 없습니다.');
      // An incomplete recorder may have stopped sending facts at its cap. Its
      // later checkpoint can describe a larger live count, but never equality.
      if(checkpoint.events<this.events||checkpoint.complete&&checkpoint.events!==this.events)
        throw Error('미식별 검증점 이벤트 수 불일치');
      this.latestCheckpoint=checkpoint;
    });
  }

  async summary():Promise<UnknownReplaySummary> {
    this.signal.throwIfAborted();
    if(this.invalid)throw Error('유효하지 않은 미식별 상태 기록');
    const events=this.events,checkpoint=this.latestCheckpoint;
    if(this.lifecycle instanceof UnknownRecoveryClaimReplay){
      const snapshot=this.lifecycle.snapshot(),active=snapshot.state.active.length;
      const pending=snapshot.state.active.filter(entry=>entry.pending).length;
      const complete=snapshot.complete&&checkpoint?.complete===true&&checkpoint.events===events;
      const expectedHash=complete?checkpoint.hash:null;
      await yieldForCapture(this.signal);
      const hash=await this.lifecycle.hash();this.signal.throwIfAborted();
      return {supported:true,events,active,pending,final:active-pending,complete,hash,expectedHash,
        matchesCapturedState:null,liveEvidenceLost:null,producerClaim:{scope:snapshot.scope,pixelsAuthenticated:false,
          recognitionAuthenticated:false,liveAuthorization:false,
          matchesClaimedState:complete&&hash!==null&&expectedHash!==null?hash===expectedHash:null}};
    }
    const snapshot=this.lifecycle?.snapshot();
    const pending=snapshot?.active.filter(entry=>entry.pending).length??0,active=snapshot?.active.length??0;
    const complete=!!snapshot?.complete&&checkpoint?.complete===true&&checkpoint.events===events;
    const expectedHash=complete?checkpoint.hash:null;
    // Capture this together with the snapshot before yielding: later events
    // must not leak into the state boundary represented by this summary.
    const lost=this.lifecycle instanceof UnknownLifecycle?this.lifecycle.hasLiveEvidenceLoss():
      this.lifecycle instanceof UnknownSourceLifecycle?this.lifecycle.hasEvidenceLoss():null;
    const liveEvidenceLost=lost===true?true:complete&&!this.unknownTypeSeen&&lost===false?false:null;
    await yieldForCapture(this.signal);
    const hash=snapshot?(snapshot.version===1?await hashUnknownLifecycle(snapshot):await hashUnknownSourceLifecycle(snapshot)):null;
    this.signal.throwIfAborted();
    return {supported:!!snapshot,events,active,pending,final:active-pending,complete,hash,expectedHash,
      matchesCapturedState:complete&&hash!==null&&expectedHash!==null?hash===expectedHash:null,liveEvidenceLost};
  }
}
