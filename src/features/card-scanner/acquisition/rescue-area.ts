/** Pixels for the fixed-row rescue features of one frame.
 *
 * Every admitted crop keeps a small gray feature of its cell for a later rescue attempt.
 * Reading each cell from the frame canvas separately was the largest single cost on the main
 * thread while sharing (docs/dev-recording.md, "공유 중 메인 스레드 CPU 프로파일"). Instead the
 * area that holds all cells is read once per frame and each cell is cut out of that copy.
 * The cut is a plain copy of the same RGBA bytes, so the feature computed from it is the
 * feature the per-cell read gives. */
export interface PixelBox {readonly x:number;readonly y:number;readonly width:number;readonly height:number}
export interface RescueArea extends PixelBox {readonly data:Uint8ClampedArray}

/** The smallest whole-pixel box inside the frame that holds every cell (rounded as the
 * per-cell read rounds them). Null when there is nothing inside the frame to read. */
export function rescueAreaBounds(cells:readonly PixelBox[],frameWidth:number,frameHeight:number):PixelBox|null {
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const cell of cells){
    const x=Math.round(cell.x),y=Math.round(cell.y);
    left=Math.min(left,x);top=Math.min(top,y);
    right=Math.max(right,x+Math.round(cell.width));bottom=Math.max(bottom,y+Math.round(cell.height));
  }
  left=Math.max(0,left);top=Math.max(0,top);right=Math.min(frameWidth,right);bottom=Math.min(frameHeight,bottom);
  if(!Number.isFinite(left+top+right+bottom)||right<=left||bottom<=top)return null;
  return {x:left,y:top,width:right-left,height:bottom-top};
}

/** The RGBA bytes of one whole-pixel box cut out of the area. Null when the box is not
 * entirely inside the area; the caller then reads that box directly. */
export function cutRescueArea(area:RescueArea,x:number,y:number,width:number,height:number):Uint8ClampedArray|null {
  if(![x,y,width,height].every(Number.isSafeInteger)||width<=0||height<=0)return null;
  if(x<area.x||y<area.y||x+width>area.x+area.width||y+height>area.y+area.height)return null;
  if(area.data.length!==area.width*area.height*4)return null;
  const pixels=new Uint8ClampedArray(width*height*4);
  for(let row=0;row<height;row++){
    const from=((y-area.y+row)*area.width+(x-area.x))*4;
    pixels.set(area.data.subarray(from,from+width*4),row*width*4);
  }
  return pixels;
}
