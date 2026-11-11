import type {ObservationSource} from './observation-execution';
import type {CaptureQuality,PreBorderEvidence} from '../acquisition/capture-quality';
import {timedCaptureOrder} from './live-scan-policy';

/** Positive visual evidence only. An unknown, clipped, empty or merely
 * incomplete-border slot is not proof of a visible obstructed card. */
export function unidentifiedObstruction(input:{complete:boolean;intact:boolean;quality:CaptureQuality;preBorder?:PreBorderEvidence}):boolean {
  if(!input.complete||input.quality.usable||!input.preBorder)return false;
  return input.preBorder.kind==='tooltip'||input.preBorder.kind==='name-hidden'&&input.intact;
}

/** A rejected unknown cannot be assigned to a card using a scroll position or
 * a fuzzy visual group. Require fresh independently accepted name and field
 * proof for all current-run identities after the latest obstructed frame.
 * The timed order uses slot 39 as a frame boundary so another slot from the
 * same timestamp cannot discharge it. This reducer never confirms a card. */
export class UnidentifiedObstructionFence {
  #order:number|undefined;
  #invalid=false;
  snapshot():Readonly<{order:number|null;invalid:boolean}>{return Object.freeze({order:this.#order??null,invalid:this.#invalid});}
  notice(captureTime:number,seedOrder:number):void {
    if(!Number.isFinite(captureTime)||captureTime<0||!Number.isSafeInteger(seedOrder)||seedOrder<0){this.#invalid=true;return;}
    const boundary=timedCaptureOrder(seedOrder,captureTime,39);
    if(!Number.isSafeInteger(boundary)){this.#invalid=true;return;}
    this.#order=Math.max(this.#order??-Infinity,boundary);
  }
  needsProof(id:string,names:ReadonlyMap<string,number>,fields:ReadonlyMap<string,number>):boolean {
    if(this.#invalid)return true;
    if(this.#order===undefined)return false;
    const name=names.get(id),field=fields.get(id);
    return name===undefined||!Number.isFinite(name)||name<=this.#order||
      field===undefined||!Number.isFinite(field)||field<=this.#order;
  }
  pending(expected:number|null,ids:readonly string[],names:ReadonlyMap<string,number>,fields:ReadonlyMap<string,number>):number {
    if(this.#invalid)return 1;
    if(this.#order===undefined)return 0;
    if(expected===null||!Number.isSafeInteger(expected)||expected<=0||ids.length>expected||new Set(ids).size!==ids.length)return 1;
    let missing=expected-ids.length;
    for(const id of ids)if(this.needsProof(id,names,fields))missing++;
    return missing;
  }
}

/** Experimental, intentionally conservative. A rejected crop with no
 * independent identity cannot be resolved by row, column, scroll position or
 * card-count equality. Callers must provide real source-bound confirmed name
 * and field evidence from the current run, not inferred/persisted values. */
export interface CompletionObstruction {readonly sessionId:string;readonly frameId:number;readonly captureTime:number}
export interface ReobservedCard {
  readonly id:string;
  readonly name:ObservationSource;
  readonly fields:ObservationSource;
}
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=160;
const boundaryValid=(value:CompletionObstruction)=>!!value&&identifier(value.sessionId)&&Number.isSafeInteger(value.frameId)&&
  value.frameId>0&&Number.isFinite(value.captureTime)&&value.captureTime>=0;
const sourceValid=(source:ObservationSource,after:CompletionObstruction)=>!!source&&source.phase==='input'&&
  source.sessionId===after.sessionId&&Number.isSafeInteger(source.frameId)&&source.frameId>after.frameId&&
  Number.isFinite(source.captureTime)&&source.captureTime>after.captureTime&&identifier(source.observationId)&&
  Number.isSafeInteger(source.slot)&&source.slot>=0&&source.slot<40&&Number.isSafeInteger(source.captureOrder)&&source.captureOrder>=0;
// A separate processing/observation id for the same physical frame and slot
// cannot turn one crop into two independent cards.
const sourceKey=(source:ObservationSource)=>JSON.stringify([source.sessionId,source.frameId,source.slot]);

export class CompletionObstructionDebt {
  #latest:CompletionObstruction|undefined;
  notice(input:CompletionObstruction):void {
    if(!boundaryValid(input))throw new TypeError('Invalid obstruction provenance');
    const old=this.#latest;
    if(old&&(input.sessionId!==old.sessionId||input.captureTime<old.captureTime||input.frameId<old.frameId))
      throw new TypeError('Obstruction chronology mismatch');
    this.#latest=Object.freeze({...input});
  }
  /** No incident needs no additional sweep. When an incident exists, every
   * current-run identity must have both its confirmed name and confirmed fields
   * captured after it; the sources are checked without ever using position as
   * an identity. Source validation does not authenticate the caller/reducer. */
  settled(expectedIds:readonly string[],proofs:readonly ReobservedCard[]):boolean {
    const after=this.#latest;if(!after)return true;
    if(!Array.isArray(expectedIds)||!Array.isArray(proofs)||!expectedIds.length||proofs.length!==expectedIds.length||
      expectedIds.some(id=>!identifier(id))||new Set(expectedIds).size!==expectedIds.length)return false;
    const expected=new Set(expectedIds),seen=new Set<string>(),owner=new Map<string,string>();
    for(const proof of proofs){
      if(!proof||!identifier(proof.id)||!expected.has(proof.id)||seen.has(proof.id)||
        !sourceValid(proof.name,after)||!sourceValid(proof.fields,after))return false;
      seen.add(proof.id);
      for(const source of [proof.name,proof.fields]){
        const key=sourceKey(source),existing=owner.get(key);
        if(existing&&existing!==proof.id)return false;
        owner.set(key,proof.id);
      }
    }
    return seen.size===expected.size;
  }
}
