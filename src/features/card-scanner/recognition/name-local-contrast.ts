/** Exact 5x5 clipped minimum for the existing 128x36 name contrast mask.
 * The horizontal pass stores only original Float32 values (or 255), so the
 * second pass does not round any intermediate arithmetic. */
export function nameLocalContrast(gray: Float32Array): Uint8Array {
  const width=128,height=36;
  if(gray.length!==width*height)throw new RangeError('Invalid name grayscale dimensions');
  const horizontal=new Float32Array(width*height),contrast=new Uint8Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let dark=255;
    for(let dx=-2;dx<=2;dx++)if(x+dx>=0&&x+dx<width)dark=Math.min(dark,gray[y*width+x+dx]);
    horizontal[y*width+x]=dark;
  }
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let dark=255;
    for(let dy=-2;dy<=2;dy++)if(y+dy>=0&&y+dy<height)dark=Math.min(dark,horizontal[(y+dy)*width+x]);
    contrast[y*width+x]=Number(dark<100&&gray[y*width+x]-dark>=45);
  }
  return contrast;
}
