import {consensus} from './consensus';
import {confirmSortedNames} from './name-confirmation';
import type {CatalogName} from './card-dictionary';
import type {ScannedCard} from './recognizer';

export interface LiveInventorySnapshot {
  identified:number;
  confirmed:number;
  cards:Pick<ScannedCard,'id'|'name'|'awakening'|'extraCopies'|'review'|'countReliable'>[];
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
  finish(catalog:CatalogName[]):LiveInventorySnapshot {
    if(this.result)return this.result;
    const observations=[...this.observations.values()].flat();
    const cards=confirmSortedNames([...this.observations.values()].map(consensus),observations,catalog)
      .map(({id,name,awakening,extraCopies,review,countReliable})=>({id,name,awakening,extraCopies,review:[...review],countReliable}))
      .sort((a,b)=>a.name.localeCompare(b.name,'ko'));
    this.result={identified:cards.length,confirmed:cards.filter(card=>!card.review.length&&
      card.awakening!==null&&card.extraCopies!==null&&card.countReliable!==false).length,cards};
    this.observations.clear();
    return this.result;
  }
}
