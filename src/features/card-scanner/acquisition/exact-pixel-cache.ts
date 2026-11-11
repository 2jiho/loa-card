/** Bounded cache for identical source pixels, including alpha. No approximate
 * matching: one changed byte invalidates the cached analysis. */
const RECTANGLE_MISMATCH=Object.freeze({matched:false as const});
export class ExactPixelCache<T> {
  private entries = new Map<number, { key: string; pixels: Uint8ClampedArray; value: T }>();
  private limit: number;
  constructor(limit = 40) { this.limit = limit; }
  /** Immutable pixel snapshots may be shared while the next grid overwrites slots. */
  snapshot() {
    const result=new ExactPixelCache<T>(this.limit);
    result.entries=new Map(this.entries);
    return result;
  }
  get(slot: number, key: string, pixels: Uint8ClampedArray): T | undefined {
    const entry = this.entries.get(slot);
    if (!entry || entry.key !== key || entry.pixels.length !== pixels.length) return undefined;
    if (entry.pixels.byteOffset % 4 === 0 && pixels.byteOffset % 4 === 0 && pixels.byteLength % 4 === 0) {
      const a = new Uint32Array(entry.pixels.buffer, entry.pixels.byteOffset, entry.pixels.byteLength / 4), b = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
      for (let i=0;i<a.length;i++) if(a[i]!==b[i]) return undefined;
    } else {
      for (let i=0;i<pixels.length;i++) if(entry.pixels[i]!==pixels[i]) return undefined;
    }
    return entry.value;
  }
  /** Development-only callers can measure the *same* exact comparison without
   * double-reading the pixels. `bytesCompared` includes the first differing
   * word/byte; geometry/key misses compare zero bytes. This is diagnostic
   * work, not evidence of an independent observation or a live benchmark. */
  getMeasured(slot: number, key: string, pixels: Uint8ClampedArray): {
    value: T | undefined; bytesCompared: number; eligible: boolean;
  } {
    if(import.meta.env&&!import.meta.env.DEV)throw Error('Move profiling is available only in development');
    const entry = this.entries.get(slot);
    if (!entry || entry.key !== key || entry.pixels.length !== pixels.length)
      return {value:undefined,bytesCompared:0,eligible:false};
    let bytesCompared=0;
    if (entry.pixels.byteOffset % 4 === 0 && pixels.byteOffset % 4 === 0 && pixels.byteLength % 4 === 0) {
      const a = new Uint32Array(entry.pixels.buffer, entry.pixels.byteOffset, entry.pixels.byteLength / 4), b = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
      for (let i=0;i<a.length;i++) {bytesCompared+=4;if(a[i]!==b[i])return {value:undefined,bytesCompared,eligible:true};}
    } else {
      for (let i=0;i<pixels.length;i++) {bytesCompared++;if(entry.pixels[i]!==pixels[i])return {value:undefined,bytesCompared,eligible:true};}
    }
    return {value:entry.value,bytesCompared,eligible:true};
  }
  /** Compare an entire padded rectangle in an already-read raster without
   * allocating a region copy. This is the same full RGBA comparison as get;
   * row stride, every channel and the source view's byte offset matter. */
  getRectangle(slot:number,key:string,source:Uint8ClampedArray,sourceWidth:number,sourceHeight:number,
    x:number,y:number,width:number,height:number):{readonly matched:true;readonly value:T}|typeof RECTANGLE_MISMATCH|undefined {
    const entry=this.entries.get(slot);
    if(!entry||entry.key!==key||!(source.buffer instanceof ArrayBuffer)||
      ![sourceWidth,sourceHeight,x,y,width,height].every(Number.isSafeInteger)||sourceWidth<1||sourceHeight<1||
      x<0||y<0||width<1||height<1||width>sourceWidth||height>sourceHeight||
      x>sourceWidth-width||y>sourceHeight-height||
      !Number.isSafeInteger(sourceWidth*sourceHeight*4)||source.length!==sourceWidth*sourceHeight*4||
      !Number.isSafeInteger(width*height*4)||entry.pixels.length!==width*height*4)return;
    if(entry.pixels.byteOffset%4===0&&source.byteOffset%4===0){
      const a=new Uint32Array(entry.pixels.buffer,entry.pixels.byteOffset,entry.pixels.byteLength/4);
      const b=new Uint32Array(source.buffer,source.byteOffset,source.byteLength/4);
      for(let row=0;row<height;row++)for(let col=0;col<width;col++)
        if(a[row*width+col]!==b[(y+row)*sourceWidth+x+col])return RECTANGLE_MISMATCH;
    }else{
      const rowBytes=width*4;
      for(let row=0;row<height;row++)for(let byte=0;byte<rowBytes;byte++)
        if(entry.pixels[row*rowBytes+byte]!==source[((y+row)*sourceWidth+x)*4+byte])return RECTANGLE_MISMATCH;
    }
    return {matched:true,value:entry.value};
  }
  /** Selection metadata only: compare every RGBA byte in explicit integer
   * regions against the existing immutable snapshot. This never authorizes
   * whole-crop reuse, identity, source lineage or field-value confirmation. */
  getRegions(slot:number,key:string,pixels:Uint8ClampedArray,width:number,
    regions:readonly {x:number;y:number;width:number;height:number}[],matches:(value:T)=>boolean):T|undefined {
    const entry=this.entries.get(slot);
    if(!entry||entry.key!==key||entry.pixels.length!==pixels.length||!Number.isSafeInteger(width)||width<1||
      pixels.length%(width*4)!==0||!regions.length||!matches(entry.value))return;
    const height=pixels.length/(width*4);
    // Validate the entire mask before consulting any pixels. Empty, fractional
    // or clipped masks cannot manufacture an equal-region selection receipt.
    if(regions.some(box=>![box.x,box.y,box.width,box.height].every(Number.isSafeInteger)||box.x<0||box.y<0||
      box.width<1||box.height<1||box.x+box.width>width||box.y+box.height>height))return;
    // Compare one complete RGBA pixel per iteration where both views permit
    // it. This is byte equality, including alpha, not a sampled/hash match.
    if(entry.pixels.byteOffset%4===0&&pixels.byteOffset%4===0) {
      const a=new Uint32Array(entry.pixels.buffer,entry.pixels.byteOffset,entry.pixels.byteLength/4);
      const b=new Uint32Array(pixels.buffer,pixels.byteOffset,pixels.byteLength/4);
      for(const box of regions)for(let row=box.y;row<box.y+box.height;row++) {
        const start=row*width+box.x,end=start+box.width;
        for(let index=start;index<end;index++)if(a[index]!==b[index])return;
      }
      return entry.value;
    }
    for(const box of regions)for(let row=box.y;row<box.y+box.height;row++) {
      const start=(row*width+box.x)*4,end=start+box.width*4;
      for(let index=start;index<end;index++)if(entry.pixels[index]!==pixels[index])return;
    }
    return entry.value;
  }
  set(slot: number, key: string, pixels: Uint8ClampedArray, value: T) {
    this.store(slot,key,pixels,value,true);
  }
  /** Caller transfers an immutable, independently allocated pixel snapshot.
   * Do not use for scratch buffers, live views, or transferable arrays. */
  setOwned(slot:number,key:string,pixels:Uint8ClampedArray,value:T) {
    this.store(slot,key,pixels,value,false);
  }
  private store(slot:number,key:string,pixels:Uint8ClampedArray,value:T,copy:boolean) {
    if (this.limit <= 0) return;
    this.entries.delete(slot);
    if (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(slot, { key, pixels: copy ? pixels.slice() : pixels, value });
  }
}
