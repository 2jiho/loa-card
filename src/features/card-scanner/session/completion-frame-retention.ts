import type {Box} from '../acquisition/detector';

export interface CompletionFrameMetadata {
  readonly box:Box;readonly geometry:string;readonly sourceWidth:number;readonly sourceHeight:number;
  readonly frame:number;readonly inputId:number;readonly captureTime:number;
}
/** The factory must create a distinct owned handle to the same immutable
 * source. A size estimate is a logical limit, not GPU/process RSS proof. */
export class CompletionFrameRetention<T> {
  #current:{frame:T;release:()=>void;meta:CompletionFrameMetadata}|undefined;
  #closed=false;
  #releaseFailed=false;
  private readonly maxBytes:number;
  private readonly own:(source:T,meta:CompletionFrameMetadata)=>{frame:T;release:()=>void};
  constructor(maxBytes:number,own:(source:T,meta:CompletionFrameMetadata)=>{frame:T;release:()=>void}) {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw TypeError('Invalid completion frame limit');
    this.maxBytes=maxBytes;this.own=own;
  }
  get available(){return !!this.#current&&!this.#closed&&!this.#releaseFailed;}
  clear():void {
    const old=this.#current;this.#current=undefined;
    if(old)try{old.release();}catch(error){this.#releaseFailed=true;throw error;}
  }
  replace(source:T,meta:CompletionFrameMetadata):void {
    // An unavailable, invalid or failed new acquisition must never leave a
    // previous frame available as its replacement.
    this.clear();
    if(this.#closed||this.#releaseFailed)throw Error('Completion frame retention unavailable');
    const {box:b,sourceWidth:w,sourceHeight:h}=meta??{};
    if(!Number.isSafeInteger(w)||w<1||!Number.isSafeInteger(h)||h<1||!Number.isSafeInteger(w*h*4)||w*h*4>this.maxBytes||
      !b||![b.x,b.y,b.width,b.height].every(Number.isSafeInteger)||b.x<0||b.y<0||b.width<1||b.height<1||
      b.x+b.width>w||b.y+b.height>h||typeof meta.geometry!=='string'||!meta.geometry||meta.geometry.length>4096||
      !Number.isSafeInteger(meta.frame)||meta.frame<1||!Number.isSafeInteger(meta.inputId)||meta.inputId<1||
      !Number.isFinite(meta.captureTime)||meta.captureTime<0)throw TypeError('Invalid completion frame metadata');
    const owned=this.own(source,meta);
    if(!owned||!owned.frame||typeof owned.release!=='function'){
      if(owned&&typeof owned.release==='function')try{owned.release();}catch{this.#releaseFailed=true;}
      throw TypeError('Invalid owned completion frame');
    }
    this.#current={...owned,meta:Object.freeze({...meta,box:Object.freeze({...b})})};
  }
  /** A synchronous borrow: the caller must not retain or close this frame. */
  read<R>(borrow:(frame:T,meta:CompletionFrameMetadata)=>R):R|undefined {
    const current=this.#current;if(!current||this.#closed||this.#releaseFailed)return;
    return borrow(current.frame,current.meta);
  }
  dispose():void {if(this.#closed)return;this.#closed=true;this.clear();}
}
