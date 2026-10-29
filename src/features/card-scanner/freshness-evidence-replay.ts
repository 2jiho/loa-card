import {FreshnessEvidence,hashFreshnessEvidence,parseFreshnessCheckpoint,parseFreshnessFact,parseFreshnessSeed} from './freshness-evidence';
import type {FreshnessCheckpoint} from './freshness-evidence-types';
import {yieldForCapture} from './input-source';

export interface FreshnessReplaySummary {
  readonly supported:boolean;readonly events:number;readonly accepted:number;readonly pending:number;
  readonly unresolved:number;readonly lostChange:boolean;readonly lineages:number;
  readonly complete:boolean;readonly hash:string|null;readonly expectedHash:string|null;
  readonly matchesCapturedState:boolean|null;
}

/** The caller applies real inventory seed/events to the shared inventory
 * reducer first. This replay reads that reducer's proof map; it never treats
 * final card counts, diagnostic fields, or a serialized resolved=true as proof. */
export class FreshnessEvidenceReplay {
  private readonly signal:AbortSignal;
  private readonly confirmedFields:()=>ReadonlyMap<string,number>;
  private evidence:FreshnessEvidence|undefined;
  private events=0;
  private latestCheckpoint:FreshnessCheckpoint|null=null;
  private invalid=false;
  private revision=0;
  constructor(signal:AbortSignal,confirmedFields:()=>ReadonlyMap<string,number>){
    this.signal=signal;this.confirmedFields=confirmedFields;
  }
  private apply(action:()=>void):void {
    this.signal.throwIfAborted();
    if(this.invalid)throw Error('유효하지 않은 최신 필드 상태 기록');
    try{action();this.revision++;}catch(error){this.invalid=true;throw error;}
  }
  seed(value:unknown):void {
    this.apply(()=>{
      const seed=parseFreshnessSeed(value);
      if(this.evidence)throw Error('최신 필드 시작 상태가 중복되었습니다.');
      // The injected getter rejects a missing inventory seed. Even an empty
      // freshness channel cannot certify a checkpoint without its proof domain.
      this.confirmedFields();
      this.evidence=new FreshnessEvidence(seed,{confirmedFields:this.confirmedFields});
      this.latestCheckpoint=null;
    });
  }
  accept(value:unknown):void {
    this.apply(()=>{
      const fact=parseFreshnessFact(value);
      if(!this.evidence)throw Error('최신 필드 시작 상태 없이 이벤트를 재생할 수 없습니다.');
      this.evidence.apply(fact);this.events++;this.latestCheckpoint=null;
    });
  }
  /** Even without a later settle command, a post-checkpoint inventory event
   * invalidates that checkpoint. Hashing must not secretly apply settlement. */
  proofsChanged():void {this.apply(()=>{this.latestCheckpoint=null;});}
  checkpoint(value:unknown):void {
    this.apply(()=>{
      const checkpoint=parseFreshnessCheckpoint(value);
      if(!this.evidence)throw Error('최신 필드 시작 상태 없이 검증점을 재생할 수 없습니다.');
      if(checkpoint.events<this.events||checkpoint.complete&&checkpoint.events!==this.events)
        throw Error('최신 필드 검증점 이벤트 수 불일치');
      this.latestCheckpoint=checkpoint;
    });
  }
  async summary():Promise<FreshnessReplaySummary> {
    this.signal.throwIfAborted();
    if(this.invalid)throw Error('유효하지 않은 최신 필드 상태 기록');
    const snapshot=this.evidence?.snapshot(),events=this.events,checkpoint=this.latestCheckpoint,revision=this.revision;
    const eligible=!!snapshot?.complete&&checkpoint?.complete===true&&checkpoint.events===events;
    await yieldForCapture(this.signal);
    const hash=snapshot?await hashFreshnessEvidence(snapshot):null;this.signal.throwIfAborted();
    if(this.invalid)throw Error('유효하지 않은 최신 필드 상태 기록');
    const complete=eligible&&revision===this.revision&&checkpoint===this.latestCheckpoint;
    const expectedHash=complete?checkpoint.hash:null;
    return {supported:!!snapshot,events,accepted:snapshot?.accepted.length??0,pending:snapshot?.pending.length??0,
      unresolved:(snapshot?.pending.length??0)+Number(snapshot?.lostChange??false),lostChange:snapshot?.lostChange??false,
      lineages:snapshot?.lineages.length??0,complete,hash,expectedHash,
      matchesCapturedState:complete&&hash!==null&&expectedHash!==null?hash===expectedHash:null};
  }
}
