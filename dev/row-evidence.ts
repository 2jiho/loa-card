import {InventoryEvidence,CURRENT_INVENTORY_CONSENSUS_POLICY} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import {confirmedReadingCount} from '../src/features/card-scanner/session/recovery-completion';
import {timedCaptureOrder} from '../src/features/card-scanner/session/live-scan-policy';
import {observedCard,readFieldReliability,settleReadFields} from '../src/features/card-scanner/session/field-acceptance';
import type {ReadFieldValues} from '../src/features/card-scanner/session/field-acceptance';
import type {CatalogName} from '../src/features/card-scanner/recognition/card-dictionary';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer-types';

/** Development prototype (docs/scanner-live-redesign.md 13.9, step 4). Not a scanner.
 *
 * The scanner's own acceptance and merge for the row-centred reading: every crop the row
 * reading names goes through the shared field acceptance (session/field-acceptance.ts) and
 * into an InventoryEvidence set up as the scanner sets up its own (empty seed, same consensus
 * and count-conflict policies). "Confirmed" is the scanner's `confirmedReadingCount` over the
 * projected cards, so the number can be compared with the scanner's "read" count.
 *
 * What it leaves out of the scanner: the header total, sort, positions, unknown-observation
 * lifecycle, freshness proofs, recovery and completion. It decides nothing about a finished scan. */
export interface RowEvidenceIdentity {
  readonly id:string;readonly name:string;readonly review:readonly string[];readonly maxAwakening?:number;
  readonly nameEvidence?:ScannedCard['nameEvidence'];
}
export interface RowEvidenceInput {
  readonly identity:RowEvidenceIdentity;
  /** The values read from the crop, or null when none were read. Not changed. */
  readonly values:ReadFieldValues|null;
  readonly time:number;readonly slot:number;
  /** A whole number that identifies the frame the crop came from. */
  readonly frameId:number;
  /** The crop's fields matched the same column of the frame before (the scanner's `stable`). */
  readonly stable:boolean;
  readonly borderAlignment:number;
}
export interface RowEvidence {
  /** Accept one named crop. Returns its values after acceptance (an unconfirmed zero is null). */
  accept(input:RowEvidenceInput):{awakening:number|null;extraCopies:number|null};
  /** Whether this crop's count is unconfirmed as read (whatever the reason). Such a crop is read
   * in full, with the text reader allowed, before it is accepted. Records nothing. */
  countUnconfirmed(input:Pick<RowEvidenceInput,'identity'|'values'|'stable'|'borderAlignment'>):boolean;
  /** Whether the scanner would read this crop's count again with the text reader before accepting
   * it (its `readAndRecordFields`): the count is unconfirmed, the awakening and a count pattern
   * were read, and the identity is not under review. Records nothing. */
  needsCountReread(input:Pick<RowEvidenceInput,'identity'|'values'|'stable'|'borderAlignment'>):boolean;
  /** Whether the card's values are confirmed by this run's observations (may lag by `refreshMs`). */
  confirmed(id:string):boolean;
  /** The projected cards and how many are confirmed, computed now. */
  summary():{confirmed:number;cards:{id:string;name:string;awakening:number|null;extraCopies:number|null;confirmed:boolean;review:readonly string[];observations:number}[]};
}

export function createRowEvidence(catalog:CatalogName[],refreshMs=150):RowEvidence {
  const sessionId=crypto.randomUUID();
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY,countConflictPolicy:{version:3,sessionId}});
  let sequence=0,dirty=false,refreshed=-Infinity,projected:ScannedCard[]=[],confirmedIds=new Set<string>();
  const refresh=(force:boolean)=>{
    if(!dirty||(!force&&performance.now()-refreshed<refreshMs))return;
    projected=inventory.project(catalog);
    const evidence={latest:inventory.latestIdentityOrder,confirmed:inventory.confirmedFieldOrder,agreed:inventory.agreedFieldOrder};
    confirmedIds=new Set(projected.filter(card=>confirmedReadingCount({cards:[card],...evidence})===1).map(card=>card.id));
    dirty=false;refreshed=performance.now();
  };
  return {
    accept(input){
      const {identity,time,slot,stable,borderAlignment}=input;
      // Acceptance settles the values in place; the reader's own object is left alone.
      const values:ReadFieldValues=input.values?structuredClone(input.values):{awakening:null,extraCopies:null};
      const reliability=readFieldReliability(values,{stable,borderAlignment,maxAwakening:identity.maxAwakening});
      const review=settleReadFields(values,identity.review,reliability);
      const order=timedCaptureOrder(0,time,slot),frame=`row:${input.frameId}`;
      const source:InventorySource={sessionId,frameId:input.frameId,observationId:String(++sequence),captureOrder:order,captureTime:time,phase:'input',slot,frame};
      // As in the scanner: the identity is accepted for this source first, then the name and values.
      inventory.acceptIdentity(source,identity.id);
      // As in the scanner: a name still under review is not confirmed by this observation.
      if(!identity.review.includes('이름 확인'))inventory.confirmName(source,identity.id,identity.name);
      const card=observedCard({identity:{...identity,review:[...identity.review],nameEvidence:identity.nameEvidence??[]},values,review,reliability,
        image:'',time,order,stable,position:{frame,slot,stable,sort:null}});
      inventory.recordObservation(source,card as unknown as ScannedCard,borderAlignment);
      dirty=true;
      return {awakening:values.awakening,extraCopies:values.extraCopies};
    },
    countUnconfirmed(input){
      return !input.values||readFieldReliability(input.values,{stable:input.stable,borderAlignment:input.borderAlignment,maxAwakening:input.identity.maxAwakening})==='unconfirmed';
    },
    needsCountReread(input){
      const {values,identity}=input;
      return !!values&&values.awakening!==null&&values.countDiagnostics?.pattern?.value!=null&&!identity.review.length&&
        readFieldReliability(values,{stable:input.stable,borderAlignment:input.borderAlignment,maxAwakening:identity.maxAwakening})==='unconfirmed';
    },
    confirmed(id){refresh(false);return confirmedIds.has(id);},
    summary(){
      refresh(true);
      return {confirmed:confirmedIds.size,cards:projected.map(card=>({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,
        confirmed:confirmedIds.has(card.id),review:card.review,observations:card.observations}))};
    },
  };
}
