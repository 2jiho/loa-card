import type {Box,Layout} from '../acquisition/detector';

/** Experimental ROI: exact visible growth tab, controls, header, scrollbar,
 * and all four card rows. It may include animated portrait/background pixels.
 * Geometry is derived from the detected layout; a clipped or oversized ROI is
 * unavailable, not silently reduced. This does not validate the detector. */
export function completionViewRoi(layout:Layout,width:number,height:number):Box|null {
 if(!layout||!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||
   !Number.isFinite(layout.scale)||layout.scale<=0)return null;
 const {header,area,scrollbar,sort,growthPoints,scale}=layout;
 if(!header||!area||!scrollbar||!sort||!growthPoints)return null;
 const anchorX=header.x-126*scale,anchorY=header.y+2*scale;
 const tab={x:anchorX-150*scale,y:anchorY-76*scale,width:256*scale,height:48*scale};
 const boxes=[header,area,scrollbar,sort,growthPoints,tab];
 if(boxes.some(b=>![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0))return null;
 const x=Math.floor(Math.min(...boxes.map(b=>b.x))),y=Math.floor(Math.min(...boxes.map(b=>b.y)));
 const right=Math.ceil(Math.max(...boxes.map(b=>b.x+b.width))),bottom=Math.ceil(Math.max(...boxes.map(b=>b.y+b.height)));
 const w=right-x,h=bottom-y;
 if(x<0||y<0||right>width||bottom>height||!Number.isSafeInteger(w*h*4)||w*h*4>16*1024*1024)return null;
 return {x,y,width:w,height:h};
}
