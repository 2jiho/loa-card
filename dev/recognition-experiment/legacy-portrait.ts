import type { Reference } from '../../src/features/card-scanner/recognizer';
import { normalizeName } from '../../src/features/card-scanner/card-dictionary';
export interface PortraitEvidence { upper: number; lower: number; correlation: number; margin: number;
 region?: 'above-badge'; left?: number; right?: number }
export interface PortraitTextEvidence { rawText?: string; ocrConfidence: number; score: number; gap: number;
 complete?: boolean; canonicalName?: string }
export function confirmPortrait(p: PortraitEvidence) {
 if(p.region==='above-badge'&&p.upper>=.98&&p.lower>=.88&&p.correlation>=.935&&p.margin>=.3&&(p.left??0)>=.97&&(p.right??0)>=.97)return true;
 if(p.region==='above-badge')return p.upper>=.91&&p.lower>=.91&&p.correlation>=.935&&p.margin>=.2&&
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
/** Rank distinct identities, never competing views of the same card. */
function rankCards<T extends {card:Reference;correlation:number}>(values:T[]) {
 const best=new Map<string,T>();
 for(const value of values)if(!best.has(value.card.id)||value.correlation>best.get(value.card.id)!.correlation)best.set(value.card.id,value);
 return [...best.values()].sort((a,b)=>b.correlation-a.correlation);
}
/** Independent upper/lower portrait regions. Excludes name, count and jewels.
 * Every catalog artwork receives the same bounded registration search. */
export function createPortraitMatcher(cards: Reference[], atlas: Record<string,string>, supplement: Record<string,string> = {}) {
 const refs=cards.flatMap(card=>[...new Set([atlas[card.id],supplement[card.id]].filter(Boolean))].flatMap(encoded=>{const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));if(bytes.length!==200)return [];
  const upper=unit(bytes.subarray(0,100)),lower=unit(bytes.subarray(100)),middle=unit(bytes.subarray(100,140));
  const left=unit(Array.from({length:50},(_,i)=>bytes[Math.floor(i/10)*20+i%10]));
  const right=unit(Array.from({length:50},(_,i)=>bytes[Math.floor(i/10)*20+i%10+10]));
  return upper&&lower&&middle&&left&&right?[{card,upper,lower,middle,left,right}]:[];}));
 const identities=new Set(refs.map(ref=>ref.card.id)).size;
 return(gray:ArrayLike<number>, text?: PortraitTextEvidence & { id: string })=>{
  if(gray.length!==768||identities<2)return null;
  const queries=[-1,0,1].flatMap(dy=>[-1,0,1].flatMap(dx=>{const part=(row:number)=>unit(Float32Array.from({length:100},(_,i)=>gray[(row+Math.floor(i/20)+dy)*24+2+i%20+dx]));const upper=part(9),lower=part(14);return upper&&lower?[{upper,lower}]:[];}));
  const ranked=rankCards(refs.map(ref=>{
   let best={upper:0,lower:0,correlation:-1};
   for(const q of queries){const upper=dot(ref.upper,q.upper),lower=dot(ref.lower,q.lower),correlation=(upper+lower)/2;
    if(correlation>best.correlation)best={upper,lower,correlation};}
   return{card:ref.card,...best};
  }));
  const best=ranked[0],portrait={upper:best.upper,lower:best.lower,correlation:best.correlation,margin:best.correlation-ranked[1].correlation};
  if ((!text||text.id===best.card.id) && (confirmPortrait(portrait) ||
      (text?.id===best.card.id&&confirmPortraitWithText(portrait,text)))) return {card:best.card,portrait};
  // The equipped banner starts below these fixed, disjoint artwork regions.
  // Rank the complete catalog again; never remove pixels based on the winner.
  const maskedQueries=[-1,0,1].flatMap(dy=>[-1,0,1].flatMap(dx=>{
   const raw=Float32Array.from({length:100},(_,i)=>gray[(9+Math.floor(i/20)+dy)*24+2+i%20+dx]);
   const upper=unit(raw),middle=unit(Float32Array.from({length:40},(_,i)=>gray[(14+Math.floor(i/20)+dy)*24+2+i%20+dx]));
   const left=unit(Float32Array.from({length:50},(_,i)=>raw[Math.floor(i/10)*20+i%10]));
   const right=unit(Float32Array.from({length:50},(_,i)=>raw[Math.floor(i/10)*20+i%10+10]));
   return upper&&middle&&left&&right?[{upper,middle,left,right}]:[];
  }));
  const masked=rankCards(refs.map(ref=>{let result={upper:0,lower:0,left:0,right:0,correlation:-1};
   for(const q of maskedQueries){const upper=dot(ref.upper,q.upper),lower=dot(ref.middle,q.middle),correlation=(upper+lower)/2;
    if(correlation>result.correlation)result={upper,lower,correlation,left:dot(ref.left,q.left),right:dot(ref.right,q.right)};}
   return{card:ref.card,...result};}));
  const candidate=masked[0],evidence:PortraitEvidence={region:'above-badge',upper:candidate.upper,lower:candidate.lower,
   left:candidate.left,right:candidate.right,correlation:candidate.correlation,margin:candidate.correlation-masked[1].correlation};
  if(text&&text.id!==candidate.card.id)return null;
  return confirmPortrait(evidence)||(text?.id===candidate.card.id&&confirmPortraitWithText(evidence,text))
   ?{card:candidate.card,portrait:evidence}:null;
 };
}
