/** Conservative, detached experiment for evaluating source-bound re-observation.
 * This is not wired into the scanner. A caller-provided verifier is an external
 * trust boundary: even a 'conditional' result does not authenticate pixels,
 * capture devices, recognizer output, account, sort or physical frame identity. */
export interface ReobservedSource {
 readonly sessionId:string;readonly accountEpoch:string;readonly sortEpoch:string;
 readonly physicalFrame:string;readonly observationId:string;readonly slot:number;
 readonly captureTime:number;readonly captureOrder:number;
}
export interface ReobservedRead {
 readonly source:ReobservedSource;
 /** Direct name read for this source, not a retained/sort-inferred identity. */
 readonly directName:{readonly id:string;readonly verified:boolean};
 /** Values from this one source, with evidence classification supplied by verifier. */
 readonly fields:{readonly awakening:number;readonly copies:number;readonly evidence:'single'|'repeat-candidate';readonly verified:boolean};
 readonly usable:boolean;
}
export interface ReobservedCandidate {readonly id:string;readonly primary:unknown;readonly corroboration?:unknown}
export interface ReobservationVerifier {
 /** Must establish physical frame and account/sort epoch, not just parse strings. */
 verifyBarrier(token:unknown):ReobservedSource|undefined;
 /** Must bind direct name, both field values, and quality to this physical input. */
 verifyRead(token:unknown):ReobservedRead|undefined;
}
export interface ReobservationResult {readonly status:'unresolved'|'conditional';readonly reason:string;readonly checked:number}
const identifier=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=160;
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
function validSource(s:ReobservedSource|undefined):s is ReobservedSource {
 return !!s&&identifier(s.sessionId)&&identifier(s.accountEpoch)&&identifier(s.sortEpoch)&&identifier(s.physicalFrame)&&identifier(s.observationId)&&
  integer(s.slot)&&s.slot<40&&integer(s.captureOrder)&&typeof s.captureTime==='number'&&Number.isFinite(s.captureTime)&&s.captureTime>=0;
}
function later(a:ReobservedSource,b:ReobservedSource):boolean {
 return a.sessionId===b.sessionId&&a.accountEpoch===b.accountEpoch&&a.sortEpoch===b.sortEpoch&&a.physicalFrame!==b.physicalFrame&&
  a.observationId!==b.observationId&&a.captureTime>b.captureTime&&a.captureOrder>b.captureOrder;
}
function validRead(r:ReobservedRead|undefined,id:string,barrier:ReobservedSource):r is ReobservedRead {
 const a=r?.fields?.awakening,c=r?.fields?.copies;
 return !!r&&validSource(r.source)&&later(r.source,barrier)&&r.usable===true&&r.directName?.verified===true&&r.directName.id===id&&
  r.fields?.verified===true&&integer(a)&&a<=5&&integer(c)&&c<=15-a*(a+1)/2&&
  (r.fields.evidence==='single'||r.fields.evidence==='repeat-candidate');
}
/** All IDs must independently pass; there is no fallback to counts or positions.
 * A successful result is conditional on caller verification, never scanner proof. */
export function evaluateReobservationSweep(barrierToken:unknown,ids:readonly string[],candidates:readonly ReobservedCandidate[],verifier?:ReobservationVerifier):ReobservationResult {
 const fail=(reason:string,checked=0):ReobservationResult=>({status:'unresolved',reason,checked});
 if(!verifier)return fail('source verifier unavailable');
 if(!Array.isArray(ids)||!ids.length||ids.length>550||ids.some(id=>!identifier(id))||new Set(ids).size!==ids.length||
  !Array.isArray(candidates)||candidates.length!==ids.length)return fail('incomplete candidate set');
 try {
  const barrier=verifier.verifyBarrier(barrierToken);if(!validSource(barrier))return fail('unverified barrier');
  const expected=new Set(ids),seen=new Set<string>(),owners=new Map<string,string>();let checked=0;
  const owner=(source:ReobservedSource,id:string)=>{const key=JSON.stringify([source.sessionId,source.physicalFrame,source.slot]);
   const prior=owners.get(key);if(prior!==undefined&&prior!==id)return false;owners.set(key,id);return true;};
  for(const candidate of candidates){
   if(!candidate||!identifier(candidate.id)||!expected.has(candidate.id)||seen.has(candidate.id))return fail('candidate identity mismatch',checked);
   const first=verifier.verifyRead(candidate.primary);if(!validRead(first,candidate.id,barrier)||!owner(first.source,candidate.id))return fail('unverified direct reading',checked);
   if(first.fields.evidence==='repeat-candidate'){
    const second=verifier.verifyRead(candidate.corroboration);
    if(!validRead(second,candidate.id,barrier)||!later(second.source,first.source)||!owner(second.source,candidate.id)||
      second.fields.awakening!==first.fields.awakening||second.fields.copies!==first.fields.copies)
      return fail('unverified independent repetition',checked);
   }
   seen.add(candidate.id);checked++;
  }
  return {status:'conditional',reason:'dependent on external source and reader verification',checked};
 } catch {return fail('verification failed');}
}
