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
