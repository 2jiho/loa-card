import type { CountPatternReading } from "./count-pattern";
import { COUNT_UNEXPLAINED_TRAILING_GLYPH } from "./count-pattern";
import { corroboratedCount } from "./count-corroboration";

export type CountReliability = "stable-frame" | "clear-pattern" | "distinct-pattern" | "repeated-pattern" | "pattern-ocr" | "empty-counter" | "fixed-zero" | "unconfirmed";

type CountInput = {
  borderAlignment: number; awakening: number | null; extraCopies: number | null;
  pattern?: CountPatternReading;
};
/** All 15 values are ranked before applying the awakening limit. Preserve
 * the matcher's minimum contrast and separation; an upper bound is not a vote. */
function validPositive(input: CountInput) {
  const p = input.pattern;
  return input.borderAlignment >= .8 && input.awakening !== null &&
    Number.isInteger(input.awakening) && input.awakening >= 0 && input.awakening <= 5 &&
    input.extraCopies !== null && Number.isInteger(input.extraCopies) && input.extraCopies > 0 &&
    input.extraCopies <= 15 - input.awakening * (input.awakening + 1) / 2 && !!p &&
    p.value === input.extraCopies && p.candidate === input.extraCopies &&
    Number.isFinite(p.score) && Number.isFinite(p.gap) && p.score >= .30 && p.gap >= .018;
}

/** A canonical-frame claim must be backed by the caller's input store. An ID
 * or timestamp by itself never authenticates a physical frame. */
export interface CountObservationSource {
  readonly sessionId:string;readonly observationId:string;readonly captureOrder:number;readonly captureTime:number;readonly slot:number;
  readonly canonicalFrameId:number|null;readonly canonicalStreamId:string|null;
  readonly provenance:'canonical-claim'|'unverified';
}
export interface CountObservationBarrier {readonly sessionId:string;readonly captureOrder:number;readonly captureTime:number}
export type SourceBoundCountResult =
 | {readonly status:'unverified';readonly reason:string;readonly current:CountObservationSource|null;readonly previous:null}
 | {readonly status:'conditional';readonly reason:'distinct-canonical-frame-claims';readonly current:CountObservationSource;readonly previous:CountObservationSource};
type BoundCountEntry={readonly source:CountObservationSource;readonly value:number;readonly awakening:number;readonly pixels:Uint8Array};
const sourceId=(x:unknown):x is string=>typeof x==='string'&&x.length>0&&x.length<=160;
const sourceInt=(x:unknown):x is number=>Number.isSafeInteger(x)&&(x as number)>=0;
function countSource(value:CountObservationSource):CountObservationSource|null {
  if(!value||!sourceId(value.sessionId)||!sourceId(value.observationId)||!sourceInt(value.captureOrder)||
    typeof value.captureTime!=='number'||!Number.isFinite(value.captureTime)||value.captureTime<0||!sourceInt(value.slot)||value.slot>=40||
    !(value.canonicalFrameId===null||sourceInt(value.canonicalFrameId))||
    !(value.canonicalStreamId===null||sourceId(value.canonicalStreamId))||!['canonical-claim','unverified'].includes(value.provenance))return null;
  if(value.provenance==='canonical-claim'&&(value.canonicalFrameId===null||value.canonicalStreamId===null))return null;
  return Object.freeze({sessionId:value.sessionId,observationId:value.observationId,captureOrder:value.captureOrder,captureTime:value.captureTime,
    slot:value.slot,canonicalFrameId:value.canonicalFrameId,canonicalStreamId:value.canonicalStreamId,provenance:value.provenance});
}
function countBarrier(value:CountObservationBarrier):boolean {
  return !!value&&sourceId(value.sessionId)&&sourceInt(value.captureOrder)&&typeof value.captureTime==='number'&&Number.isFinite(value.captureTime)&&value.captureTime>=0;
}
/** DB identity links observations; only the counter pixels need to settle.
 * Duplicate retries of a frame cannot manufacture temporal evidence. */
export class CountObservations {
  private cards = new Map<string, { frame: string; value: number; awakening: number; pixels: Uint8Array }[]>();
  private boundCards = new Map<string,BoundCountEntry[]>();
  private boundSessionId:string|undefined;
  /** Switch only at an explicit scan boundary; stale callbacks cannot switch it. */
  beginSourceBoundSession(sessionId:string):void {
    if(!sourceId(sessionId))throw new TypeError('Invalid count evidence session');
    this.boundCards.clear();this.boundSessionId=sessionId;
  }
  /** Releases the optional pixel history; the original offer() cache is untouched. */
  clearSourceBound():void {this.boundCards.clear();this.boundSessionId=undefined;}
  sourceBoundStats():Readonly<{sessionId:string|null;cards:number;entries:number;pixelBytes:number}> {
    let entries=0,pixelBytes=0;for(const values of this.boundCards.values())for(const value of values){entries++;pixelBytes+=value.pixels.byteLength;}
    return Object.freeze({sessionId:this.boundSessionId??null,cards:this.boundCards.size,entries,pixelBytes});
  }
  offer(id: string, frame: string, vector: Uint8Array, input: CountInput) {
    if (!validPositive(input) || vector.length !== 3240 || !frame) return false;
    const pixels = vector.slice(864, 2016), recent = this.cards.get(id) ?? [];
    const repeated = recent.some(previous => {
      if (previous.frame === frame || previous.value !== input.extraCopies || previous.awakening !== input.awakening) return false;
      let difference = 0;
      for (let i = 0; i < pixels.length; i++) difference += Math.abs(pixels[i] - previous.pixels[i]);
      return difference / pixels.length < 2.5;
    });
    if (!recent.some(previous => previous.frame === frame)) {
      recent.push({ frame, value: input.extraCopies!, awakening: input.awakening!, pixels });
      this.cards.set(id, recent.slice(-6));
    }
    return repeated;
  }
  /** Optional distinct-source analysis. It neither mutates nor changes offer().
   * The caller must separately authenticate canonical-frame claims and identity;
   * a conditional pair is not a verified physical-input receipt. */
  offerSourceBound(id:string,vector:Uint8Array,input:CountInput,source:CountObservationSource,after:CountObservationBarrier):SourceBoundCountResult {
    const current=countSource(source);
    const fail=(reason:string):SourceBoundCountResult=>({status:'unverified',reason,current,previous:null});
    if(!sourceId(id)||!current||!countBarrier(after)||current.sessionId!==after.sessionId||
      !(vector instanceof Uint8Array)||vector.length!==3240||!validPositive(input))return fail('invalid source or reading');
    if(this.boundSessionId===undefined)return fail('scan session not initialized');
    if(this.boundSessionId!==current.sessionId)return fail('different scan session');
    const recent=this.boundCards.get(id)??[];
    const alias=recent.find(entry=>entry.source.observationId===current.observationId);
    if(alias&&JSON.stringify(alias.source)!==JSON.stringify(current))return fail('observation source conflict');
    const newest=recent.at(-1);
    if(newest&&(current.captureOrder<newest.source.captureOrder||current.captureTime<newest.source.captureTime))
      return fail('older than retained evidence');
    const pixels=vector.slice(864,2016);
    const afterBarrier=(s:CountObservationSource)=>s.sessionId===after.sessionId&&s.captureTime>after.captureTime&&s.captureOrder>after.captureOrder;
    let found:BoundCountEntry|undefined;
    if(afterBarrier(current)&&current.provenance==='canonical-claim')found=recent.find(previous=>{
      const old=previous.source;
      if(!afterBarrier(old)||old.provenance!=='canonical-claim'||old.canonicalStreamId!==current.canonicalStreamId||
        old.canonicalFrameId===current.canonicalFrameId||old.observationId===current.observationId||
        old.captureTime>=current.captureTime||old.captureOrder>=current.captureOrder||
        previous.value!==input.extraCopies||previous.awakening!==input.awakening)return false;
      let difference=0;for(let i=0;i<pixels.length;i++)difference+=Math.abs(pixels[i]-previous.pixels[i]);
      return difference/pixels.length<2.5;
    });
    // An exact source tuple/physical-frame claim is retained once, so retries
    // cannot consume the bounded history or create another frame witness.
    if(!recent.some(entry=>entry.source.sessionId===current.sessionId&&
      (entry.source.observationId===current.observationId||current.canonicalFrameId!==null&&
       entry.source.canonicalStreamId===current.canonicalStreamId&&entry.source.canonicalFrameId===current.canonicalFrameId&&entry.source.slot===current.slot))){
      recent.push({source:current,value:input.extraCopies!,awakening:input.awakening!,pixels});
      this.boundCards.delete(id);this.boundCards.set(id,recent.slice(-6));
      while(this.boundCards.size>2048)this.boundCards.delete(this.boundCards.keys().next().value!);
    }
    if(found)return {status:'conditional',reason:'distinct-canonical-frame-claims',current,previous:found.source};
    return fail(current.provenance==='unverified'?'physical source unverified':'no matching later independent source');
  }
}

/** Temporal stability and clear field evidence are independent routes. A page
 * change need not repeat if the complete card and its count glyphs are intact. */
export function countReliability(input: {
  stable: boolean;
  repeatedCount?: boolean;
  borderAlignment: number;
  awakening: number | null;
  maxAwakening?: number;
  extraCopies: number | null;
  pattern?: CountPatternReading;
  iconPresent?: boolean;
  patternOcrAgreed?: boolean;
  ocrConfirmedValue?: number;
}): CountReliability {
  if (input.extraCopies === null) return "unconfirmed";
  if (input.pattern?.reason === COUNT_UNEXPLAINED_TRAILING_GLYPH) {
    // A trailing stroke is normally a second-digit veto. Two independent OCR
    // readings plus a strong single-digit candidate can show the stroke belongs
    // to the artwork, while a low-gap/weak candidate stays unconfirmed.
    const strongCandidate = input.pattern.candidate === input.extraCopies &&
      Number.isFinite(input.pattern.score) && input.pattern.score >= .45 &&
      Number.isFinite(input.pattern.gap) && input.pattern.gap >= .10;
    if (!strongCandidate || input.patternOcrAgreed !== true ||
      input.ocrConfirmedValue !== input.extraCopies) return "unconfirmed";
  }
  if (input.extraCopies === 0 && (input.awakening === 5 || input.maxAwakening === 0))
    return "fixed-zero";
  if (input.stable) return "stable-frame";
  if (corroboratedCount({ pattern: input.pattern, awakening: input.awakening,
      value: input.extraCopies, iconPresent: input.iconPresent, ocrAgreed: input.patternOcrAgreed,
      ocrConfirmedValue: input.borderAlignment >= .8 ? input.ocrConfirmedValue : undefined })) return "pattern-ocr";
  // The game omits the extra-copy overlay for zero copies; there is no '0'
  // glyph to OCR. Absence must be explicitly inspected on an intact card.
  if (input.extraCopies === 0 && input.iconPresent === false &&
      input.borderAlignment >= .8 && input.awakening !== null &&
      Number.isInteger(input.awakening) && input.awakening >= 0 && input.awakening <= 5)
    return "empty-counter";
  const pattern = input.pattern;
  if (validPositive(input) && pattern) {
    if (pattern.score >= .4 && pattern.gap >= .035) return "clear-pattern";
    // Contrast is not a recognition probability. Moderate contrast can still
    // distinguish one of the 15 patterns if both absolute and relative gaps hold.
    if (pattern.gap >= .035 && pattern.gap / pattern.score >= .10) return "distinct-pattern";
    if (input.repeatedCount) return "repeated-pattern";
  }
  return "unconfirmed";
}

/** Live acquisition IDs identify processing attempts, not necessarily distinct
 * source frames. Field similarity across attempts does not establish that the
 * two inputs are independent or that a consistently obscured counter is valid.
 * Until a verified pair exists, do not use temporal stability or the legacy
 * repetition heuristic to certify count values. Single-image evidence remains
 * available, and stable is still used by scheduling and UI elsewhere. */
export function currentCountReliability(input: Omit<Parameters<typeof countReliability>[0], 'repeatedCount'>): CountReliability {
  return countReliability({ ...input, stable: false, repeatedCount: false });
}
