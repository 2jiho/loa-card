import type {Layout} from './detector';
import {estimateRowShift} from './grid-motion';

/** Fixed ten-column grid; proposes only integral vertical shifts. The caller
 * still verifies full source pixels. A hint never establishes card identity. */
export function createGridScrollProbe(){
  let previous:Uint8Array[]=[],previousGeometry='';
  return (pixels:{data:Uint8ClampedArray;width:number;height:number},origin:{x:number;y:number},layout:Layout,frameWidth:number,frameHeight:number)=>{
    const {area,cells}=layout;
    if(cells.length!==40||area.width<=0||area.height<=0){previous=[];previousGeometry='';return null;}
    const geometry=JSON.stringify([frameWidth,frameHeight,area,cells,layout.scale]);
    const vectors=cells.map(box=>{
      const vector=new Uint8Array(48);
      for(let y=0;y<8;y++)for(let x=0;x<6;x++){
        const px=Math.round(box.x+box.width*(.15+.7*x/5))-origin.x;
        const py=Math.round(box.y+box.height*(.27+.34*y/7))-origin.y;
        let sum=0,count=0;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          const xx=px+dx,yy=py+dy;
          if(xx<0||yy<0||xx>=pixels.width||yy>=pixels.height)continue;
          const i=(yy*pixels.width+xx)*4;
          sum+=.299*pixels.data[i]+.587*pixels.data[i+1]+.114*pixels.data[i+2];count++;
        }
        vector[y*6+x]=count?Math.round(sum/count):0;
      }
      return vector;
    });
    const shift=geometry===previousGeometry?estimateRowShift(previous,vectors):null;
    previous=vectors;previousGeometry=geometry;
    return shift;
  };
}
