import {UnidentifiedObstructionFence,unidentifiedObstruction} from '../session/completion-obstruction-debt';
import type {AcquisitionCapture} from '../capture/capture-provenance';

export interface ObstructionSeed {version:1|2;sessionId:string;seedOrder:number}
export type ObstructionEvent = {version:1;kind:'notice';sessionId:string;processingFrame:number;acquisitionFrameId:number;observationId:string;captureTime:number;slot:number;preBorderKind:'tooltip'|'name-hidden'} |
 {version:2;kind:'notice';sessionId:string;processingFrame:number;acquisitionFrameId:number;observationId:string;captureTime:number;slot:number;preBorderKind:'tooltip'|'name-hidden';phase:'input'|'recovery'};
export interface ObstructionCheckpoint {version:1;complete:boolean;events:number;order:number|null;invalid:boolean;expected:number|null;pending:number;hash:string|null}
const number=(v:unknown,min=0):v is number=>Number.isSafeInteger(v)&&(v as number)>=min;
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=160;
function plain(v:unknown,keys:string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error('Invalid obstruction fact');
 const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))throw Error('Invalid obstruction fields');
 const out:Record<string,unknown>=Object.create(null);for(const key of keys){const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!d.enumerable||!('value' in d))throw Error('Invalid obstruction property');out[key]=d.value;}return out;
}
export function parseObstructionSeed(input:unknown):ObstructionSeed{
 const s=plain(input,['version','sessionId','seedOrder']);if((s.version!==1&&s.version!==2)||!id(s.sessionId)||!number(s.seedOrder))throw Error('Invalid obstruction seed');
 return {version:s.version,sessionId:s.sessionId,seedOrder:s.seedOrder};
}
export function parseObstructionEvent(input:unknown):ObstructionEvent{
 const version=input&&typeof input==='object'?Object.getOwnPropertyDescriptor(input,'version')?.value:undefined;
 const s=plain(input,['version','kind','sessionId','processingFrame','acquisitionFrameId','observationId','captureTime','slot','preBorderKind',...(version===2?['phase']:[])]);
 if((s.version!==1&&s.version!==2)||s.version===2&&!['input','recovery'].includes(s.phase as string)||s.kind!=='notice'||!id(s.sessionId)||!id(s.observationId)||!number(s.processingFrame,1)||!number(s.acquisitionFrameId,1)||
  typeof s.captureTime!=='number'||!Number.isFinite(s.captureTime)||s.captureTime<0||!number(s.slot)||s.slot>=40||!['tooltip','name-hidden'].includes(s.preBorderKind as string))throw Error('Invalid obstruction notice');
 return s as unknown as ObstructionEvent;
}
export function parseObstructionCheckpoint(input:unknown):ObstructionCheckpoint{
 const s=plain(input,['version','complete','events','order','invalid','expected','pending','hash']);
 if(s.version!==1||typeof s.complete!=='boolean'||!number(s.events)||!(s.order===null||number(s.order))||typeof s.invalid!=='boolean'||
  !(s.expected===null||number(s.expected)&&s.expected<=2000)||!number(s.pending)||s.pending>2001||
  !(s.hash===null||typeof s.hash==='string'&&/^[a-f0-9]{64}$/.test(s.hash))||s.complete&&s.hash===null||!s.complete&&s.hash!==null)throw Error('Invalid obstruction checkpoint');
 return s as unknown as ObstructionCheckpoint;
}
/** Hashes reducer state and its inventory proof inputs, never pixels or OCR truth. */
export async function hashObstructionEvidence(snapshot:{order:number|null;invalid:boolean},expected:number|null,
 latest:ReadonlyMap<string,number>,names:ReadonlyMap<string,number>,fields:ReadonlyMap<string,number>):Promise<string>{
 const sorted=(map:ReadonlyMap<string,number>)=>[...map].sort(([a],[b])=>a<b?-1:a>b?1:0);
 const json=JSON.stringify({version:1,snapshot,expected,latest:sorted(latest),names:sorted(names),fields:sorted(fields)});
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export class ObstructionEvidenceReplay {
 private seedValue?:ObstructionSeed;private fence?:UnidentifiedObstructionFence;private events=0;private checkpointValue?:ObstructionCheckpoint;
 private candidate?:AcquisitionCapture;private required=false;private lastInputTime=-1;private lastFrame=0;private lastInputSourceFrame=0;private invalid=false;private revision=0;
 private readonly signal:AbortSignal;
 private readonly maps:()=>{latest:ReadonlyMap<string,number>;names:ReadonlyMap<string,number>;fields:ReadonlyMap<string,number>};
 constructor(signal:AbortSignal,maps:()=>{latest:ReadonlyMap<string,number>;names:ReadonlyMap<string,number>;fields:ReadonlyMap<string,number>}){this.signal=signal;this.maps=maps;}
 private check(){this.signal.throwIfAborted();if(this.invalid)throw Error('Invalid obstruction replay');}
 private fail(message:string):never{this.invalid=true;throw Error(message);}
 seed(value:unknown){this.check();const s=parseObstructionSeed(value);if(this.seedValue)this.fail('Duplicate obstruction seed');this.maps();this.seedValue=s;this.fence=new UnidentifiedObstructionFence();this.revision++;}
 acquisition(a:AcquisitionCapture){this.check();if(!this.seedValue)return;if(this.required)this.fail('Missing obstruction notice');
  this.candidate=a;this.required=a.sessionId===this.seedValue.sessionId&&(a.phase==='input'||this.seedValue.version===2&&a.phase==='recovery')&&a.capture.complete===true&&
   unidentifiedObstruction({complete:true,intact:a.capture.intact===true,quality:a.quality,preBorder:a.capture.preBorder});}
 accept(value:unknown){this.check();const e=parseObstructionEvent(value),a=this.candidate,s=this.seedValue;if(!s||!this.fence)this.fail('Missing obstruction seed');
  const phase=e.version===1?'input':e.phase;
  if(!a||!this.required||e.version!==s.version||phase!==a.phase||e.sessionId!==s.sessionId||e.sessionId!==a.sessionId||e.processingFrame!==a.processingFrame||
   e.acquisitionFrameId!==a.acquisitionFrameId||e.observationId!==a.observationId||e.captureTime!==a.captureTime||e.slot!==a.slot||
   e.preBorderKind!==a.capture.preBorder?.kind||e.processingFrame<this.lastFrame||
   phase==='input'&&(e.captureTime<this.lastInputTime||e.acquisitionFrameId<this.lastInputSourceFrame))
   this.fail('Obstruction acquisition or chronology mismatch');
  this.fence.notice(e.captureTime,s.seedOrder);this.events++;this.required=false;this.candidate=undefined;
  if(phase==='input'){this.lastInputTime=e.captureTime;this.lastInputSourceFrame=e.acquisitionFrameId;}
  this.lastFrame=e.processingFrame;this.checkpointValue=undefined;this.revision++;
 }
 proofsChanged(){this.check();this.checkpointValue=undefined;this.revision++;}
 checkpoint(value:unknown){this.check();if(!this.fence)this.fail('Missing obstruction seed');if(this.required)this.fail('Missing obstruction notice');
  const c=parseObstructionCheckpoint(value);if(c.events<this.events||c.complete&&c.events!==this.events)this.fail('Obstruction event count mismatch');this.checkpointValue=c;this.revision++;}
 async summary(){this.check();const fence=this.fence,c=this.checkpointValue,revision=this.revision;if(!fence)return {supported:false,complete:false,events:0,pending:null,hash:null,expectedHash:null,matchesCapturedState:null,scope:'reducer-state-only' as const,physicalInputVerified:false,headerVerified:false,independentCardSourcesVerified:false};
  const snap=fence.snapshot(),maps=this.maps(),expected=c?.expected??null,pending=fence.pending(expected,[...maps.latest.keys()],maps.names,maps.fields);
  const hash=await hashObstructionEvidence(snap,expected,maps.latest,maps.names,maps.fields);this.check();
  const complete=!!c?.complete&&c.events===this.events&&!this.required&&revision===this.revision&&c.order===snap.order&&c.invalid===snap.invalid&&c.pending===pending;
  return {supported:true,complete,events:this.events,pending,hash,expectedHash:complete?c!.hash:null,matchesCapturedState:complete?hash===c!.hash:null,scope:'reducer-state-only' as const,physicalInputVerified:false,headerVerified:false,independentCardSourcesVerified:false};
 }
}
