/** Copy an integer rectangle from one readback without interpolation or aliasing. */
export function pixelRegion(source:{data:Uint8ClampedArray;width:number;height:number},x:number,y:number,width:number,height:number){
  if(![x,y,width,height].every(Number.isInteger)||x<0||y<0||width<=0||height<=0||x+width>source.width||y+height>source.height)return undefined;
  const data=new Uint8ClampedArray(width*height*4);
  for(let row=0;row<height;row++){
    const start=((y+row)*source.width+x)*4;
    data.set(source.data.subarray(start,start+width*4),row*width*4);
  }
  return {data,width,height};
}
