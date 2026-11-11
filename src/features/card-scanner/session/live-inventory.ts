import {consensus} from '../recognition/consensus';
import {confirmSortedNames} from '../recognition/name-confirmation';
import {CURRENT_FIELD_REVIEW,hasCurrentFieldProof} from './current-scan-fields';
import type {CatalogName} from '../recognition/card-dictionary';
import type {ScannedCard} from '../recognition/recognizer-types';

export interface LiveInventorySnapshot {
  identified:number;
  confirmed:number;
  cards:Pick<ScannedCard,'id'|'name'|'awakening'|'extraCopies'|'review'|'countReliable'>[];
}
/** Shared current-run proofs at the instant sharing ends. These maps are read
 * synchronously; neither an old backup nor a later reader may certify this
 * snapshot. An absent proof is unknown, never evidence of completion. */
export interface LiveInventoryProof {
  cards:ReadonlyMap<string,ScannedCard>;
  latest:ReadonlyMap<string,number>;
  confirmedNames:ReadonlyMap<string,number>;
  confirmedFields:ReadonlyMap<string,number>;
  agreedFields?:ReadonlyMap<string,number>;
}
/** Only newly read live observations enter here. No restored inventory or
 * post-share work can turn an incomplete realtime result into a passing one.
 * Consensus runs once after input ends, leaving the capture hot path unchanged.
 */
export class LiveInventory {
  private observations=new Map<string,ScannedCard[]>();
  private result?:LiveInventorySnapshot;
  record(card:ScannedCard) {
    if(this.result)return;
    const group=this.observations.get(card.id)??[];
    group.push(card);this.observations.set(card.id,group);
  }
  finish(catalog:CatalogName[],proof?:LiveInventoryProof):LiveInventorySnapshot {
    if(this.result)return this.result;
    const observations=[...this.observations.values()].flat();
    const cards=confirmSortedNames([...this.observations.values()].map(items=>consensus(items)),observations,catalog)
      .map(card=>{
        const observed=proof?.cards.get(card.id),order=proof?.latest.get(card.id),nameOrder=proof?.confirmedNames.get(card.id);
        const nameConfirmed=!!observed && observed.name===card.name && order!==undefined && nameOrder!==undefined &&
          Number.isFinite(order)&&Number.isFinite(nameOrder)&&nameOrder>=order&&!observed.review.includes('이름 확인');
        const fieldsConfirmed=!!observed && !!proof && hasCurrentFieldProof(card.id,{latest:proof.latest,confirmed:proof.confirmedFields,agreed:proof.agreedFields})&&
          observed.awakening===card.awakening&&observed.extraCopies===card.extraCopies&&observed.countReliable===true&&
          card.countReliable===true&&!observed.review.length;
        const review=[...card.review];
        if(!nameConfirmed&&!review.includes('최신 이름 확인'))review.push('최신 이름 확인');
        if(!fieldsConfirmed&&!review.includes(CURRENT_FIELD_REVIEW))review.push(CURRENT_FIELD_REVIEW);
        return {id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,review,
          countReliable:fieldsConfirmed};
      })
      .sort((a,b)=>a.name.localeCompare(b.name,'ko'));
    this.result={identified:cards.length,confirmed:cards.filter(card=>!card.review.length&&
      card.awakening!==null&&card.extraCopies!==null&&card.countReliable!==false).length,cards};
    this.observations.clear();
    return this.result;
  }
}
