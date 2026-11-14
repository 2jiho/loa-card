/** A prior card thumbnail can help identify the card, but it must not be
 * presented as evidence of what the latest failed observation looked like. */
export function attentionCardImage(cardImage:string,latestImage:string|undefined,hasLatestObservation:boolean,artwork:string|undefined){
 const latest=latestImage?.trim();
 if(hasLatestObservation&&latest)return {src:latest,label:'최근 화면'} as const;
 const reference=cardImage?.trim()||artwork?.trim()||'';
 if(reference)return {src:reference,label:hasLatestObservation?'최근 화면 없음 · 참고용':'참고용'} as const;
 return {src:'',label:hasLatestObservation?'최근 화면 없음':'그림 없음'} as const;
}
