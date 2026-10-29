import {LiveScanCadence} from './live-scan-policy';
import {parseSourceFrameCorrelation,sameSourceFrameCorrelation} from './source-frame-correlation';
import type {SourceFrameCorrelation} from './source-frame-correlation';

/** Identity describes an arrival, never card freshness or an OCR attempt. All
 * policy times use one caller-owned monotonic clock; captureTime stays seconds. */
export interface InputStamp {
  readonly inputId:number;
  readonly captureTime:number;
  readonly observedAtMs:number;
  /** Source correlation is diagnostic; captureTime remains freshness. */
  readonly source?:SourceFrameCorrelation;
}
export interface LiveInputGates {
  capturing:boolean;checkingCompletion:boolean;
  /** False defers this arrival before snapshot ownership. Absence preserves
   * legacy admission; a later available credit does not reuse skipped pixels. */
  sourceCapacity?:boolean;
  /** Development experiment: a lower bound on successful input spacing, not
   * a source clock, target frame rate or evidence that skipped pixels exist. */
  minIntervalMs?:number;
  /** Recorded development experiment; freeze-cost backpressure still applies. */
  offerFloorMs?:number;
}
export type LiveInputAdmissionDecision=
  | {readonly kind:'freeze';readonly stamp:InputStamp}
  | {readonly kind:'skip';readonly stamp:InputStamp;readonly reason:'ended'|'verification'|'source-capacity'|'cadence'};
export type LiveInputAdmissionFact=
  | {kind:'consider';stamp:InputStamp;gates:LiveInputGates;expected?:'freeze'|'ended'|'verification'|'source-capacity'|'cadence'}
  | {kind:'frozen';stamp:InputStamp;succeeded:boolean;freezeMs:number}
  | {kind:'completed';startedAtMs:number;endedAtMs:number};

function time(value:number) {
  if(!Number.isFinite(value)||value<0)throw new TypeError('Input times must be finite and nonnegative');
}
function minimumInterval(value:unknown):number|undefined {
  if(value===undefined)return;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1000)
    throw new TypeError('Invalid minimum input interval');
  return value;
}
function sourceCapacityGate(value:unknown):boolean|undefined {
  if(value===undefined)return;
  if(typeof value!=='boolean')throw new TypeError('Invalid source capacity gate');
  return value;
}
function offerFloor(value:unknown):number|undefined {
  if(value===undefined)return;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>33)
    throw new TypeError('Invalid input offer floor');
  return value;
}
function stampCopy(stamp:InputStamp):InputStamp {
  if(!stamp||!Number.isSafeInteger(stamp.inputId)||stamp.inputId<1)throw new TypeError('Invalid input identity');
  time(stamp.captureTime);time(stamp.observedAtMs);
  return Object.freeze({inputId:stamp.inputId,captureTime:stamp.captureTime,observedAtMs:stamp.observedAtMs,
    ...(stamp.source===undefined?{}:{source:parseSourceFrameCorrelation(stamp.source)})});
}
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||
    Object.keys(value).some(key=>!keys.includes(key)))
    throw new TypeError('Invalid input admission fact');
  return value as Record<string,unknown>;
}

/** Strict detached wire facts. No source handles or extension fields survive. */
export function parseLiveInputAdmissionFact(input:unknown):LiveInputAdmissionFact {
  const value=object(input,['kind','stamp','gates','expected','succeeded','freezeMs','startedAtMs','endedAtMs']);
  if(value.kind==='completed'){
    object(value,['kind','startedAtMs','endedAtMs']);
    time(value.startedAtMs as number);time(value.endedAtMs as number);
    if((value.endedAtMs as number)<(value.startedAtMs as number))throw new TypeError('Invalid completion interval');
    return Object.freeze({kind:'completed',startedAtMs:value.startedAtMs as number,endedAtMs:value.endedAtMs as number});
  }
  const stamp=stampCopy(object(value.stamp,['inputId','captureTime','observedAtMs','source']) as unknown as InputStamp);
  if(value.kind==='consider'){
    object(value,['kind','stamp','gates','expected']);
    const gates=object(value.gates,['capturing','checkingCompletion','sourceCapacity','minIntervalMs','offerFloorMs']);
    if(typeof gates.capturing!=='boolean'||typeof gates.checkingCompletion!=='boolean')throw new TypeError('Invalid input gates');
    const sourceCapacity=sourceCapacityGate(gates.sourceCapacity),minIntervalMs=minimumInterval(gates.minIntervalMs);
    const offerFloorMs=offerFloor(gates.offerFloorMs);
    if(value.expected!==undefined&&!['freeze','ended','verification','source-capacity','cadence'].includes(value.expected as string))throw new TypeError('Invalid expected input decision');
    return Object.freeze({kind:'consider',stamp,gates:Object.freeze({capturing:gates.capturing,checkingCompletion:gates.checkingCompletion,
      ...(sourceCapacity===undefined?{}:{sourceCapacity}),
      ...(offerFloorMs===undefined?{}:{offerFloorMs}),
      ...(minIntervalMs===undefined?{}:{minIntervalMs})}),
      ...(value.expected===undefined?{}:{expected:value.expected as 'freeze'|'ended'|'verification'|'source-capacity'|'cadence'})});
  }
  if(value.kind==='frozen'){
    object(value,['kind','stamp','succeeded','freezeMs']);
    if(typeof value.succeeded!=='boolean')throw new TypeError('Invalid freeze outcome');
    time(value.freezeMs as number);
    return Object.freeze({kind:'frozen',stamp,succeeded:value.succeeded,freezeMs:value.freezeMs as number});
  }
  throw new TypeError('Unknown input admission fact');
}

/** Deterministic admission policy: no clock reads, pixels, timers or callbacks.
 * Freeze remains a synchronous caller-owned effect, acknowledged before the
 * next arrival. Replaying boundary facts reproduces policy choices only. */
export function createLiveInputAdmission() {
  const cadence=new LiveScanCadence();
  let nextInputId=0,lastConsideredId=0,lastOfferedAt=-Infinity,offered=0,meanFreezeMs=0;
  let pending:InputStamp|undefined,lastCompletedAtMs:number|null=null;
  return {
    stamp(captureTime:number,observedAtMs:number,source?:SourceFrameCorrelation):InputStamp {
      if(nextInputId===Number.MAX_SAFE_INTEGER)throw new RangeError('Input identity limit reached');
      const stamp=stampCopy({inputId:nextInputId+1,captureTime,observedAtMs,...(source===undefined?{}:{source})});
      nextInputId++;return stamp;
    },
    consider(input:InputStamp,gates:LiveInputGates):LiveInputAdmissionDecision {
      const stamp=stampCopy(input);
      if(pending)throw new Error('A requested freeze must settle before the next arrival');
      if(stamp.inputId<=lastConsideredId)throw new Error('Input arrivals must have increasing identities');
      if(!gates||typeof gates.capturing!=='boolean'||typeof gates.checkingCompletion!=='boolean')throw new TypeError('Invalid input gates');
      const sourceCapacity=sourceCapacityGate(gates.sourceCapacity),minIntervalMs=minimumInterval(gates.minIntervalMs);
      const offerFloorMs=offerFloor(gates.offerFloorMs);
      nextInputId=Math.max(nextInputId,stamp.inputId);lastConsideredId=stamp.inputId;
      const offerInterval=Math.max(Math.min(250,Math.max(offerFloorMs??33,meanFreezeMs*4)),minIntervalMs??0);
      const reason=!gates.capturing?'ended':gates.checkingCompletion?'verification':
        sourceCapacity===false?'source-capacity':
        !cadence.take(stamp.observedAtMs)||stamp.observedAtMs-lastOfferedAt<offerInterval?'cadence':undefined;
      if(reason)return Object.freeze({kind:'skip',stamp,reason});
      pending=stamp;return Object.freeze({kind:'freeze',stamp});
    },
    frozen(stamp:InputStamp,result:{succeeded:boolean;freezeMs:number}):void {
      const input=stampCopy(stamp);
      if(!pending||input.inputId!==pending.inputId||input.captureTime!==pending.captureTime||input.observedAtMs!==pending.observedAtMs||
        !sameSourceFrameCorrelation(input.source,pending.source))
        throw new Error('Freeze result does not match the pending input');
      if(!result||typeof result.succeeded!=='boolean')throw new TypeError('Invalid freeze outcome');
      time(result.freezeMs);
      if(result.succeeded){
        lastOfferedAt=input.observedAtMs;offered++;
        meanFreezeMs+=(result.freezeMs-meanFreezeMs)/offered;
      }
      pending=undefined;
    },
    completed(startedAtMs:number,endedAtMs:number):void {
      time(startedAtMs);time(endedAtMs);
      if(endedAtMs<startedAtMs)throw new TypeError('Acquisition completion precedes its start');
      cadence.complete(startedAtMs,endedAtMs);lastCompletedAtMs=endedAtMs;
    },
    snapshot(){
      return Object.freeze({nextInputId,lastConsideredId,offered,meanFreezeMs,
        lastOfferedAtMs:Number.isFinite(lastOfferedAt)?lastOfferedAt:null,
        lastCompletedAtMs,acquisitionMs:cadence.acquisitionMs,pending:pending??null});
    },
  };
}
export type LiveInputAdmission=ReturnType<typeof createLiveInputAdmission>;

/** Apply recorded boundary facts without sleeping or borrowing recorded timing
 * as physical OCR throughput. The caller validates the enclosing event log. */
export function applyLiveInputAdmissionFact(admission:LiveInputAdmission,input:unknown):LiveInputAdmissionDecision|undefined {
  const fact=parseLiveInputAdmissionFact(input);
  switch(fact.kind){
    case 'consider':{
      const decision=admission.consider(fact.stamp,fact.gates);
      if(fact.expected!==undefined&&fact.expected!==(decision.kind==='freeze'?'freeze':decision.reason))
        throw new Error('Input admission decision differs from the recorded choice');
      return decision;
    }
    case 'frozen':admission.frozen(fact.stamp,fact);return;
    case 'completed':admission.completed(fact.startedAtMs,fact.endedAtMs);return;
    default:throw new TypeError('Unknown input admission fact');
  }
}

/** Hash final policy state only; expected decisions above check intermediate
 * choices. Neither proves physical timing or recognition accuracy. */
export async function hashLiveInputAdmission(snapshot:ReturnType<LiveInputAdmission['snapshot']>):Promise<string> {
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(snapshot))));
  return Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('');
}
