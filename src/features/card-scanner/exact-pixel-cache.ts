/** Bounded cache for identical source pixels, including alpha. No approximate
 * matching: one changed byte invalidates the cached analysis. */
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
