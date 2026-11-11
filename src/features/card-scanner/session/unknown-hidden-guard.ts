import {parseUnknownFact} from './unknown-lifecycle';
import type {UnknownEffect,UnknownEntry,UnknownFact,UnknownUpsert} from './unknown-lifecycle-types';
import type {ObservationSource} from './observation-execution';

type Group=Extract<UnknownFact['key'],{kind:'group'}>;
type Source=ObservationSource;
export type HiddenReason='suppressed'|'replaced'|'retired'|'unreported';
export type HiddenDiagnosticEvent=
 | {version:1;kind:'seed';sessionId:string;limits:{active:number;proofs:number;events:number}}
 | {version:1;kind:'failure';reason:HiddenReason;fact:UnknownUpsert}
 | {version:1;kind:'confirmed';key:Group;source:Source;cardId:string};
export interface HiddenDiagnosticSummary {
  version:1;scope:'diagnostic-only';active:number;proofs:number;hidden:number;
  evidenceLost:boolean;recording:'complete'|'partial'|'not-requested';events:number;admitted:number;
}
const sourceKey=(s:Source)=>JSON.stringify([s.sessionId,s.frameId,s.observationId,s.captureOrder,s.captureTime,s.phase,s.slot]);
const same=(a:Source|null,b:Source|null)=>!!a&&!!b&&sourceKey(a)===sourceKey(b);
export const hiddenUnknownEnabled=(development:boolean,requested:boolean|undefined)=>development&&requested===true;

/** DEV-only, source-scoped observation of final failures hidden by v1. This is
 * diagnostic, never completion authority. No image, pixel or OCR result is kept. */
export class HiddenUnknownGuard {
  readonly sessionId:string;
  private readonly options:{active?:number;proofs?:number;events?:number;record?:(event:HiddenDiagnosticEvent)=>boolean};
  private failures=new Map<string,UnknownUpsert>();
  private proofs=new Map<string,string>();
  private lost=false;
  private recordingFailed=false;
  private events=0;
  private admitted=0;
  private hidden=0;
  constructor(sessionId:string,options:{active?:number;proofs?:number;events?:number;
    record?:(event:HiddenDiagnosticEvent)=>boolean}={}) {
    if(!sessionId||sessionId.length>160)throw Error('invalid hidden diagnostic session');
    for(const value of [options.active??128,options.proofs??10_000,options.events??20_000])
      if(!Number.isSafeInteger(value)||value<0)throw Error('invalid hidden diagnostic limit');
    this.sessionId=sessionId;this.options=options;
    this.record({version:1,kind:'seed',sessionId,limits:{active:options.active??128,proofs:options.proofs??10_000,events:options.events??20_000}});
  }
  private record(event:HiddenDiagnosticEvent){
    this.events++;
    if(!this.options.record)return;
    if(this.recordingFailed||this.events>(this.options.events??20_000)){this.recordingFailed=true;return;}
    try{if(this.options.record(event)!==true){this.recordingFailed=true;return;}this.admitted++;}
    catch{this.recordingFailed=true;}
  }
  failure(value:UnknownUpsert,reason:HiddenReason){
    const f=parseUnknownFact(value);
    if(f.kind!=='upsert'||f.key.kind!=='group'||f.key.sessionId!==this.sessionId||!f.source)throw Error('source-bound failure required');
    if(f.pending)return;
    this.hidden++;this.record({version:1,kind:'failure',reason,fact:f});
    const id=sourceKey(f.source);
    if(this.proofs.has(id))return;
    if(!this.failures.has(id)&&this.failures.size>=(this.options.active??128)){this.lost=true;return;}
    this.failures.set(id,f);
  }
  confirmed(key:Group,source:Source,cardId:string,review:readonly string[]){
    if(review.length)return;
    const f=parseUnknownFact({version:1,kind:'retire',cause:'confirmed-name',key,proof:{cardId,source}});
    if(f.kind!=='retire'||f.key.sessionId!==this.sessionId)throw Error('source-bound confirmation required');
    this.record({version:1,kind:'confirmed',key:f.key as Group,source:f.proof.source,cardId:f.proof.cardId});
    const id=sourceKey(f.proof.source),previous=this.proofs.get(id);
    if(previous&&previous!==f.proof.cardId){this.lost=true;return;}
    if(!previous&&this.proofs.size>=(this.options.proofs??10_000)){this.lost=true;return;}
    this.proofs.set(id,f.proof.cardId);this.failures.delete(id);
  }
  /** Called after the unmodified group reducer; previous is its pre-update entry. */
  groupEffect(fact:UnknownUpsert|null,previous:UnknownEntry|undefined,effect:UnknownEffect){
    const add=(entry:UnknownUpsert|UnknownEntry,reason:HiddenReason)=>{
      if(entry.pending||entry.key.kind!=='group'||!entry.source)return;
      const {key,source,captureOrder,captureTime,pending,reason:description,location}=entry;
      this.failure({version:1,kind:'upsert',key,source,captureOrder,captureTime,pending,reason:description,location},reason);
    };
    if(fact&&!effect.upserted&&(!previous||!same(previous.source,fact.source)))add(fact,'suppressed');
    if(fact&&effect.upserted&&previous&&!same(previous.source,fact.source))add(previous,'replaced');
    for(const item of effect.retiredVersions)add(item,'retired');
  }
  summary():HiddenDiagnosticSummary{return {version:1,scope:'diagnostic-only',active:this.failures.size,proofs:this.proofs.size,
    hidden:this.hidden,evidenceLost:this.lost,recording:!this.options.record?'not-requested':this.recordingFailed?'partial':'complete',
    events:this.events,admitted:this.admitted};}
  active():readonly UnknownUpsert[]{return [...this.failures.values()];}
  /** Canonical, image-free state for a versioned replay. The source key must
   * include every identity component: counts alone cannot reproduce future
   * transitions. Recording status is intentionally not live evidence. */
  replaySnapshot(){
    const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
    const active=[...this.failures.entries()].sort(([a],[b])=>order(a,b)).map(([,fact])=>fact);
    const proofs=[...this.proofs.entries()].sort(([a],[b])=>order(a,b)).map(([source,cardId])=>({source,cardId}));
    return {version:1 as const,scope:'hidden-unknown-state' as const,sessionId:this.sessionId,
      limits:{active:this.options.active??128,proofs:this.options.proofs??10_000,events:this.options.events??20_000},
      events:this.events,hidden:this.hidden,evidenceLost:this.lost,active,proofs};
  }
}
