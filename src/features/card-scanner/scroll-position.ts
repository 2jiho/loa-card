/** Read the thumb's horizontal edges, excluding the arrow buttons. */
export function readScrollGeometry(rgba: ArrayLike<number>, width: number, height: number): { position:number; pageSpan:number } | null {
  if(width<4||height<60||rgba.length!==width*height*4)return null;
  const edges: number[] = [];
  for (let y = 18; y < height - 30; y++) {
    let gold = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (r > 100 && g > 90 && b < g * .85 && r > g * 1.05) gold++;
    }
    if (gold >= width * .4 && (!edges.length || y - edges.at(-1)! > 3)) edges.push(y);
  }
  if (edges.length !== 2) {
    // The moving/inactive thumb can be gray. Require two bright strokes around
    // a filled rectangle instead of broadening the gold color threshold.
    const levels=new Float32Array(height),left=Math.floor(width*.125),right=Math.ceil(width*.69);
    for(let y=0;y<height;y++) {
      for(let x=left;x<right;x++) {const i=(y*width+x)*4;levels[y]+=(rgba[i]+rgba[i+1]+rgba[i+2])/3;}
      levels[y]/=right-left;
    }
    const peaks:{y:number;contrast:number}[]=[];
    for(let y=20;y<height-33;y++) {
      const contrast=levels[y]-Math.max(levels[y-3],levels[y+3]);
      if(levels[y]<45||contrast<12)continue;
      const previous=peaks.at(-1);
      if(previous&&y-previous.y<=4){if(contrast>previous.contrast){previous.y=y;previous.contrast=contrast;}}
      else peaks.push({y,contrast});
    }
    if(peaks.length!==2)return null;
    const [top,bottom]=peaks.map(p=>p.y);
    const outside=(levels[top-5]+levels[bottom+5])/2;
    let filled=0;
    for(let y=top+4;y<bottom-4;y++)if(levels[y]>outside+6)filled++;
    if(filled<Math.max(1,bottom-top-8)*.8)return null;
    edges.splice(0,edges.length,top,bottom);
  }
  const thumb = edges[1] - edges[0], track = height - 40;
  if (thumb < height * .04 || thumb > height * .3) return null;
  return {position:Math.max(0, Math.min(1, (edges[0] - 20) / (track - thumb))),pageSpan:thumb/(track-thumb)};
}

export function readScrollPosition(rgba:ArrayLike<number>,width:number,height:number):number|null {
  return readScrollGeometry(rgba,width,height)?.position??null;
}
