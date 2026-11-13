import {DEFAULT_LAYOUT} from './layout-geometry';

/** The UI scale of the card grid, measured from the cards themselves.
 *
 * The detector finds the scale from the window's title anchor, which is a few hundred pixels
 * wide: it resolves the scale only to about 0.01. That is exact at 2560x1440 full screen (scale
 * 1), but a window drawn at another size (a 2560x1440 window that does not fit the screen,
 * scale about 0.98) is then off by up to 0.005, and over ten columns of 157 pixels the last card
 * is cropped 8 pixels off (its border check fails, its fields are read in the wrong place).
 *
 * The cards have sharp borders against the dark gaps between them, every 472/3 x 728/3 units.
 * Given the anchor position and an approximate scale, this tries pitches around it and keeps the
 * one at which the card edges (left and right of every column, top and bottom of every row, at
 * the best common offset) fall on the strongest brightness steps, when that is clearly (30%) stronger than
 * at the anchor's scale. It only refines a scale the anchor
 * already gave; it never finds a grid on its own. */
export interface GridScaleInput {
  /** Luminance (0..255), row by row. */
  readonly gray:ArrayLike<number>;readonly width:number;readonly height:number;
  /** Where the anchor is, in the same pixels, and the scale it gave. */
  readonly originX:number;readonly originY:number;readonly scale:number;
}

/** Brightness step across x (or y) at a fractional position: |L(p+1)-L(p-1)| averaged along the other axis. */
function profile(input:GridScaleInput,axis:'x'|'y',from:number,to:number):Float32Array {
  const {gray,width,height}=input,length=axis==='x'?width:height,out=new Float32Array(length);
  const a=Math.max(1,Math.floor(from)),b=Math.min(axis==='x'?height-1:width-1,Math.ceil(to));
  if(b<=a)return out;
  const stride=Math.max(1,Math.floor((b-a)/300));
  let samples=0;
  for(let t=a;t<b;t+=stride){
    samples++;
    for(let p=1;p<length-1;p++){
      const before=axis==='x'?gray[t*width+p-1]:gray[(p-1)*width+t],after=axis==='x'?gray[t*width+p+1]:gray[(p+1)*width+t];
      out[p]+=Math.abs(after-before);
    }
  }
  if(samples)for(let p=0;p<length;p++)out[p]/=samples;
  return out;
}
const at=(values:Float32Array,position:number)=>{
  const left=Math.floor(position),fraction=position-left;
  if(left<0||left+1>=values.length)return NaN;
  return values[left]*(1-fraction)+values[left+1]*fraction;
};

/** The edges of the card grid at a scale: every column's left and right edge (x), every row's
 * top and bottom edge (y), in pixels. */
export function gridEdges(originX:number,originY:number,scale:number):{x:number[];y:number[]} {
  const x:number[]=[],y:number[]=[];
  for(let column=0;column<DEFAULT_LAYOUT.columns;column++){
    const left=originX+(DEFAULT_LAYOUT.gridX+column*DEFAULT_LAYOUT.columnStep)*scale;
    x.push(left,left+DEFAULT_LAYOUT.cardWidth*scale);
  }
  for(let row=0;row<DEFAULT_LAYOUT.rows;row++){
    const top=originY+(DEFAULT_LAYOUT.gridY+row*DEFAULT_LAYOUT.rowStep)*scale;
    y.push(top,top+DEFAULT_LAYOUT.cardHeight*scale);
  }
  return {x,y};
}

/** The refined scale and how much stronger its edges are than the anchor's scale (1 = no
 * change), or null when the grid is not visible enough to measure.
 *
 * Only the PITCH is measured: the column (and row) edges are fitted as `a + b * index` with
 * both a and b free, and the scale is b over the default pitch. A constant offset (the anchor a
 * pixel off, a border drawn a pixel inside the card box) moves a, not b; fitting the scale alone
 * would turn such an offset into a scale error, because the grid lies far from the anchor.
 * `range` is in scale units. */
export function fitGridScale(input:GridScaleInput,options:{range?:number;minGain?:number}={}):{scale:number;gain:number}|null {
  const range=options.range??.015,minGain=options.minGain??1.3,{originX,originY,scale}=input;
  if(!(scale>0)||!Number.isFinite(originX)||!Number.isFinite(originY))return null;
  const top=originY+DEFAULT_LAYOUT.gridY*scale,bottom=top+(3*DEFAULT_LAYOUT.rowStep+DEFAULT_LAYOUT.cardHeight)*scale;
  const left=originX+DEFAULT_LAYOUT.gridX*scale,right=left+(9*DEFAULT_LAYOUT.columnStep+DEFAULT_LAYOUT.cardWidth)*scale;
  // Edges across x are measured over the card rows; edges across y over the card columns.
  const across=profile(input,'x',top,bottom),down=profile(input,'y',left,right);
  /** The best a and its edge strength for a pitch b: left and right edges of n cards of size`span` per pitch. */
  // The grid starts where the anchor puts it at this scale; a and b are searched around that.
  const best=(values:Float32Array,start:number,pitch:number,span:number,count:number,unit:number)=>{
    let result={offset:0,value:-Infinity,seen:0};
    for(let offset=-4;offset<=4.001;offset+=.25){
      let sum=0,seen=0;
      for(let index=0;index<count;index++){
        const edge=start+offset+index*pitch*unit;
        for(const position of [edge,edge+span*unit]){const value=at(values,position);if(Number.isFinite(value)){sum+=value;seen++;}}
      }
      if(seen>=count&&sum/seen>result.value)result={offset,value:sum/seen,seen};
    }
    return result;
  };
  const score=(s:number)=>{
    const columns=best(across,originX+DEFAULT_LAYOUT.gridX*s,DEFAULT_LAYOUT.columnStep,DEFAULT_LAYOUT.cardWidth,DEFAULT_LAYOUT.columns,s);
    const rows=best(down,originY+DEFAULT_LAYOUT.gridY*s,DEFAULT_LAYOUT.rowStep,DEFAULT_LAYOUT.cardHeight,DEFAULT_LAYOUT.rows,s);
    return Number.isFinite(columns.value)&&Number.isFinite(rows.value)?(columns.value*columns.seen+rows.value*rows.seen)/(columns.seen+rows.seen):NaN;
  };
  const base=score(scale);
  if(!Number.isFinite(base)||base<=0)return null;
  // Steps of a tenth of a pixel over the whole grid width.
  const step=.1/(9*DEFAULT_LAYOUT.columnStep);
  let found={scale,value:base};
  for(let s=scale-range;s<=scale+range+1e-9;s+=step){
    const value=score(s);
    if(Number.isFinite(value)&&value>found.value)found={scale:Math.round(s*100000)/100000,value};
  }
  // A scale is only moved for a clearly stronger fit: noise must not move a correct anchor scale.
  const gain=found.value/base;
  // A move smaller than 0.002 is below what the anchor itself resolves (0.01 steps) and is not taken.
  return gain>=minGain&&Math.abs(found.scale-scale)>=.002?{scale:found.scale,gain}:{scale,gain:1};
}
