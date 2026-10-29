import data from './merchants.json';
import type {ScannedCard} from '../card-scanner/recognizer';

export const merchants=data.groups;
export type MerchantStatus='needed'|'complete'|'unknown';
export const merchantStatusLabel:Record<MerchantStatus,string>={needed:'수집 필요',complete:'수집 완료',unknown:'확인 필요'};

function inventoryIndex(cards:readonly ScannedCard[]) {
  const inventory=new Map<string,ScannedCard>(),duplicates=new Set<string>();
  for(const card of cards){if(inventory.has(card.id))duplicates.add(card.id);inventory.set(card.id,card);}
  return {inventory,duplicates};
}

/** Absence from a scan is unknown, never proof that a card is unowned. */
export function remainingMerchantCopies(card:ScannedCard|undefined,complete=false):number|null {
  if(!card)return complete?16:null;
  if(card.review.length || card.countReliable!==true)return null;
  const {awakening,extraCopies}=card;
  if(awakening===null||extraCopies===null||!Number.isInteger(awakening)||awakening<0||awakening>5||
    !Number.isInteger(extraCopies)||extraCopies<0||extraCopies>15-awakening*(awakening+1)/2)return null;
  return 15-awakening*(awakening+1)/2-extraCopies;
}
/** References for the card-list review UI, never owned-card observations. */
export function merchantCardIssues(cards:readonly ScannedCard[],complete=false) {
  if(!cards.length)return [];
  const {inventory,duplicates}=inventoryIndex(cards);
  return [...new Map(merchants.flatMap(group=>group.cards).map(card=>[card.id,card])).values()]
    .filter(card=>duplicates.has(card.id)||remainingMerchantCopies(inventory.get(card.id),complete)===null)
    .map(card=>({...card,missing:!inventory.has(card.id)}));
}
export function merchantProgress(cards:readonly ScannedCard[],inventoryComplete=false) {
  const {inventory,duplicates}=inventoryIndex(cards);
  return merchants.map(merchant=>{
    const items=merchant.cards.map(card=>({...card,remaining:duplicates.has(card.id)?null:remainingMerchantCopies(inventory.get(card.id),inventoryComplete)}));
    const needed=items.filter(card=>card.remaining!==null&&card.remaining>0);
    const unknown=items.filter(card=>card.remaining===null);
    const complete=items.length-needed.length-unknown.length;
    const status:MerchantStatus=needed.length ? 'needed' : unknown.length ? 'unknown' : 'complete';
    return {...merchant,items,needed,unknown,complete,status,remaining:needed.reduce((sum,card)=>sum+card.remaining!,0)};
  });
}
export function merchantListText(groups:ReturnType<typeof merchantProgress>,status:MerchantStatus) {
  const selected=groups.filter(group=>group.status===status||(status==='needed'&&group.status==='unknown'));
  return [`떠돌이 상인 ${merchantStatusLabel[status]} · 5각에 필요한 카드 수 기준`,...selected.map(group=>
    `${group.region} (${group.merchant})${status==='complete'?'':`: ${[...group.needed.map(card=>`${card.name} ${card.remaining}장 부족`),...group.unknown.map(card=>`${card.name} 확인 필요`)].join(', ')}`}`)].join('\n');
}
