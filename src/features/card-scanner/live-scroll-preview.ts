import type {Box, Layout} from './detector';
import {readScrollGeometry} from './scroll-position';

type Pixels<Source>=(source:Source,box:Box,width:number,height:number)=>ArrayLike<number>;
/** Display-only fast path. It cannot register cards or prove scan completion. */
export class LiveScrollPreview<Source> {
  private anchor:{bar:Box;pixels:Uint8Array;textured:boolean[];width:number;height:number;at:number;invalidSince?:number}|undefined;
  private latestBinding=-Infinity;
  private lastRead=-Infinity;
  private pixels:Pixels<Source>;
  constructor(pixels:Pixels<Source>) {this.pixels=pixels;}
  clear(){this.anchor=undefined;this.latestBinding=-Infinity;this.lastRead=-Infinity;}
  bind(source:Source,width:number,height:number,layout:Layout|null,at:number) {
    if(!Number.isFinite(at)||at<this.latestBinding)return;
    this.latestBinding=at;
    // A delayed missing layout is not evidence about today's pixels. The live
    // strip guard below checks whether the last coordinates still apply.
    if(!layout)return;
    const valid=(b:Box)=>[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.x>=0&&b.y>=0&&b.width>0&&b.height>0&&b.x+b.width<=width&&b.y+b.height<=height;
    if(!valid(layout.scrollbar))return;
    const old=this.anchor,b=layout.scrollbar;
    if(old&&old.width===width&&old.height===height&&old.bar.x===b.x&&old.bar.y===b.y&&old.bar.width===b.width&&old.bar.height===b.height)return;
    try {
      const pixels=this.pixels(source,layout.scrollbar,16,942);
      if(pixels.length!==16*942*4)return;
      const guard=this.guard(pixels),textured=[this.textured(guard,0),this.textured(guard,1)];
      this.anchor={bar:{...layout.scrollbar},pixels:guard,textured,width,height,at};
    } catch {this.anchor=undefined;}
  }
  private guard(pixels:ArrayLike<number>) {
    // Arrow areas are static while the thumb moves. Reuse the same readback.
    const result=new Uint8Array(16*32*4),part=16*16*4;
    for(let i=0;i<part;i++){result[i]=pixels[i];result[part+i]=pixels[pixels.length-part+i];}
    return result;
  }
  private textured(guard:Uint8Array,end:number) {
    let sum=0,squares=0;const count=16*16*3,part=16*16*4;
    for(let i=0;i<part;i++)if(i%4!==3){const v=guard[end*part+i];sum+=v;squares+=v*v;}
    return squares/count-(sum/count)**2>=144;
  }
  /** undefined = throttled; null = hide stale/invalid preview. */
  read(source:Source,width:number,height:number,now:number):ReturnType<typeof readScrollGeometry>|undefined {
    if(!Number.isFinite(now))return null;
    if(now-this.lastRead<32)return;
    this.lastRead=now;
    const a=this.anchor;
    if(!a||now<a.at||width!==a.width||height!==a.height){this.anchor=undefined;return null;}
    try {
      const pixels=this.pixels(source,a.bar,16,942);
      if(pixels.length!==16*942*4){this.anchor=undefined;return null;}
      const guard=this.guard(pixels);
      const difference=[0,0],part=16*16*4;
      for(let i=0;i<guard.length;i++)if(i%4!==3){
        const end=i<part?0:1;difference[end]+=Math.abs(guard[i]-a.pixels[i]);
      }
      const matches=difference.map(d=>d/(16*16*3)<=8);
      // An endpoint arrow changes when disabled or hovered. One unchanged,
      // textured arrow plus a freshly detected thumb still locates this strip.
      const geometry=readScrollGeometry(pixels,16,942);
      const guarded=matches.every(Boolean)||geometry!==null&&matches.some((match,i)=>match&&a.textured[i]);
      // Hide immediately on a mismatch, but let a transient cursor/overlay
      // recover without waiting for another expensive layout detection.
      if(!guarded){
        a.invalidSince??=now;
        if(now-a.invalidSince>=2000)this.anchor=undefined;
        return null;
      }
      a.invalidSince=undefined;
      // Learn the active/disabled appearance only after the other endpoint and
      // thumb independently agree. Otherwise top-to-bottom scrolling would
      // eventually differ from BOTH endpoint states of the very first frame.
      if(geometry)for(let end=0;end<2;end++)if(!matches[end]&&this.textured(guard,end)){
        a.pixels.set(guard.subarray(end*part,(end+1)*part),end*part);
        a.textured[end]=this.textured(guard,end);
      }
      return geometry;
    } catch {this.anchor=undefined;return null;}
  }
}
