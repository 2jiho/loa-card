import type {ScannerState} from './features/card-scanner/orchestration/scanner';
import type {PartialSnapshot} from './features/card-scanner/persistence/partial-store';

// A display-only projection; no OCR text, image, evidence, or provenance claim.
export function toPartialSnapshot(result:ScannerState):PartialSnapshot {
 return {cards:result.cards.map(card=>{
  const review=card.review.length>0;
  const awakening=!review&&Number.isInteger(card.awakening)&&card.awakening!>=0&&card.awakening!<=5?card.awakening:null;
  let extraCopies=!review&&card.countReliable===true&&Number.isInteger(card.extraCopies)&&card.extraCopies!>=0&&card.extraCopies!<=15?card.extraCopies:null;
  if(awakening!==null&&extraCopies!==null&&extraCopies>15-awakening*(awakening+1)/2)extraCopies=null;
  return {id:card.id,name:card.name,identityUncertain:review,awakening,extraCopies};
 }),expected:result.expected,growthPoints:result.growthPointsEstimated?null:result.growthPoints?.current??null};
}
