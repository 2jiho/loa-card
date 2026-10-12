import { alignCardBorders as original } from '../../src/features/card-scanner/card-borders';
import type { Box } from '../../src/features/card-scanner/detector';

/** Bounded scale correction only if four continuous sides improve together.
 * Never stretch a crop merely because one portrait/tooltip edge matches. */
export function alignCardBorders(rgba:ArrayLike<number>, width:number, height:number, box:Box, scale=1) {
  const baseline=original(rgba,width,height,box,scale);
  if(baseline.intact||baseline.alignment<.55)return baseline;
  let best=baseline;
  for(const delta of [-.0125,.0125]) {
    const w=box.width*(1+delta),h=box.height*(1+delta);
    const candidate=original(rgba,width,height,{x:box.x+(box.width-w)/2,y:box.y+(box.height-h)/2,width:w,height:h},scale*(1+delta));
    if(candidate.intact&&candidate.alignment>best.alignment+.15)best=candidate;
  }
  return best;
}

/** Only the upper perimeter is certified. This is identity evidence, never
 * permission to read jewels/counts from a card whose lower border is missing. */
export function visibleIdentity(rgba:ArrayLike<number>,width:number,height:number,box:Box,scale:number) {
  if(box.x<0||box.y<0||box.x+box.width>width||box.y+box.height>height)return false;
  const edge=(x:number,y:number,nx:number,ny:number)=>{
    const a=(Math.round(y)*width+Math.round(x))*4,b=(Math.round(ny)*width+Math.round(nx))*4;
    if(Math.min(x,y,nx,ny)<0||Math.max(x,nx)>=width||Math.max(y,ny)>=height)return false;
    return Math.max(...[0,1,2].map(c=>Math.abs(rgba[a+c]-rgba[b+c])))>=10;
  };
  const sides=[0,0,0];
  for(let i=0;i<20;i++) {
    const y=box.y+box.height*(.12+.3*i/19),x=box.x+box.width*(.12+.76*i/19);
    sides[0]+=Number(edge(box.x,y,box.x-3*scale,y));
    sides[1]+=Number(edge(box.x+box.width-2*scale,y,box.x+box.width+scale,y));
    sides[2]+=Number(edge(x,box.y+2*scale,x,box.y-2*scale));
  }
  return sides.every(n=>n>=18);
}
