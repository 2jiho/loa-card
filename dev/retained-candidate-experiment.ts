import {admitRetryCandidate,retryCandidateIndex,type RetrySourceCandidate} from '../src/features/card-scanner/session/retry-candidate';

// Isolated prototype: not connected to the live or replay scanner.
/** Development experiment accounting for transferred Canvas ownership.
 * This bounds estimated RGBA bytes, not GPU, browser or JS heap memory. It
 * cannot establish pixels, identity, freshness or a complete recording. */
export class RetainedRasterBudget {
  private readonly images=new Map<object,{bytes:number;resources:readonly object[]}>();
  private readonly owners=new WeakMap<object,object>();
  private readonly limit:number;
  private bytes=0;private highWater=0;
  constructor(limit=8*1024*1024) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>8*1024*1024)throw new RangeError('Invalid retained raster limit');
    this.limit=limit;
  }
  reserve(image:{width:number;height:number},preview?:{width:number;height:number}):'reserved'|'full'|'invalid'|'ownership-conflict' {
    if(!image||typeof image!=='object'||preview!==undefined&&(!preview||typeof preview!=='object'))return 'invalid';
    const resources=preview?[image,preview]:[image];
    // Guard canvas identities across roles as well as across reservations.
    // A primary image can otherwise alias another candidate's preview.
    if(new Set(resources).size!==resources.length||resources.some(resource=>this.owners.has(resource)))return 'ownership-conflict';
    const estimate=(r:{width:number;height:number})=>Number.isSafeInteger(r.width)&&Number.isSafeInteger(r.height)&&
      r.width>0&&r.height>0&&Number.isSafeInteger(r.width*r.height*4)?r.width*r.height*4:null;
    const primary=estimate(image),extra=preview?estimate(preview):0;
    if(primary===null||extra===null||!Number.isSafeInteger(primary+extra))return 'invalid';
    const size=primary+extra;
    if(size>this.limit-this.bytes)return 'full';
    this.images.set(image,{bytes:size,resources});
    for(const resource of resources)this.owners.set(resource,image);
    this.bytes+=size;this.highWater=Math.max(this.highWater,this.bytes);return 'reserved';
  }
  release(image:object):boolean {
    const reservation=this.images.get(image);if(!reservation)return false;
    this.images.delete(image);
    for(const resource of reservation.resources)this.owners.delete(resource);
    this.bytes-=reservation.bytes;return true;
  }
  snapshot(){return {active:this.images.size,estimatedBytes:this.bytes,peakEstimatedBytes:this.highWater,limitBytes:this.limit};}
}

type Retainable = RetrySourceCandidate & {image:{width:number;height:number};previewCanvas?:HTMLCanvasElement;
  previewTask?:Promise<string>;knownIdentity?:unknown;verifiedVisual?:unknown;
  order:number;stable:boolean;borderAlignment:number};
/** Transfer one still-queued source into the existing retry lane. The original
 * queue owns `item` until this returns queued; no reader, location or fuzzy
 * group can supply its identity. The caller releases it on full/invalid and
 * must abort on ownership conflict. Estimated RGBA is bounded separately. */
export function retainSupersededCandidate<T extends Retainable>(item:T,replacement:T,target:T[],other:T[],
 capacity:number,budget:RetainedRasterBudget):'queued'|'full'|'invalid'|'ownership-conflict' {
 const candidate={...item,needsIdentity:true,fieldTarget:undefined,knownIdentity:undefined,verifiedVisual:undefined} as T;
 const shares=(a:T,b:T)=>{
  const owned=[a.image,a.previewCanvas].filter(Boolean),otherOwned=[b.image,b.previewCanvas].filter(Boolean);
  return owned.some(resource=>otherOwned.includes(resource))||
   !!a.execution&&a.execution===b.execution||!!a.savedObservation&&a.savedObservation===b.savedObservation;
 };
 if(shares(item,replacement)||other.some(value=>shares(item,value))||target.some(value=>shares(item,value))||item.previewTask||retryCandidateIndex(target,candidate)>=0)
  return 'ownership-conflict';
 const reservation=budget.reserve(item.image,item.previewCanvas);
 if(reservation!=='reserved')return reservation;
 try {
  const admission=admitRetryCandidate(target,candidate,capacity,()=>{throw Error('Unexpected retained-source replacement');});
  if(admission==='queued')return 'queued';
  budget.release(item.image);
  return admission==='ownership-conflict'?'ownership-conflict':admission==='full'?'full':'invalid';
 }catch(error){budget.release(item.image);throw error;}
}
