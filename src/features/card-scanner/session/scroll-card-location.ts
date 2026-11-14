export interface ScrollCardLocation {percent:number;column:number;row?:number}
export function estimateScrollRows(geometry:{pageSpan:number}|null):number|undefined {
  if(!geometry||!Number.isFinite(geometry.pageSpan)||geometry.pageSpan<=0)return;
  const travel=4/geometry.pageSpan;
  // Full growth inventory has 55 rows, including unopened slots. Thumb pixel
  // rounding is too coarse to infer an integer row count from its height alone.
  return Math.abs(travel-51)<=2?55:undefined;
}
/** Thumb geometry is an estimate, not an inventory ID or proof of coverage.
 * No total-card assumption: filters can change the scrollable row count. */
export function scrollCardLocation(geometry:{position:number;pageSpan:number}|null,slot:number,stable:boolean):ScrollCardLocation|undefined{
  if(!geometry||!Number.isInteger(slot)||slot<0||slot>=40)return;
  const {position,pageSpan}=geometry;
  if(!Number.isFinite(position)||position<0||position>1||!Number.isFinite(pageSpan)||pageSpan<=0)return;
  const result:ScrollCardLocation={percent:Math.round(position*100),column:slot%10+1};
  const travelRows=4/pageSpan,topRow=position*travelRows;
  // The thumb has finite pixel precision. Never round a moving half-row into a slot.
  if(stable&&travelRows<=100&&Math.abs(travelRows-Math.round(travelRows))<.35&&Math.abs(topRow-Math.round(topRow))<.18)
    result.row=Math.round(topRow)+Math.floor(slot/10)+1;
  return result;
}
export function scrollLocationLabel(location:ScrollCardLocation|undefined){
  return !location?'':location.row!==undefined?`${location.row}번째 줄 · ${location.column}번째 칸쯤`:`목록 ${location.percent}% 지점 · ${location.column}번째 칸쯤`;
}
