/** Approximate portrait groups schedule work only; they never identify, merge or drop cards. */
export class LiveWorkPriority {
  private groups: { column:number; signature:Float32Array; centered:Float32Array; norm:number; label:Uint8Array; reads:number; ocrAttempts:number }[]=[];
  group(feature:Uint8Array,column:number) {
    if(feature.length!==3240)return -1;
    const signature=new Float32Array(24);
    // Inner artwork avoids dynamic count/jewel fields. The fixed name band
    // below also has to agree: different cards may share the very same artwork.
    for(let y=5;y<11;y++)for(let x=2;x<10;x+=2) {
      let sum=0;
      for(let dx=0;dx<2;dx++) {
        const i=2592+(y*12+x+dx)*3;
        sum+=feature[i]+feature[i+1]+feature[i+2];
      }
      signature[(y-5)*4+(x-2)/2]=sum/6;
    }
    let mean=0;for(const value of signature)mean+=value;mean/=24;
    const centered=signature.map(v=>v-mean),norm=Math.hypot(...centered);
    let best=-1,distance=12;
    for(let i=0;i<this.groups.length;i++) {
      const group=this.groups[i];if(group.column!==column)continue;
      let delta=0,dot=0;
      for(let j=0;j<24;j++){delta+=Math.abs(signature[j]-group.signature[j]);dot+=centered[j]*group.centered[j];}
      delta/=24;
      // Similar average colors alone cannot make different cards already-read.
      const similar=norm<1||group.norm<1 ? norm<1&&group.norm<1&&delta<3 : dot/(norm*group.norm)>=.94;
      if(similar&&delta<distance) {
        let labelDifference=0;
        for(let j=0;j<864;j++)labelDifference+=Math.abs(feature[j]-group.label[j]);
        if(labelDifference/864<5){distance=delta;best=i;}
      }
    }
    if(best>=0)return best;
    if(this.groups.length>=2048)return -1;
    this.groups.push({column,signature,centered,norm,label:feature.slice(0,864),reads:0,ocrAttempts:0});return this.groups.length-1;
  }
  priority(group:number) { return this.groups[group]?.reads??0; }
  serviced(group:number) { if(this.groups[group])this.groups[group].reads++; }
  attempts(group:number) { return this.groups[group]?.ocrAttempts??0; }
  attempted(group:number) { if(this.groups[group])this.groups[group].ocrAttempts++; }
  /** Failed OCR is still work. Among unread groups give a first attempt to
   * another card before revisiting the same unread group. The fractional
   * component never makes an unread group rank behind a confirmed group. */
  retryPriority(group:number) { return this.priority(group)+Math.min(this.attempts(group),31)/32; }
}
