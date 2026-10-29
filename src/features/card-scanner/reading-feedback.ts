import type {ScannedCard} from './recognizer';
import type {CurrentFieldEvidence} from './current-scan-fields';
import {projectCurrentScanFields} from './current-scan-fields';
import {confirmedReadingCount} from './recovery-completion';
import type {GridStatus} from './scan-grid';
import {createCoalescedPublisher} from './coalesced-publisher';

/** Display-only projection between full inventory publications. A sorted-name
 * validation may be reused only while its underlying consensus is unchanged.
 * Field proof is always checked again, including a newly failed observation. */
export class ReadingFeedback {
  private published=new Map<string,{source:ScannedCard;value:ScannedCard}>();
  remember(source:ReadonlyMap<string,ScannedCard>,published:readonly ScannedCard[]) {
    this.published.clear();
    for(const value of published) {
      const original=source.get(value.id);
      if(original)this.published.set(value.id,{source:original,value});
    }
  }
  snapshot(source:ReadonlyMap<string,ScannedCard>,evidence:CurrentFieldEvidence) {
    const cards=projectCurrentScanFields([...source.values()].map(card=>{
      const previous=this.published.get(card.id);
      return previous?.source===card?previous.value:card;
    }),evidence);
    const statuses=new Map<string,GridStatus>();
    for(const card of cards) {
      if(!evidence.latest.has(card.id)||card.review.includes('이름 확인'))continue;
      statuses.set(card.id,confirmedReadingCount({cards:[card],...evidence})?'read':card.review.length?'review':'waiting');
    }
    return {completed:confirmedReadingCount({cards,...evidence}),statuses};
  }
}

/** Independent small UI lane; it never counts as watchdog/capture progress.
 * The trailing timer publishes a quiet final read even without a new frame. */
export function createFeedbackPublisher(signal:AbortSignal,publish:()=>void,now=()=>performance.now()) {
  const publisher=createCoalescedPublisher(()=>{if(!signal.aborted)publish();},33,now);
  const stop=()=>publisher.dispose();
  if(signal.aborted)stop();
  else signal.addEventListener('abort',stop,{once:true});
  return {
    request:(force=false)=>publisher.request(force),
    dispose(){stop();signal.removeEventListener('abort',stop);},
  };
}
