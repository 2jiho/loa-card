/** Experimental completion barrier. It does not capture pixels, schedule OCR,
 * or alter the scanner's default auto-stop policy. The caller must obtain each
 * sample from its actual immutable input, covering every relevant UI region. */
export interface CompletionSample {readonly geometry:string;readonly pixels:Uint8Array|Uint8ClampedArray}
const ownedPixels=(pixels:unknown):pixels is Uint8Array|Uint8ClampedArray =>
  (pixels instanceof Uint8Array||pixels instanceof Uint8ClampedArray)&&pixels.buffer instanceof ArrayBuffer;
export class CompletionRaceGuard {
  private readonly reference:Uint8Array;
  private readonly geometry:string;
  private latestArrival:number;
  private latestMeasured:number;
  private changed=false;
  private closed=false;
  private headerFinished=false;
  private headerValid=false;

  constructor(firstArrival:number,sample:CompletionSample) {
    if(!Number.isSafeInteger(firstArrival)||firstArrival<1||!sample||typeof sample.geometry!=='string'||
      !sample.geometry.length||sample.geometry.length>4096||
      !ownedPixels(sample.pixels)||
      sample.pixels.byteLength<1||sample.pixels.byteLength>16*1024*1024)throw new TypeError('Invalid completion input');
    this.latestArrival=this.latestMeasured=firstArrival;
    this.geometry=sample.geometry;this.reference=Uint8Array.from(sample.pixels);
  }

  /** Every delivered input is noted, even if acquisition is skipped. A timer
   * tick is not a new frame, and an arrival identifier alone is not proof. */
  arrival(id:number):void {
    if(this.closed||!Number.isSafeInteger(id)||id<=this.latestArrival)throw new TypeError('Invalid completion arrival');
    this.latestArrival=id;
  }

  /** Caller supplies detached pixels actually sampled from the matching input.
   * Exact equality is deliberately stricter than a perceptual similarity. */
  measure(id:number,sample:CompletionSample):boolean {
    if(this.closed||!Number.isSafeInteger(id)||id!==this.latestMeasured+1||id>this.latestArrival||
      !sample||sample.geometry!==this.geometry||
      !ownedPixels(sample.pixels)||
      sample.pixels.byteLength!==this.reference.byteLength) {
      this.changed=true;return false;
    }
    const pixels=sample.pixels;
    for(let i=0;i<pixels.length;i++)if(pixels[i]!==this.reference[i]){this.changed=true;break;}
    this.latestMeasured=id;
    return !this.changed;
  }

  /** The result must refer to the header snapshot used to begin this epoch. */
  finishHeader(valid:boolean):void {
    if(this.closed||this.headerFinished||typeof valid!=='boolean')throw new TypeError('Invalid completion header result');
    this.headerFinished=true;this.headerValid=valid;
  }
  canCommit(inputSettled:boolean,fieldsSettled:boolean):boolean {
    return !this.closed&&this.headerFinished&&this.headerValid&&!this.changed&&
      inputSettled===true&&fieldsSettled===true&&this.latestArrival===this.latestMeasured;
  }
  close(){this.closed=true;}
}
