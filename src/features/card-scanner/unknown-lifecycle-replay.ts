import {UnknownLifecycle,hashUnknownLifecycle,parseUnknownCheckpoint,parseUnknownFact,parseUnknownSeed} from './unknown-lifecycle';
import {yieldForCapture} from './input-source';
import type {UnknownCheckpoint} from './unknown-lifecycle-types';

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
}

/** Replays the same warning authority used by the live scanner. Image sidecars,
 * OCR diagnostics and the final diagnostic count are never state inputs here.
 * Archive consumers separately validate their complete ordered event envelope. */
export class UnknownLifecycleReplay {
  private readonly signal:AbortSignal;
  private lifecycle:UnknownLifecycle|undefined;
  private events=0;
  private latestCheckpoint:UnknownCheckpoint|null=null;
  private invalid=false;

  constructor(signal:AbortSignal){this.signal=signal;}

  private apply(action:()=>void):void {
    this.signal.throwIfAborted();
    if(this.invalid)throw Error('유효하지 않은 미식별 상태 기록');
    try{action();}catch(error){this.invalid=true;throw error;}
  }

  seed(value:unknown):void {
    this.apply(()=>{
      const seed=parseUnknownSeed(value);
      if(this.lifecycle)throw Error('미식별 시작 상태가 중복되었습니다.');
      this.lifecycle=new UnknownLifecycle(seed);
      this.latestCheckpoint=null;
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
    const snapshot=this.lifecycle?.snapshot(),events=this.events,checkpoint=this.latestCheckpoint;
    const pending=snapshot?.active.filter(entry=>entry.pending).length??0,active=snapshot?.active.length??0;
    const complete=!!snapshot?.complete&&checkpoint?.complete===true&&checkpoint.events===events;
    const expectedHash=complete?checkpoint.hash:null;
    await yieldForCapture(this.signal);
    const hash=snapshot?await hashUnknownLifecycle(snapshot):null;
    this.signal.throwIfAborted();
    return {supported:!!snapshot,events,active,pending,final:active-pending,complete,hash,expectedHash,
      matchesCapturedState:complete&&hash!==null&&expectedHash!==null?hash===expectedHash:null};
  }
}
