/** One pending crop per visual group. Replacements release their old raster immediately. */
export class CandidateQueue<T extends { group: number }> {
  private values = new Map<number, T>();
  private capacity: number;
  private release: (item: T) => void;
  private replace:(previous:T,next:T)=>boolean;
  constructor(capacity: number, release: (item: T) => void,
    replace:(previous:T,next:T)=>boolean=()=>true) { this.capacity = capacity; this.release = release;this.replace=replace; }
  get length() { return this.values.size; }
  push(item: T): boolean {
    const previous = this.values.get(item.group);
    if(previous&&!this.replace(previous,item))return false;
    if (!previous && this.values.size >= this.capacity) return false;
    if (previous) this.release(previous);
    this.values.set(item.group, item);
    return true;
  }
  shift(priority?: (item:T)=>number): T | undefined {
    let selected: T | undefined, score=Infinity;
    for(const item of this.values.values()) {
      const next=priority?.(item)??0;
      if(!selected||next<score){selected=item;score=next;}
      if(!priority||score===0)break;
    }
    if(selected)this.values.delete(selected.group);
    return selected;
  }
  clear() { for (const value of this.values.values()) this.release(value); this.values.clear(); }
}
