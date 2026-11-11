/** Detached experiment. A conditional result is not a scanner completion
 * decision: the verifier is an external trust boundary and is not implemented
 * by the live scanner. In particular, IDs, timestamps, and counts alone cannot
 * authenticate pixels, physical input, identity, or an entire inventory. The
 * existing drain-loss summary has no verified boundary time, account/sort
 * epoch or coverage, so it cannot supply this verifier and stays unresolved. */
export interface GapSource {
 readonly sessionId:string; readonly accountEpoch:string; readonly sortEpoch:string;
 readonly frameId:string; readonly observationId:string; readonly slot:number;
 readonly captureOrder:number; readonly captureTime:number;
}
export interface GapBoundary { readonly kind:'gap'|'obstruction'|'sort-change'; readonly source:GapSource }
export interface GapInventory { readonly sessionId:string; readonly accountEpoch:string; readonly sortEpoch:string;
 readonly ids:readonly string[]; readonly complete:boolean }
export interface GapRead { readonly source:GapSource; readonly id:string; readonly directName:boolean;
 readonly usable:boolean; readonly awakening:number; readonly copies:number; readonly fieldEvidence:'single'|'repeat' }
export interface GapCandidate { readonly id:string; readonly primary:unknown; readonly corroboration?:unknown }
export interface GapVerifier {
 /** Verify the boundary against its input provenance, including gap end. */
 verifyBoundary(token:unknown):GapBoundary|undefined;
 /** Independently authenticate the complete current-run inventory; a header
  * count or caller-supplied names is insufficient. */
 verifyInventory(token:unknown):GapInventory|undefined;
 /** Bind name, both fields, quality and their source to this exact input. */
 verifyRead(token:unknown):GapRead|undefined;
}
export type GapRecoveryResult = Readonly<{status:'unresolved'|'conditional';reason:string;checked:number}>;

const id=(x:unknown):x is string=>typeof x==='string'&&x.length>0&&x.length<=160;
const uint=(x:unknown):x is number=>Number.isSafeInteger(x)&&(x as number)>=0;
function source(s:GapSource|undefined):s is GapSource {
 return !!s&&id(s.sessionId)&&id(s.accountEpoch)&&id(s.sortEpoch)&&id(s.frameId)&&id(s.observationId)&&
  uint(s.slot)&&s.slot<40&&uint(s.captureOrder)&&Number.isFinite(s.captureTime)&&s.captureTime>=0;
}
const later=(a:GapSource,b:GapSource)=>a.sessionId===b.sessionId&&a.accountEpoch===b.accountEpoch&&a.sortEpoch===b.sortEpoch&&
 a.frameId!==b.frameId&&a.observationId!==b.observationId&&a.captureOrder>b.captureOrder&&a.captureTime>b.captureTime;
function read(value:GapRead|undefined,cardId:string,barrier:GapSource):value is GapRead {
 if(!value||!source(value.source)||!later(value.source,barrier)||value.id!==cardId||value.directName!==true||value.usable!==true||
  !uint(value.awakening)||value.awakening>5||!uint(value.copies)||value.copies>15-value.awakening*(value.awakening+1)/2)return false;
 return value.fieldEvidence==='single'||value.fieldEvidence==='repeat';
}

/** Stateless sweep for one or more unresolved boundaries, in capture order.
 * All later obstructions raise the barrier. A changed sort or account/session
 * invalidates this sweep rather than reassigning cards by position. */
export function evaluateGapRecovery(boundaries:readonly unknown[],inventoryToken:unknown,candidates:readonly GapCandidate[],
 verifier?:GapVerifier):GapRecoveryResult {
 const fail=(reason:string,checked=0):GapRecoveryResult=>({status:'unresolved',reason,checked});
 if(!verifier)return fail('source verifier unavailable');
 if(!Array.isArray(boundaries)||boundaries.length===0||boundaries.length>64)return fail('gap boundary missing or exceeds limit');
 if(!Array.isArray(candidates)||candidates.length>550)return fail('invalid candidate set');
 try {
  let latest:GapSource|undefined,hasGap=false;
  for(const token of boundaries){
   const event=verifier.verifyBoundary(token);
   if(!event||!['gap','obstruction','sort-change'].includes(event.kind)||!source(event.source))return fail('unverified boundary');
   if(event.kind==='sort-change')return fail('sort changed; new sweep required');
   if(latest&&(event.source.sessionId!==latest.sessionId||event.source.accountEpoch!==latest.accountEpoch||
     event.source.sortEpoch!==latest.sortEpoch))return fail('boundary epoch mismatch');
   if(latest&&(event.source.captureOrder<=latest.captureOrder||event.source.captureTime<=latest.captureTime||
     event.source.frameId===latest.frameId))return fail('boundary chronology mismatch');
   hasGap ||= event.kind==='gap';latest=event.source;
  }
  if(!hasGap||!latest)return fail('gap boundary missing');
  const inventory=verifier.verifyInventory(inventoryToken);
  if(!inventory||inventory.complete!==true||inventory.sessionId!==latest.sessionId||inventory.accountEpoch!==latest.accountEpoch||
    inventory.sortEpoch!==latest.sortEpoch||!Array.isArray(inventory.ids)||inventory.ids.length===0||inventory.ids.length>550||
    inventory.ids.some(x=>!id(x))||new Set(inventory.ids).size!==inventory.ids.length)
   return fail('unverified complete inventory');
  if(candidates.length!==inventory.ids.length)return fail('incomplete sweep');
  const expected=new Set(inventory.ids),seen=new Set<string>(),owners=new Map<string,string>();let checked=0;
  const owner=(s:GapSource,cardId:string)=>{const key=JSON.stringify([s.sessionId,s.frameId,s.slot]),old=owners.get(key);
   if(old!==undefined&&old!==cardId)return false;owners.set(key,cardId);return true;};
  for(const candidate of candidates){
   if(!candidate||!id(candidate.id)||!expected.has(candidate.id)||seen.has(candidate.id))return fail('candidate identity mismatch',checked);
   const first=verifier.verifyRead(candidate.primary);
   if(!read(first,candidate.id,latest)||!owner(first.source,candidate.id))return fail('unverified direct reading',checked);
   if(first.fieldEvidence==='repeat'){
    const second=verifier.verifyRead(candidate.corroboration);
    if(!read(second,candidate.id,latest)||!later(second.source,first.source)||!owner(second.source,candidate.id)||
      first.awakening!==second.awakening||first.copies!==second.copies)
     return fail('unverified independent repetition',checked);
   }
   seen.add(candidate.id);checked++;
  }
  return {status:'conditional',reason:'dependent on external source, inventory and reader verification',checked};
 }catch{return fail('verification failed');}
}
