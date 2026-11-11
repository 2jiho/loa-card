import {parseObservationFact, type ObservationSource} from '../session/observation-execution';
import {UnknownSourceLifecycle, parseUnknownFact, parseUnknownSeed} from '../session/unknown-lifecycle';
import type {UnknownEffect, UnknownFact, UnknownKey, UnknownLimits} from '../session/unknown-lifecycle-types';

type GroupKey = Extract<UnknownKey, {kind:'group'}>;
type Rect = Readonly<{x:number;y:number;width:number;height:number}>;
export type UnknownRecoveryClaimSeed = Readonly<{version:3;sessionId:string;origin:'scan';limits:UnknownLimits}>;

/** Serialized producer claim, not a pixel binding, OCR proof, or live authorization. */
export interface UnknownRecoveryClaim {
  readonly version:3;
  readonly kind:'recovery-confirmed';
  readonly target:Readonly<{key:GroupKey;originalSource:ObservationSource}>;
  readonly recovery:Readonly<{source:ObservationSource;attemptId:number;cardId:string;review:readonly []}>;
  readonly physical:Readonly<{sourceFrameId:number;sha256:string;width:number;height:number;
    captureTime:number;originalContent:Rect;recoveryContent:Rect;originalPreview:Rect;recoveryPreview:Rect}>;
}
export type UnknownRecoveryClaimEvent = UnknownFact | UnknownRecoveryClaim;

function fail(message:string):never {throw new Error(`Invalid recovery claim replay: ${message}`);}
/** Copy plain data once before any semantic read; accessors must never supply
 * different values to validation and construction. Not an authenticity check. */
function copyData(value:unknown,depth=0,budget={remaining:512}):unknown {
  if(--budget.remaining<0||depth>12)fail('input size');
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return value;
  if(!value||typeof value!=='object')fail('plain data required');
  if(Array.isArray(value)){
    const lengthDescriptor=Object.getOwnPropertyDescriptor(value,'length');
    if(Object.getPrototypeOf(value)!==Array.prototype||!lengthDescriptor||!('value' in lengthDescriptor)||
      !Number.isSafeInteger(lengthDescriptor.value)||lengthDescriptor.value<0||lengthDescriptor.value>256)fail('array');
    const length=lengthDescriptor.value as number;
    const keys=Reflect.ownKeys(value);
    if(keys.length!==length+1||!keys.includes('length'))fail('array fields');
    return Array.from({length},(_,index)=>{
      const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
      if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)fail('array element');
      return copyData(descriptor.value,depth+1,budget);
    });
  }
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('prototype');
  const result:Record<string,unknown>=Object.create(null);
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string')fail('symbol');
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)fail('accessor');
    result[key]=copyData(descriptor.value,depth+1,budget);
  }
  return result;
}
function record(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('object');
  const obj=value as Record<string,unknown>;
  if(Reflect.ownKeys(obj).length!==keys.length||keys.some(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(obj,key);
    return !descriptor||!('value' in descriptor)||!descriptor.enumerable;
  }))fail('fields or accessor');
  return obj;
}
function integer(value:unknown,min=0):number {
  if(!Number.isSafeInteger(value)||(value as number)<min)fail('integer');
  return value as number;
}
function rect(value:unknown,width:number,height:number):Rect {
  const raw=record(value,['x','y','width','height']);
  for(const field of ['x','y','width','height'])if(typeof raw[field]!=='number'||!Number.isFinite(raw[field])||(raw[field] as number)<0)fail('rectangle');
  const result=raw as unknown as Rect;
  if(result.width===0||result.height===0||result.x+result.width>width||result.y+result.height>height)fail('rectangle bounds');
  return Object.freeze({x:result.x,y:result.y,width:result.width,height:result.height});
}
function equalRect(a:Rect,b:Rect):boolean {return a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height;}
function source(value:unknown,attemptId=0):ObservationSource {
  const raw=record(value,['sessionId','frameId','observationId','captureOrder','captureTime','phase','slot']);
  return parseObservationFact({version:1,kind:'queued',source:{...raw},attemptId}).source;
}
export function parseUnknownRecoveryClaimSeed(value:unknown):UnknownRecoveryClaimSeed {
  const raw=record(copyData(value),['version','sessionId','origin','limits']);
  if(raw.version!==3||raw.origin!=='scan')fail('seed version');
  const limits=record(raw.limits,['active','facts','groups']);
  const parsed=parseUnknownSeed({...raw,limits:{...limits},version:1});
  return Object.freeze({...parsed,version:3,origin:'scan'});
}
export function parseUnknownRecoveryClaim(value:unknown):UnknownRecoveryClaim {
  const raw=record(copyData(value),['version','kind','target','recovery','physical']);
  if(raw.version!==3||raw.kind!=='recovery-confirmed')fail('fact kind');
  const target=record(raw.target,['key','originalSource']),recovery=record(raw.recovery,['source','attemptId','cardId','review']);
  const attemptId=integer(recovery.attemptId),originalSource=source(target.originalSource),recoverySource=source(recovery.source,attemptId);
  if(typeof recovery.cardId!=='string'||!recovery.cardId.length||recovery.cardId.length>160||!Array.isArray(recovery.review)||recovery.review.length!==0)fail('identity');
  const key=record(target.key,['kind','sessionId','group']);
  const normalized=parseUnknownFact({version:1,kind:'retire',cause:'confirmed-name',key:{...key},proof:{cardId:recovery.cardId,source:originalSource}});
  if(normalized.kind!=='retire')fail('target');
  if(originalSource.phase!=='input'||recoverySource.phase!=='recovery'||originalSource.sessionId!==recoverySource.sessionId||
    originalSource.frameId===recoverySource.frameId||originalSource.observationId===recoverySource.observationId||
    originalSource.captureOrder!==recoverySource.captureOrder||originalSource.captureTime!==recoverySource.captureTime||originalSource.slot!==recoverySource.slot)fail('source metadata');
  const p=record(raw.physical,['sourceFrameId','sha256','width','height','captureTime','originalContent','recoveryContent','originalPreview','recoveryPreview']);
  const sourceFrameId=integer(p.sourceFrameId),width=integer(p.width,1),height=integer(p.height,1);
  if(width>16384||height>16384||p.captureTime!==originalSource.captureTime||typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256))fail('physical metadata');
  const originalContent=rect(p.originalContent,width,height),recoveryContent=rect(p.recoveryContent,width,height);
  const originalPreview=rect(p.originalPreview,width,height),recoveryPreview=rect(p.recoveryPreview,width,height);
  if(!equalRect(originalContent,recoveryContent)||!equalRect(originalPreview,recoveryPreview))fail('crop metadata');
  return Object.freeze({version:3,kind:'recovery-confirmed',target:Object.freeze({key:normalized.key,originalSource}),
    recovery:Object.freeze({source:recoverySource,attemptId,cardId:recovery.cardId,review:Object.freeze([]) as readonly []}),
    physical:Object.freeze({sourceFrameId,sha256:p.sha256,width,height,captureTime:originalSource.captureTime,originalContent,recoveryContent,originalPreview,recoveryPreview})});
}

/** Offline replay only. Metadata and hashes here are producer assertions. Neither
 * acceptance nor a matching state hash authenticates the pixels or recognition.
 * Deliberately not connected to the live scanner or its authorization path. */
export class UnknownRecoveryClaimReplay {
  readonly seed:UnknownRecoveryClaimSeed;
  private readonly state:UnknownSourceLifecycle;
  private readonly claims:UnknownRecoveryClaim[]=[];
  private events=0;
  private overflow=false;
  private conflictingRecovery=false;
  private readonly recoveryClaims=new Map<string,string>();
  private readonly attempts=new Map<string,string>();
  constructor(seed:UnknownRecoveryClaimSeed) {
    this.seed=parseUnknownRecoveryClaimSeed(seed);
    this.state=new UnknownSourceLifecycle({...this.seed,version:2});
  }
  apply(value:UnknownRecoveryClaimEvent):UnknownEffect|undefined {
    const copied=copyData(value),header=copied as {version?:unknown}|null;
    const fact=header?.version===3?parseUnknownRecoveryClaim(copied):parseUnknownFact(copied);
    const group=fact.version===3?fact.target.key:fact.key;
    if(group.kind!=='group'||group.sessionId!==this.seed.sessionId)fail('session or group');
    if(fact.version===1&&fact.kind==='upsert'&&!fact.source)fail('source required');
    if(++this.events>this.seed.limits.facts){this.overflow=true;return;}
    if(fact.version===3){
      this.claims.push(fact);
      const recoveryId=JSON.stringify(fact.recovery.source);
      const binding=JSON.stringify([fact.target,fact.physical]);
      const attempt=JSON.stringify([recoveryId,fact.recovery.attemptId]);
      const outcome=JSON.stringify([binding,fact.recovery.cardId]);
      const previous=this.recoveryClaims.get(recoveryId),priorAttempt=this.attempts.get(attempt);
      if(previous!==undefined&&previous!==binding||priorAttempt!==undefined&&priorAttempt!==outcome){this.conflictingRecovery=true;return;}
      this.recoveryClaims.set(recoveryId,binding);this.attempts.set(attempt,outcome);
      return this.state.confirmName(fact.target.key,fact.recovery.cardId,fact.target.originalSource,[]);
    }
    return this.state.apply(fact);
  }
  unresolved():number {return this.state.unresolved()+Number(this.overflow||this.conflictingRecovery);}
  snapshot() {
    const inner=this.state.snapshot();
    return Object.freeze({version:3 as const,scope:'producer-claimed-recovery-replay' as const,
      pixelsAuthenticated:false as const,recognitionAuthenticated:false as const,liveAuthorization:false as const,
      seed:this.seed,events:this.events,complete:!this.overflow&&!this.conflictingRecovery&&inner.complete,
      overflow:this.overflow,conflictingRecovery:this.conflictingRecovery,claims:Object.freeze([...this.claims]),state:inner});
  }
  async hash():Promise<string|null> {
    const snapshot=this.snapshot();if(!snapshot.complete)return null;
    const bytes=new TextEncoder().encode(JSON.stringify(snapshot));
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
}
