/** Experimental completion evidence. This module is not connected to the
 * scanner and cannot attest that the caller sampled the actual live frame or
 * that its ROI contains every relevant control, card and possible occluder. */
export interface CompletionView {
  readonly sessionId:string;
  readonly inputId:number;
  readonly captureTime:number;
  /** Must describe the exact shared-input and ROI geometry, not an estimate. */
  readonly geometry:string;
  readonly width:number;
  readonly height:number;
  readonly pixels:Uint8Array|Uint8ClampedArray;
}
type OwnedCompletionView=Omit<CompletionView,'pixels'>&{pixels:Uint8Array};
const MAX_BYTES=16*1024*1024;
function valid(view:CompletionView|undefined):view is CompletionView {
  return !!view&&typeof view.sessionId==='string'&&view.sessionId.length>0&&view.sessionId.length<=160&&
    Number.isSafeInteger(view.inputId)&&view.inputId>0&&Number.isFinite(view.captureTime)&&view.captureTime>=0&&
    typeof view.geometry==='string'&&view.geometry.length>0&&view.geometry.length<=4096&&
    Number.isSafeInteger(view.width)&&view.width>0&&Number.isSafeInteger(view.height)&&view.height>0&&
    (view.pixels instanceof Uint8Array||view.pixels instanceof Uint8ClampedArray)&&view.pixels.buffer instanceof ArrayBuffer&&
    Number.isSafeInteger(view.width*view.height*4)&&view.pixels.byteLength===view.width*view.height*4&&view.pixels.byteLength<=MAX_BYTES;
}
/** The reference must originate from the exact successful acquisition that
 * supplied the current inventory/header evidence. The caller must verify that
 * provenance; matching this snapshot alone is not an identity or field proof. */
export class CompletionViewSnapshot {
  readonly #view:OwnedCompletionView;
  constructor(view:CompletionView){
    if(!valid(view))throw new TypeError('Invalid completion view');
    this.#view={...view,pixels:Uint8Array.from(view.pixels)};
  }
  matches(current:CompletionView|undefined,lastArrival:number):boolean {
    const reference=this.#view;
    if(!valid(current)||!Number.isSafeInteger(lastArrival)||lastArrival<1||current.inputId!==lastArrival||
      current.sessionId!==reference.sessionId||current.inputId<reference.inputId||current.captureTime<reference.captureTime||
      current.geometry!==reference.geometry||current.width!==reference.width||current.height!==reference.height)return false;
    for(let index=0;index<reference.pixels.length;index++)if(reference.pixels[index]!==current.pixels[index])return false;
    return true;
  }
}
/** Exact comparison is deliberately conservative: animation inside the ROI
 * can prevent stopping. A match does not establish unseen earlier inputs. */
export function currentCompletionViewMatches(reference:CompletionViewSnapshot,current:CompletionView|undefined,
  lastArrival:number):boolean {return reference instanceof CompletionViewSnapshot&&reference.matches(current,lastArrival);}
/** Sampling, state check, and stop are all synchronous within one task. This
 * prevents awaiting OCR or another callback between the final sample and
 * commit, but it does not authenticate the producer or underlying OS frame. */
export function commitWithCurrentView(reference:CompletionViewSnapshot,lastArrival:number,
  sampleNow:()=>CompletionView|undefined,evidenceReady:()=>boolean,stop:()=>void):boolean {
  let accepted=false;
  try {
    const current=sampleNow();
    accepted=currentCompletionViewMatches(reference,current,lastArrival)&&evidenceReady()===true;
  } catch {return false;}
  if(!accepted)return false;
  // A throwing stop callback can have stopped some tracks. Propagate the
  // failure instead of falsely reporting that no stop was attempted.
  stop();return true;
}
