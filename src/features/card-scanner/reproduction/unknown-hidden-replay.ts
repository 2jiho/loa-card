import {HiddenUnknownGuard,type HiddenDiagnosticEvent} from '../session/unknown-hidden-guard';

/** Detached validation only. The producing recorder must bind the ordered
 * events and checkpoint to a verified archive; these hashes authenticate
 * neither pixels nor the identity claimed by a reader. */
const ZERO='0'.repeat(64);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
  (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const exact=(value:Record<string,unknown>,keys:readonly string[])=>
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>object(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
async function digest(value:string):Promise<string>{
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Hash one ordered producer event. A recorder must serialize calls and prove
 * its own durable writes; this function does not acknowledge storage. */
export async function hiddenGuardEventHash(previous:string,sequence:number,event:HiddenDiagnosticEvent):Promise<string>{
  if(!hash(previous)||!integer(sequence)||sequence<1)throw Error('Invalid hidden event hash input');
  return digest(`${previous}\n${sequence}\n${stable(event)}`);
}
export async function hiddenGuardStateHash(guard:HiddenUnknownGuard):Promise<string>{
  return digest(stable(guard.replaySnapshot()));
}
export interface HiddenGuardCheckpoint {
  readonly version:1;readonly events:number;readonly eventHash:string;readonly stateHash:string;
  /** Producer declaration: false includes a dropped, unaccepted or unsealed event. */
  readonly complete:boolean;
}
export class HiddenGuardReplay {
  private guard?:HiddenUnknownGuard;
  private count=0;
  private chain=ZERO;
  private maxEvents=0;
  private invalid=false;
  private busy=false;
  private matched:boolean|null=null;
  private emitted:HiddenDiagnosticEvent|undefined;

  /** Events must be admitted in producer order. Duplicate, missing, concurrent
   * or malformed calls invalidate this replay instead of guessing an order. */
  async accept(sequence:number,value:unknown):Promise<void>{
    if(this.invalid||this.busy||!integer(sequence)||sequence!==this.count+1){this.invalid=true;throw Error('Invalid hidden event sequence');}
    this.busy=true;this.matched=null;
    try{
      if(!object(value)||value.version!==1||typeof value.kind!=='string')throw Error('Invalid hidden event');
      this.emitted=undefined;
      if(value.kind==='seed'){
        if(this.guard||!exact(value,['version','kind','sessionId','limits'])||typeof value.sessionId!=='string'||
           !object(value.limits)||!exact(value.limits,['active','proofs','events'])||
           !integer(value.limits.active)||!integer(value.limits.proofs)||!integer(value.limits.events)||
           value.limits.active>128||value.limits.proofs>10_000||value.limits.events<1||value.limits.events>20_000)
          throw Error('Invalid hidden seed');
        this.guard=new HiddenUnknownGuard(value.sessionId,{active:value.limits.active,proofs:value.limits.proofs,
          events:value.limits.events,record:event=>{this.emitted=event;return true;}});
        this.maxEvents=value.limits.events;
      }else{
        if(!this.guard||this.count>=this.maxEvents)throw Error('Missing seed or event capacity exceeded');
        // Apply the same checked transition used by the live guard.
        if(value.kind==='failure'){
          if(!exact(value,['version','kind','reason','fact'])||typeof value.reason!=='string'||
             !['suppressed','replaced','retired','unreported'].includes(value.reason))
            throw Error('Invalid hidden failure');
          const before=this.guard.summary().events;
          this.guard.failure(value.fact as Parameters<HiddenUnknownGuard['failure']>[0],value.reason as Parameters<HiddenUnknownGuard['failure']>[1]);
          if(this.guard.summary().events!==before+1)throw Error('Unrecordable hidden failure');
        }else if(value.kind==='confirmed'){
          if(!exact(value,['version','kind','key','source','cardId']))throw Error('Invalid hidden confirmation');
          this.guard.confirmed(value.key as Parameters<HiddenUnknownGuard['confirmed']>[0],
            value.source as Parameters<HiddenUnknownGuard['confirmed']>[1],value.cardId as string,[]);
        }else throw Error('Unknown hidden event');
      }
      const emitted=this.emitted;
      if(!emitted||stable(emitted)!==stable(value))throw Error('Hidden event mismatch');
      this.chain=await hiddenGuardEventHash(this.chain,sequence,emitted);
      this.count=sequence;
    }catch(error){this.invalid=true;throw error;}finally{this.busy=false;}
  }
  /** The caller must only declare complete after all events and the checkpoint
   * are durably bound to the same archive. A producer declaration is not proof. */
  async checkpoint(value:unknown):Promise<boolean|null>{
    if(this.invalid||!this.guard)return null;
    if(this.busy){this.invalid=true;this.matched=null;return null;}
    const keys=['version','events','eventHash','stateHash','complete'] as const;
    if(!object(value)||!exact(value,keys)||Reflect.ownKeys(value).length!==keys.length){
      this.invalid=true;return null;
    }
    const descriptors=keys.map(key=>Object.getOwnPropertyDescriptor(value,key));
    if(descriptors.some(descriptor=>!descriptor||!('value' in descriptor)||!descriptor.enumerable)){
      this.invalid=true;return null;
    }
    const [version,events,eventHash,expectedStateHash,complete]=descriptors.map(descriptor=>descriptor!.value);
    if(version!==1||!integer(events)||!hash(eventHash)||!hash(expectedStateHash)||typeof complete!=='boolean'){
      this.invalid=true;return null;
    }
    if(!complete){this.matched=null;return null;}
    this.matched=null;this.busy=true;
    try{
      const stateHash=await hiddenGuardStateHash(this.guard);
      if(this.invalid){this.matched=null;return null;}
      this.matched=events===this.count&&eventHash===this.chain&&expectedStateHash===stateHash;
      return this.matched;
    }catch(error){this.invalid=true;throw error;}finally{this.busy=false;}
  }
  get summary(){return {version:1 as const,events:this.count,eventHash:this.chain,
    matchesCheckpoint:this.invalid||this.busy?null:this.matched,invalid:this.invalid,active:this.guard?.summary().active??null,
    evidenceLost:this.guard?.summary().evidenceLost??null};}
}
