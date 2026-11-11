/** A header OCR result belongs to the captured pixels and input chronology,
 * not to whichever mutable Canvas is current when the Promise resolves. */
export interface CompletionHeaderInput {
  width:number;height:number;pixels:Uint8ClampedArray;captureTime:number;sourceFrame:number;
}
export interface CompletionHeaderSnapshot extends CompletionHeaderInput {pixels:Uint8ClampedArray<ArrayBuffer>}
export interface InventoryHeaderTotal {owned:number;capacity:number}
export const HEADER_CONFLICT_WARNING='보관함 수량이나 용량이 다르게 읽혔어요. 성장 탭을 다시 보여 주고 계속 다르면 처음부터 다시 스캔해 주세요.';

/** An unreadable subsequent header is not evidence that a conflict cleared. */
export function nextHeaderConflict(current:boolean|undefined,comparison:'matching'|'different'|'unavailable'):boolean {
  return comparison==='different' || comparison==='unavailable' && current===true;
}

/** A header is a pair.  Equality of owned alone cannot verify a changed or
 * misread storage capacity.  This compares OCR outputs, not the underlying
 * pixels or a possibly skipped later input; callers must bind the observed
 * value to a fresh header snapshot before using the result. */
export function compareInventoryHeaderTotal(
  initial:{owned:number|null;capacity:number|null},observed:InventoryHeaderTotal|null|undefined,
):'matching'|'different'|'unavailable' {
  const valid=(total:{owned:number|null;capacity:number|null}|null|undefined):total is InventoryHeaderTotal=>
    !!total&&Number.isSafeInteger(total.owned)&&Number.isSafeInteger(total.capacity)&&
    total.owned!>0&&total.capacity!>=total.owned!&&total.capacity!<=2000;
  if(!valid(initial)||!valid(observed))return 'unavailable';
  return initial.owned===observed.owned&&initial.capacity===observed.capacity?'matching':'different';
}
const MAX_HEADER_BYTES=4*1024*1024;
function valid(input:CompletionHeaderInput):boolean {
  return !!input&&Number.isSafeInteger(input.width)&&input.width>0&&Number.isSafeInteger(input.height)&&input.height>0&&
    Number.isFinite(input.captureTime)&&input.captureTime>=0&&Number.isSafeInteger(input.sourceFrame)&&input.sourceFrame>=1&&
    input.pixels instanceof Uint8ClampedArray&&input.pixels.buffer instanceof ArrayBuffer&&
    input.pixels.length===input.width*input.height*4&&input.pixels.byteLength<=MAX_HEADER_BYTES;
}
export function snapshotHeader(input:CompletionHeaderInput):CompletionHeaderSnapshot {
  if(!valid(input))throw new TypeError('Invalid completion header');
  return Object.freeze({...input,pixels:new Uint8ClampedArray(input.pixels)});
}
/** A newer input can preserve this result only with exact header pixels.
 * Identical text inferred from lossy or unmeasured pixels is not evidence. */
export function headerSnapshotMatches(snapshot:CompletionHeaderSnapshot,current:CompletionHeaderInput):boolean {
  if(!valid(snapshot)||!valid(current)||current.width!==snapshot.width||current.height!==snapshot.height||
    current.captureTime<snapshot.captureTime||current.sourceFrame<snapshot.sourceFrame)return false;
  for(let i=0;i<snapshot.pixels.length;i++)if(snapshot.pixels[i]!==current.pixels[i])return false;
  return true;
}
