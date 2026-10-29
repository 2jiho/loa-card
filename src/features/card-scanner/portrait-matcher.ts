import type { Reference } from './recognizer';
import { normalizeName } from './card-dictionary';
import { rankPortraitPair as rankCards } from './portrait-ranking';
export interface PortraitEvidence { upper: number; lower: number; correlation: number; margin: number;
 region?: 'above-badge'; left?: number; right?: number; registration?:'quarter-cell-v1' }
export interface PortraitTextEvidence { rawText?: string; ocrConfidence: number; score: number; gap: number;
 complete?: boolean; canonicalName?: string }
export const MAX_PORTRAIT_DIAGNOSTIC_STAGES=4;
export const MAX_PORTRAIT_DIAGNOSTIC_CANDIDATES=2;
export const MAX_PORTRAIT_DIAGNOSTIC_ID_CHARS=96;
export type PortraitDiagnosticStage='normal'|'above-badge'|'refined-normal'|'refined-above-badge';
export interface PortraitDiagnosticBox {readonly x:number;readonly y:number;readonly width:number;readonly height:number}
export interface PortraitNumericGateChecks {
 readonly upper:boolean;readonly lower:boolean;readonly correlation:boolean;readonly margin:boolean;
 readonly left:boolean|null;readonly right:boolean|null;
}
export interface PortraitTextGateChecks extends PortraitNumericGateChecks {
 readonly visibleLength:boolean;readonly complete:boolean|null;readonly hangulComplete:boolean|null;
 readonly ocrConfidence:boolean;readonly score:boolean;readonly gap:boolean;
}
export interface PortraitDiagnosticCandidate {
 readonly id:string;readonly idTruncated:boolean;
 readonly upper:number;readonly lower:number;readonly left:number|null;readonly right:number|null;
 readonly correlation:number;
 /** Top1 minus top2, or top2 minus top1. Never a second/third ranking gap. */
 readonly margin:number;
 /** Only the ranked winner is considered for acceptance; numeric gate execution
  * is reported separately by decision.independent/text.evaluated. */
 readonly evaluatedForAcceptance:boolean;
 readonly registration:Readonly<{dx:number;dy:number;interpolation:'integer'|'bilinear'}>|null;
 /** Sample origins/counts in the24x32 gray grid, before bilinear interpolation. */
 readonly roi:Readonly<{upper:PortraitDiagnosticBox;lower:PortraitDiagnosticBox;left:PortraitDiagnosticBox|null;right:PortraitDiagnosticBox|null}>|null;
}
export interface PortraitStageDiagnostic {
 readonly stage:PortraitDiagnosticStage;readonly queryCount:number;
 readonly candidates:readonly PortraitDiagnosticCandidate[];
 readonly decision:Readonly<{
  textIdMatches:boolean|null;
  independent:Readonly<{evaluated:boolean;passed:boolean|null;checks:Readonly<PortraitNumericGateChecks>|null}>;
  text:Readonly<{evaluated:boolean;passed:boolean|null;checks:Readonly<PortraitTextGateChecks>|null}>;
  accepted:boolean;
 }>;
}
export interface PortraitMatchDiagnostic {
 readonly version:1;readonly coordinateSpace:'gray-grid-24x32';
 readonly outcome:'accepted'|'rejected'|'unavailable';
 readonly reason:'accepted'|'invalid-gray-size'|'insufficient-identities'|'missing-text-reference'|'fractional-disabled'|'not-near'|'all-stages-rejected';
 readonly fractionalRegistration:boolean;readonly referenceIdentities:number;
 readonly text:Readonly<{id:string;idTruncated:boolean;ocrConfidence:number|null;score:number|null;gap:number|null;
  complete:boolean|null;visibleNameLength:number;canonicalNameLength:number}>|null;
 readonly stages:readonly PortraitStageDiagnostic[];
}
/** Synchronous, invocation-scoped observer. Exceptions cannot change a match.
 * Only evaluated stages/top2 measurements are retained; no pixels or full rank. */
export type PortraitDiagnosticObserver=(diagnostic:PortraitMatchDiagnostic)=>void;

type DiagnosticRanked={card:Reference;upper:number;lower:number;left?:number;right?:number;correlation:number;queryIndex?:number};
type DiagnosticQuery={dx?:number;dy?:number};
function numericChecks(p:PortraitEvidence,text=false):Readonly<PortraitNumericGateChecks> {
 const masked=p.region==='above-badge';
 return Object.freeze({upper:p.upper>=(text&&masked ? .85 : .91),lower:p.lower>=(text&&masked ? .85 : .91),
  correlation:p.correlation>=(text ? masked ? .86 : .93 : .94),margin:p.margin>=(text ? masked ? .35 : .3 : .2),
  left:masked?(p.left??0)>=(text ? .84 : .9):null,right:masked?(p.right??0)>=(text ? .84 : .9):null});
}
function textChecks(p:PortraitEvidence,text:PortraitTextEvidence):Readonly<PortraitTextGateChecks> {
 const masked=p.region==='above-badge',visible=normalizeName(text.rawText??''),canonical=normalizeName(text.canonicalName??'');
 return Object.freeze({...numericChecks(p,true),visibleLength:masked?visible.length>=2&&visible.length===canonical.length:visible.length>=3,
  complete:masked?text.complete===true:null,hangulComplete:masked?!/[ㄱ-ㅎㅏ-ㅣ]/.test(visible):null,
  ocrConfidence:text.ocrConfidence>=(masked?50:65),score:text.score>=.83,gap:masked?text.gap>=.4:text.gap+1e-9>=.2});
}
function recordDiagnosticStage(stages:PortraitStageDiagnostic[],stage:PortraitDiagnosticStage,ranked:DiagnosticRanked[],queries:DiagnosticQuery[],
 text:(PortraitTextEvidence&{id:string})|undefined,accepted:boolean) {
 const masked=stage==='above-badge'||stage==='refined-above-badge';
 const candidates=ranked.slice(0,MAX_PORTRAIT_DIAGNOSTIC_CANDIDATES).map((candidate,index):PortraitDiagnosticCandidate=>{
  const q=candidate.queryIndex===undefined||candidate.queryIndex<0?undefined:queries[candidate.queryIndex];
  const dx=q?.dx,dy=q?.dy;
  const box=(x:number,y:number,width:number,height:number)=>Object.freeze({x:x+dx!,y:y+dy!,width,height});
  const registered=dx!==undefined&&dy!==undefined;
  return Object.freeze({id:candidate.card.id.slice(0,MAX_PORTRAIT_DIAGNOSTIC_ID_CHARS),idTruncated:candidate.card.id.length>MAX_PORTRAIT_DIAGNOSTIC_ID_CHARS,
   upper:candidate.upper,lower:candidate.lower,left:candidate.left??null,right:candidate.right??null,correlation:candidate.correlation,
   margin:candidate.correlation-ranked[index===0?1:0].correlation,evaluatedForAcceptance:index===0,
   registration:registered?Object.freeze({dx,dy,interpolation:Number.isInteger(dx)&&Number.isInteger(dy)?'integer' as const:'bilinear' as const}):null,
   roi:registered?Object.freeze({upper:box(2,9,20,5),lower:box(2,14,20,masked?2:5),left:masked?box(2,9,10,5):null,right:masked?box(12,9,10,5):null}):null});
 });
 const first=candidates[0],p:PortraitEvidence={upper:first.upper,lower:first.lower,correlation:first.correlation,margin:first.margin,
  ...(masked?{region:'above-badge' as const,left:first.left??undefined,right:first.right??undefined}:{})};
 const identityMatches=!text||text.id===ranked[0].card.id;
 const picturePassed=identityMatches?confirmPortrait(p):null;
 const textEvaluated=identityMatches&&picturePassed===false&&!!text;
 stages.push(Object.freeze({stage,queryCount:queries.length,candidates:Object.freeze(candidates),decision:Object.freeze({textIdMatches:text?identityMatches:null,
  independent:Object.freeze({evaluated:identityMatches,passed:picturePassed,checks:identityMatches?numericChecks(p):null}),
  text:Object.freeze({evaluated:textEvaluated,passed:textEvaluated?confirmPortraitWithText(p,text!):null,checks:textEvaluated?textChecks(p,text!):null}),accepted})}));
}
function publishDiagnostic(observer:PortraitDiagnosticObserver|undefined,stages:PortraitStageDiagnostic[]|undefined,
 outcome:PortraitMatchDiagnostic['outcome'],reason:PortraitMatchDiagnostic['reason'],fractionalRegistration:boolean,referenceIdentities:number,
 text:(PortraitTextEvidence&{id:string})|undefined) {
 if(!observer||!stages)return;
 const finite=(value:number)=>Number.isFinite(value)?value:null;
 const diagnostic:PortraitMatchDiagnostic=Object.freeze({version:1,coordinateSpace:'gray-grid-24x32',outcome,reason,fractionalRegistration,referenceIdentities,
  text:text?Object.freeze({id:text.id.slice(0,MAX_PORTRAIT_DIAGNOSTIC_ID_CHARS),idTruncated:text.id.length>MAX_PORTRAIT_DIAGNOSTIC_ID_CHARS,
   ocrConfidence:finite(text.ocrConfidence),score:finite(text.score),gap:finite(text.gap),complete:text.complete??null,
   visibleNameLength:normalizeName(text.rawText??'').length,canonicalNameLength:normalizeName(text.canonicalName??'').length}):null,
  stages:Object.freeze(stages)});
 try{observer(diagnostic);}catch{/* Optional diagnostics cannot change recognition. */}
}
export function confirmPortrait(p: PortraitEvidence) {
 if(p.region==='above-badge')return p.upper>=.91&&p.lower>=.91&&p.correlation>=.94&&p.margin>=.2&&
  (p.left??0)>=.9&&(p.right??0)>=.9;
 return p.upper >= .91 && p.lower >= .91 && p.correlation >= .94 && p.margin >= .2;
}
/** A weaker picture is usable only with a separate, clear full-name winner.
 * Two picture regions and a larger visual margin are still mandatory. */
export function confirmPortraitWithText(p: PortraitEvidence, text: PortraitTextEvidence) {
 if(p.region==='above-badge') {
  const visible=normalizeName(text.rawText??''),canonical=normalizeName(text.canonicalName??'');
  return text.complete===true&&visible.length>=2&&visible.length===canonical.length&&
   !/[ㄱ-ㅎㅏ-ㅣ]/.test(visible)&&text.ocrConfidence>=50&&text.score>=.83&&text.gap>=.4&&
   p.upper>=.85&&p.lower>=.85&&p.correlation>=.86&&p.margin>=.35&&(p.left??0)>=.84&&(p.right??0)>=.84;
 }
 return normalizeName(text.rawText ?? '').length >= 3 && text.ocrConfidence >= 65 &&
  text.score >= .83 && text.gap + 1e-9 >= .2 && p.upper >= .91 && p.lower >= .91 &&
  p.correlation >= .93 && p.margin >= .3;
}
function unit(values: ArrayLike<number>) {
 let sum=0;for(let i=0;i<values.length;i++)sum+=values[i];const mean=sum/values.length;
 const centered=Float32Array.from(values,v=>v-mean);const square=centered.reduce((s,v)=>s+v*v,0);
 return square>1e-6?centered.map(v=>v/Math.sqrt(square)):null;
}
// Avoid a callback allocation for every pixel of every catalog comparison.
// Accumulation order and precision remain identical to the original reduce.
function dot(a: Float32Array, b: Float32Array) {
 let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]*b[i];return sum;
}
const fractionalShifts=[-1,-.75,-.5,-.25,0,.25,.5,.75,1].flatMap(dy=>
 [-1,-.75,-.5,-.25,0,.25,.5,.75,1].flatMap(dx=>Number.isInteger(dx)&&Number.isInteger(dy)?[]:[{dx,dy}]));
function sampleGray(gray:ArrayLike<number>,x:number,y:number) {
 const left=Math.floor(x),top=Math.floor(y),fx=x-left,fy=y-top;
 if(!fx&&!fy)return gray[top*24+left];
 return gray[top*24+left]*(1-fx)*(1-fy)+gray[top*24+left+1]*fx*(1-fy)+
  gray[(top+1)*24+left]*(1-fx)*fy+gray[(top+1)*24+left+1]*fx*fy;
}
/** Only controls whether to spend more registration work. It cannot confirm a
 * card or replace the independent region/margin/text acceptance gates. */
const nearPortrait=(p:PortraitEvidence)=>p.upper>=.85&&p.lower>=.85&&p.correlation>=.90;
export interface PortraitMatcherOptions {fractionalRegistration?:boolean}
/** Independent upper/lower portrait regions. Excludes name, count and jewels.
 * Every catalog artwork receives the same bounded registration search. */
export function createPortraitMatcher(cards: Reference[], atlas: Record<string,string>, supplement: Record<string,string> = {},options:PortraitMatcherOptions={}) {
 const fractionalRegistration=options.fractionalRegistration===true;
 const refs=cards.flatMap(card=>[...new Set([atlas[card.id],supplement[card.id]].filter(Boolean))].flatMap(encoded=>{const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));if(bytes.length!==200)return [];
  const upper=unit(bytes.subarray(0,100)),lower=unit(bytes.subarray(100)),middle=unit(bytes.subarray(100,140));
  const left=unit(Array.from({length:50},(_,i)=>bytes[Math.floor(i/10)*20+i%10]));
  const right=unit(Array.from({length:50},(_,i)=>bytes[Math.floor(i/10)*20+i%10+10]));
  return upper&&lower&&middle&&left&&right?[{card,upper,lower,middle,left,right}]:[];}));
 const referenceIds=new Set(refs.map(ref=>ref.card.id)),identities=referenceIds.size;
 return(gray:ArrayLike<number>, text?: PortraitTextEvidence & { id: string },onDiagnostic?:PortraitDiagnosticObserver)=>{
  const stages:PortraitStageDiagnostic[]|undefined=onDiagnostic?[]:undefined;
  if(gray.length!==768||identities<2){
   publishDiagnostic(onDiagnostic,stages,'unavailable',gray.length!==768?'invalid-gray-size':'insufficient-identities',fractionalRegistration,identities,text);
   return null;
  }
  // A text-bound match may only return this identity. Display artwork does not
  // supply recognition evidence, and registration cannot create a missing ref.
  if(text&&!referenceIds.has(text.id)){
   publishDiagnostic(onDiagnostic,stages,'unavailable','missing-text-reference',fractionalRegistration,identities,text);
   return null;
  }
  const queries=[-1,0,1].flatMap(dy=>[-1,0,1].flatMap(dx=>{const part=(row:number)=>unit(Float32Array.from({length:100},(_,i)=>gray[(row+Math.floor(i/20)+dy)*24+2+i%20+dx]));const upper=part(9),lower=part(14);return upper&&lower?[onDiagnostic?{upper,lower,dx,dy}:{upper,lower}]:[];}));
  const ranked=rankCards(refs.map(ref=>{
   let best={upper:0,lower:0,correlation:-1},queryIndex=-1;
   for(let index=0;index<queries.length;index++){const q=queries[index],upper=dot(ref.upper,q.upper),lower=dot(ref.lower,q.lower),correlation=(upper+lower)/2;
    if(correlation>best.correlation){best={upper,lower,correlation};queryIndex=index;}}
   return onDiagnostic?{card:ref.card,...best,queryIndex}:{card:ref.card,...best};
  }));
  const best=ranked[0],portrait={upper:best.upper,lower:best.lower,correlation:best.correlation,margin:best.correlation-ranked[1].correlation};
  const accepted=(!text||text.id===best.card.id) && (confirmPortrait(portrait) ||
      (text?.id===best.card.id&&confirmPortraitWithText(portrait,text)));
  if(stages)recordDiagnosticStage(stages,'normal',ranked,queries,text,accepted);
  if(accepted){publishDiagnostic(onDiagnostic,stages,'accepted','accepted',fractionalRegistration,identities,text);return {card:best.card,portrait};}
  // The equipped banner starts below these fixed, disjoint artwork regions.
  // Rank the complete catalog again; never remove pixels based on the winner.
  const maskedQueries=[-1,0,1].flatMap(dy=>[-1,0,1].flatMap(dx=>{
   const raw=Float32Array.from({length:100},(_,i)=>gray[(9+Math.floor(i/20)+dy)*24+2+i%20+dx]);
   const upper=unit(raw),middle=unit(Float32Array.from({length:40},(_,i)=>gray[(14+Math.floor(i/20)+dy)*24+2+i%20+dx]));
   const left=unit(Float32Array.from({length:50},(_,i)=>raw[Math.floor(i/10)*20+i%10]));
   const right=unit(Float32Array.from({length:50},(_,i)=>raw[Math.floor(i/10)*20+i%10+10]));
   return upper&&middle&&left&&right?[onDiagnostic?{upper,middle,left,right,dx,dy}:{upper,middle,left,right}]:[];
  }));
  const masked=rankCards(refs.map(ref=>{let result={upper:0,lower:0,left:0,right:0,correlation:-1},queryIndex=-1;
   for(let index=0;index<maskedQueries.length;index++){const q=maskedQueries[index],upper=dot(ref.upper,q.upper),lower=dot(ref.middle,q.middle),correlation=(upper+lower)/2;
    if(correlation>result.correlation){result={upper,lower,correlation,left:dot(ref.left,q.left),right:dot(ref.right,q.right)};queryIndex=index;}}
   return onDiagnostic?{card:ref.card,...result,queryIndex}:{card:ref.card,...result};}));
  const candidate=masked[0],evidence:PortraitEvidence={region:'above-badge',upper:candidate.upper,lower:candidate.lower,
   left:candidate.left,right:candidate.right,correlation:candidate.correlation,margin:candidate.correlation-masked[1].correlation};
  const maskedAccepted=(!text||text.id===candidate.card.id)&&(confirmPortrait(evidence)||
   (text?.id===candidate.card.id&&confirmPortraitWithText(evidence,text)));
  if(stages)recordDiagnosticStage(stages,'above-badge',masked,maskedQueries,text,maskedAccepted);
  if(maskedAccepted){publishDiagnostic(onDiagnostic,stages,'accepted','accepted',fractionalRegistration,identities,text);return{card:candidate.card,portrait:evidence};}
  if(!fractionalRegistration||!nearPortrait(portrait)&&!nearPortrait(evidence)){
   publishDiagnostic(onDiagnostic,stages,'rejected',!fractionalRegistration?'fractional-disabled':'not-near',fractionalRegistration,identities,text);
   return null;
  }
  // Optional near-failure experiment: retain the 9 integer positions first,
  // then add 72 quarter-cell positions for every reference/identity. The same
  // fixed regions and all original acceptance gates remain in use. Integer
  // positions win exact-score ties, and no candidate-specific mask is made.
  // Bilinear samples may share one source bin across a region boundary; these
  // refined measurements are not an extra independent observation.
  const refinedQueries=[...queries,...fractionalShifts.flatMap(({dx,dy})=>{
   const part=(row:number)=>unit(Float32Array.from({length:100},(_,i)=>sampleGray(gray,2+i%20+dx,row+Math.floor(i/20)+dy)));
   const upper=part(9),lower=part(14);return upper&&lower?[onDiagnostic?{upper,lower,dx,dy}:{upper,lower}]:[];
  })];
  const refined=rankCards(refs.map(ref=>{
   let best={upper:0,lower:0,correlation:-1},queryIndex=-1;
   for(let index=0;index<refinedQueries.length;index++){const q=refinedQueries[index],upper=dot(ref.upper,q.upper),lower=dot(ref.lower,q.lower),correlation=(upper+lower)/2;
    if(correlation>best.correlation){best={upper,lower,correlation};queryIndex=index;}}
   return onDiagnostic?{card:ref.card,...best,queryIndex}:{card:ref.card,...best};
  }));
  const refinedBest=refined[0],refinedPortrait:PortraitEvidence={upper:refinedBest.upper,lower:refinedBest.lower,
   correlation:refinedBest.correlation,margin:refinedBest.correlation-refined[1].correlation};
  const refinedAccepted=(!text||text.id===refinedBest.card.id)&&(confirmPortrait(refinedPortrait)||
   (text?.id===refinedBest.card.id&&confirmPortraitWithText(refinedPortrait,text)));
  if(stages)recordDiagnosticStage(stages,'refined-normal',refined,refinedQueries,text,refinedAccepted);
  if(refinedAccepted){publishDiagnostic(onDiagnostic,stages,'accepted','accepted',fractionalRegistration,identities,text);return{card:refinedBest.card,portrait:{...refinedPortrait,registration:'quarter-cell-v1' as const}};}
  const refinedMaskedQueries=[...maskedQueries,...fractionalShifts.flatMap(({dx,dy})=>{
   const raw=Float32Array.from({length:100},(_,i)=>sampleGray(gray,2+i%20+dx,9+Math.floor(i/20)+dy));
   const upper=unit(raw),middle=unit(Float32Array.from({length:40},(_,i)=>sampleGray(gray,2+i%20+dx,14+Math.floor(i/20)+dy)));
   const left=unit(Float32Array.from({length:50},(_,i)=>raw[Math.floor(i/10)*20+i%10]));
   const right=unit(Float32Array.from({length:50},(_,i)=>raw[Math.floor(i/10)*20+i%10+10]));
   return upper&&middle&&left&&right?[onDiagnostic?{upper,middle,left,right,dx,dy}:{upper,middle,left,right}]:[];
  })];
  const refinedMasked=rankCards(refs.map(ref=>{
   let best={upper:0,lower:0,left:0,right:0,correlation:-1},queryIndex=-1;
   for(let index=0;index<refinedMaskedQueries.length;index++){const q=refinedMaskedQueries[index],upper=dot(ref.upper,q.upper),lower=dot(ref.middle,q.middle),correlation=(upper+lower)/2;
    if(correlation>best.correlation){best={upper,lower,correlation,left:dot(ref.left,q.left),right:dot(ref.right,q.right)};queryIndex=index;}}
   return onDiagnostic?{card:ref.card,...best,queryIndex}:{card:ref.card,...best};
  }));
  const refinedCandidate=refinedMasked[0],refinedEvidence:PortraitEvidence={region:'above-badge',upper:refinedCandidate.upper,lower:refinedCandidate.lower,
   left:refinedCandidate.left,right:refinedCandidate.right,correlation:refinedCandidate.correlation,margin:refinedCandidate.correlation-refinedMasked[1].correlation};
  const refinedMaskedAccepted=(!text||text.id===refinedCandidate.card.id)&&(confirmPortrait(refinedEvidence)||
   (text?.id===refinedCandidate.card.id&&confirmPortraitWithText(refinedEvidence,text)));
  if(stages)recordDiagnosticStage(stages,'refined-above-badge',refinedMasked,refinedMaskedQueries,text,refinedMaskedAccepted);
  publishDiagnostic(onDiagnostic,stages,refinedMaskedAccepted?'accepted':'rejected',refinedMaskedAccepted?'accepted':'all-stages-rejected',fractionalRegistration,identities,text);
  return refinedMaskedAccepted?{card:refinedCandidate.card,portrait:{...refinedEvidence,registration:'quarter-cell-v1' as const}}:null;
 };
}
