export interface ScrollGap { from:number; to:number }
type Interval = [number,number];
/** Approximate acquisition coverage, never proof of card identity/completeness.
 * Scroll thumb geometry maps the four displayed rows to scrollbar positions.
 * Keep each column independent so one good card cannot hide a rejected neighbor.
 */
export class ScrollCoverage {
  private columns:Interval[][]=Array.from({length:10},()=>[]);
  private span=0;
  private first=Infinity;
  private last=-Infinity;
  snapshot() { return {pageSpan:this.span,first:this.first,last:this.last,columns:this.columns.map(c=>c.map(r=>[...r]))}; }
  reset() { this.columns=Array.from({length:10},()=>[]);this.span=0;this.first=Infinity;this.last=-Infinity; }
  offer(position:number,pageSpan:number,slots:readonly boolean[]) {
    if(!Number.isFinite(position)||position<0||position>1||!Number.isFinite(pageSpan)||pageSpan<=0||pageSpan>1||slots.length!==40)return;
    // A changed thumb size can mean a filter/capacity change. Old ranges must
    // not certify a different inventory view. Small pixel noise is tolerated.
    if(this.span&&Math.abs(pageSpan/this.span-1)>.15)this.reset();
    this.span=pageSpan;
    this.first=Math.min(this.first,position);this.last=Math.max(this.last,position);
    const step=pageSpan/4,tolerance=step*.15;
    for(let i=0;i<40;i++)if(slots[i]) {
      const from=position+Math.floor(i/10)*step;
      const ranges=this.columns[i%10];ranges.push([from,from+step]);
      ranges.sort((a,b)=>a[0]-b[0]);
      const merged:Interval[]=[];
      for(const range of ranges) {
        const previous=merged.at(-1);
        if(previous&&range[0]<=previous[1]+tolerance)previous[1]=Math.max(previous[1],range[1]);
        else merged.push([...range]);
      }
      this.columns[i%10]=merged;
    }
  }
  gaps():ScrollGap[] {
    if(!this.span||this.last<=this.first)return [];
    // Only warn about rows already scrolled past, not the current page which
    // may still be stabilizing. Sub-row quantization gaps are not actionable.
    const minimum=this.span/8,ranges:Interval[]=[];
    for(const column of this.columns) {
      let cursor=this.first;
      for(const [from,to] of column) {
        if(from>this.last)break;
        if(from-cursor>=minimum)ranges.push([cursor,Math.min(from,this.last)]);
        cursor=Math.max(cursor,to);
      }
      if(this.last-cursor>=minimum)ranges.push([cursor,this.last]);
    }
    ranges.sort((a,b)=>a[0]-b[0]);
    const result:ScrollGap[]=[];
    for(const [from,to] of ranges) {
      if(to-from<minimum)continue;
      const previous=result.at(-1);
      if(previous&&from<=previous.to+minimum/4)previous.to=Math.max(previous.to,to);
      else result.push({from,to});
    }
    return result;
  }
}
