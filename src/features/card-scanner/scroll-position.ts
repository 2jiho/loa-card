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
    for(let y=20;y<height-24;y++) {
      const contrast=levels[y]-Math.max(levels[y-3],levels[y+3]);
      if(levels[y]<45||contrast<12)continue;
      const previous=peaks.at(-1);
      if(previous&&y-previous.y<=4){if(contrast>previous.contrast){previous.y=y;previous.contrast=contrast;}}
      else peaks.push({y,contrast});
    }
    if(peaks.length!==2)return readPartialThumb(rgba,width,height);
    const [top,bottom]=peaks.map(p=>p.y);
    const outside=(levels[top-5]+levels[bottom+5])/2;
    let filled=0;
    for(let y=top+4;y<bottom-4;y++)if(levels[y]>outside+6)filled++;
    if(filled<Math.max(1,bottom-top-8)*.8)return readPartialThumb(rgba,width,height);
    edges.splice(0,edges.length,top,bottom);
  }
  // The lower arrow starts 24px before the crop end; the track ends two
  // pixels before it. Including its border biased positions and page spans.
  const thumb = edges[1] - edges[0], track = height - 46;
  if (thumb < height * .04 || thumb > height * .3) return null;
  return {position:Math.max(0, Math.min(1, (edges[0] - 20) / (track - thumb))),pageSpan:thumb/(track-thumb)};
}

/** Column votes ignore a cursor covering part of a horizontal edge. A pair
 * still needs a filled thumb body and agreement from independent columns. */
function readPartialThumb(rgba:ArrayLike<number>,width:number,height:number):{position:number;pageSpan:number}|null {
  const pairs:{top:number;bottom:number;columns:Set<number>}[]=[];
  for(let x=Math.floor(width*.125);x<Math.ceil(width*.69);x++) {
    const level=(y:number)=>{const i=(y*width+x)*4;return (rgba[i]+rgba[i+1]+rgba[i+2])/3;};
    const masked=(y:number)=>{const i=(y*width+x)*4;return Math.max(rgba[i],rgba[i+1],rgba[i+2])-Math.min(rgba[i],rgba[i+1],rgba[i+2])>60;};
    const peaks:{y:number;contrast:number}[]=[];
    for(let y=20;y<height-24;y++) {
      const contrast=level(y)-Math.max(level(y-3),level(y+3));
      if(masked(y)||level(y)<45||contrast<12)continue;
      const last=peaks.at(-1);
      if(last&&y-last.y<=4){if(contrast>last.contrast){last.y=y;last.contrast=contrast;}}
      else peaks.push({y,contrast});
    }
    if(peaks.length>32)continue;
    for(let a=0;a<peaks.length;a++)for(let b=a+1;b<peaks.length;b++) {
      const top=peaks[a].y,bottom=peaks[b].y,span=bottom-top;
      if(span<height*.04||span>height*.3)continue;
      const outside=(level(top-5)+level(bottom+5))/2;let visible=0,filled=0;
      for(let y=top+4;y<bottom-4;y++)if(!masked(y)){visible++;if(level(y)>outside+6)filled++;}
      if(visible<(span-8)*.5||filled<visible*.8)continue;
      const pair=pairs.find(p=>Math.abs(p.top-top)<=2&&Math.abs(p.bottom-bottom)<=2);
      if(pair)pair.columns.add(x);else pairs.push({top,bottom,columns:new Set([x])});
    }
  }
  const candidates=pairs.filter(p=>p.columns.size>=Math.max(3,Math.ceil(width*.2)));
  if(candidates.length!==1)return null;
  const {top,bottom}=candidates[0],thumb=bottom-top,travel=height-46-thumb;
  return {position:Math.max(0,Math.min(1,(top-20)/travel)),pageSpan:thumb/travel};
}

export function readScrollPosition(rgba:ArrayLike<number>,width:number,height:number):number|null {
  return readScrollGeometry(rgba,width,height)?.position??null;
}
