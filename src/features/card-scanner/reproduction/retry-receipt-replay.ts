import {createRetryLedger, parseRetryEvent, reduceRetryLedger} from '../session/retry-receipt-state';
import type {RetryEvent, RetryLedger} from '../session/retry-receipt-state';

/** Diagnostic ledger replay only. A checksum is not authentication and caller
 * supplied frame IDs are not proof that two physical frames are distinct. */
export interface RetryRecord {seq:number;event:RetryEvent;accepted:boolean;reason:string}
export interface RetryCheckpoint {version:1;session:string;capacity:number;concurrency:number;count:number;hash:string;sealed:boolean}
const LIMIT=50000;
const encoder=new TextEncoder();
const ZERO='0'.repeat(64);

function object(value:unknown,keys:string[]):Record<string,unknown>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const proto=Object.getPrototypeOf(value);
  if(proto!==null&&proto!==Object.prototype)return;
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
  if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))return;
  const out:Record<string,unknown>=Object.create(null);
  for(const k of keys) {
    const descriptor=descriptors[k];
    if(!descriptor||!('value' in descriptor))return;
    out[k]=descriptor.value;
  }
  return out;
}
function record(value:unknown):RetryRecord|undefined {
  const v=object(value,['seq','event','accepted','reason']);
  if(!v||!Number.isSafeInteger(v.seq)||(v.seq as number)<1||typeof v.accepted!=='boolean'||
    typeof v.reason!=='string'||v.reason.length>64)return;
  const event=parseRetryEvent(v.event);
  if(!event)return;
  return {seq:v.seq as number,event,accepted:v.accepted,reason:v.reason};
}
function checkpoint(value:unknown):RetryCheckpoint|undefined {
  const v=object(value,['version','session','capacity','concurrency','count','hash','sealed']);
  if(!v||v.version!==1||typeof v.session!=='string'||!Number.isSafeInteger(v.capacity)||
    !Number.isSafeInteger(v.concurrency)||!Number.isSafeInteger(v.count)||(v.count as number)<0||
    (v.count as number)>LIMIT||typeof v.hash!=='string'||!/^[0-9a-f]{64}$/.test(v.hash)||
    typeof v.sealed!=='boolean')return;
  createRetryLedger(v.session,v.capacity as number,v.concurrency as number);
  return v as unknown as RetryCheckpoint;
}
async function digest(previous:string,value:unknown):Promise<string> {
  const bytes=encoder.encode(previous+'\n'+JSON.stringify(value));
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
}
function seed(state:RetryLedger) {return {version:1,session:state.session,capacity:state.capacity,concurrency:state.concurrency};}
function immutableRecord(item:RetryRecord):RetryRecord {
  if('receipt' in item.event)Object.freeze(item.event.receipt);
  Object.freeze(item.event);
  return Object.freeze(item);
}

/** The sink must durably store each record in order and reject on failure.
 * The caller persists the final checkpoint separately only after all records.
 * A crash, failed sink or event limit yields no sealed checkpoint. */
export async function createRetryRecorder(session:string,capacity:number,concurrency:number,
  sink:(record:RetryRecord)=>Promise<void>) {
  let state=createRetryLedger(session,capacity,concurrency),hash=await digest(ZERO,seed(state));
  let count=0,busy=false,failed=false,closed=false;
  return {
    async append(input:unknown):Promise<RetryRecord> {
      if(busy||failed||closed)throw Error('Recorder unavailable');
      if(count>=LIMIT){failed=true;throw Error('Record limit reached');}
      busy=true;
      try {
        const event=parseRetryEvent(input);
        if(!event)throw Error('Invalid event');
        const transition=reduceRetryLedger(state,event);
        const item=immutableRecord({seq:count+1,event,accepted:transition.accepted,reason:transition.reason});
        const nextHash=await digest(hash,item);
        await sink(item);
        state=transition.state;hash=nextHash;count++;
        return item;
      } catch(error) {failed=true;throw error;} finally {busy=false;}
    },
    close():RetryCheckpoint {
      if(busy)throw Error('Recorder busy');
      closed=true;
      return {...seed(state),version:1,count,hash,sealed:!failed};
    },
  };
}

export type RetryReplayResult =
  | {ok:true;state:RetryLedger;count:number;physicalSourceVerified:false;scannerIntegrated:false}
  | {ok:false;reason:string;physicalSourceVerified:false;scannerIntegrated:false};
/** Rebuild from the beginning; never restore a deserialized reducer state.
 * A matching checkpoint confirms only a complete, self-consistent event log. */
export async function replayRetryRecords(values:Iterable<unknown>,rawCheckpoint:unknown):Promise<RetryReplayResult> {
  const fail=(reason:string):RetryReplayResult=>({ok:false,reason,physicalSourceVerified:false,scannerIntegrated:false});
  try {
    const expected=checkpoint(rawCheckpoint);
    if(!expected||!expected.sealed)return fail('invalid-or-unsealed-checkpoint');
    let state=createRetryLedger(expected.session,expected.capacity,expected.concurrency);
    let hash=await digest(ZERO,seed(state)),count=0;
    for(const value of values) {
      if(count>=LIMIT||count>=expected.count)return fail('unexpected-record');
      const item=record(value);
      if(!item||item.seq!==count+1)return fail('invalid-sequence-or-record');
      const transition=reduceRetryLedger(state,item.event);
      if(transition.accepted!==item.accepted||transition.reason!==item.reason)return fail('decision-mismatch');
      state=transition.state;hash=await digest(hash,item);count++;
    }
    if(count!==expected.count)return fail('missing-record');
    if(hash!==expected.hash)return fail('hash-mismatch');
    return {ok:true,state,count,physicalSourceVerified:false,scannerIntegrated:false};
  } catch {return fail('invalid-input');}
}
