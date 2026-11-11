/** Diagnostic evidence only: a wide dark area overlapping at least two
 * incomplete card borders. It may be any overlay or dark artwork. In
 * particular it is not a tooltip, identity, or completion decision. */
export interface ObstructionCell { readonly x:number; readonly y:number; readonly width:number; readonly height:number; readonly intact:boolean }
export interface FrameObstructionCandidate { readonly x:number; readonly y:number; readonly width:number; readonly height:number; readonly cells:readonly number[]; readonly match:number }
export interface FrameObstructionResult {
  readonly scope:'wide-horizontal-dark-incomplete-only';
  readonly canConcludeAbsence:false;
  readonly supported:boolean;
  readonly unsupportedReason:'no-searchable-horizontal-pair'|null;
  readonly candidates:readonly FrameObstructionCandidate[];
  readonly representation:'overlap-suppressed-samples';
  readonly suppressedMatches:number;
  readonly truncated:boolean;
  readonly truncationReason:'window-limit'|'result-limit'|null;
}

/**
 * Call with pixels and cells from the SAME source frame. Nominal cells must
 * cover only the visible grid and have equal dimensions. At most 8 megapixels,
 * 40 cells, 20,000 search windows and 64 results are accepted; null means unsupported or invalid,
 * never 'no obstruction'. Sampled pixels must be opaque RGBA bytes; unsampled
 * pixels have not been validated. This only searches horizontal pairs with a
 * wide dark region: empty results cannot establish absence, even when search
 * finishes. Candidate rectangles describe evidence only, not the complete
 * affected region. Strongly overlapping windows with the same affected cell
 * indices and similar reference colors are represented by their first window;
 * this is lossy sampling, not proof that they are one physical panel. Even a
 * complete search cannot prove that two overlapping panels are the same or
 * different. Distinct visible regions remain separate when the windows do not
 * overlap or the cell sets differ. This expensive exploratory implementation is
 * intentionally not called by the production scanner.
 */
export function frameObstructionCandidates(rgba:ArrayLike<number>,width:number,height:number,cells:readonly ObstructionCell[]):FrameObstructionResult|null {
  if(!(rgba instanceof Uint8Array)&&!(rgba instanceof Uint8ClampedArray))return null;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>8_000_000||rgba.length!==width*height*4||
    !Array.isArray(cells)||cells.length<2||cells.length>40)return null;
  const first=cells[0];
  if(!first||![first.width,first.height].every(Number.isSafeInteger)||first.width<70||first.height<105)return null;
  if(cells.some(c=>!c||![c.x,c.y,c.width,c.height].every(Number.isSafeInteger)||typeof c.intact!=='boolean'||
    c.width!==first.width||c.height!==first.height||c.x<0||c.y<0||c.x+c.width>width||c.y+c.height>height))return null;
  for(let i=0;i<cells.length;i++)for(let j=i+1;j<cells.length;j++){
    const a=cells[i],b=cells[j];
    if(Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)&&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y))return null;
  }
  const left=Math.min(...cells.map(c=>c.x)),right=Math.max(...cells.map(c=>c.x+c.width));
  const top=Math.min(...cells.map(c=>c.y)),bottom=Math.max(...cells.map(c=>c.y+c.height));
  const boxWidth=first.width*2,boxHeight=Math.max(18,Math.round(first.height*36/210));
  const stepX=Math.max(1,Math.round(first.width*12/140)),stepY=Math.max(1,Math.round(first.height*8/210));
  const sampleX=Math.max(1,Math.round(first.width*4/140)),sampleY=Math.max(1,Math.round(first.height*4/210));
  const offsetX=Math.max(1,Math.round(first.width*12/140)),offsetY=Math.max(1,Math.round(first.height*8/210));
  const minimumX=first.width*30/140,minimumY=first.height*20/210;
  const candidates:FrameObstructionCandidate[]=[];const colors:Array<readonly [number,number,number]>=[];let windows=0,suppressedMatches=0;
  const result=(supported:boolean,reason:'window-limit'|'result-limit'|null):FrameObstructionResult=>({scope:'wide-horizontal-dark-incomplete-only',canConcludeAbsence:false,
    supported,unsupportedReason:supported?null:'no-searchable-horizontal-pair',candidates,representation:'overlap-suppressed-samples',suppressedMatches,truncated:reason!==null,truncationReason:reason});
  const hasPair=cells.some((a,i)=>cells.some((b,j)=>i<j&&
    Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>=minimumY&&
    Math.max(a.x,b.x)-Math.min(a.x+a.width,b.x+b.width)<=boxWidth-2*minimumX));
  if(!hasPair)return result(false,null);
  for(let y=top;y+boxHeight<=bottom;y+=stepY)for(let x=left;x+boxWidth<=right;x+=stepX){
    if(++windows>20_000)return result(true,'window-limit');
    const overlapping:number[]=[];
    for(let n=0;n<cells.length;n++){const c=cells[n];if(!c.intact&&Math.min(x+boxWidth,c.x+c.width)-Math.max(x,c.x)>=minimumX&&
      Math.min(y+boxHeight,c.y+c.height)-Math.max(y,c.y)>=minimumY)overlapping.push(n);}
    if(overlapping.length<2)continue;
    const idx=((y+offsetY)*width+x+offsetX)*4,r=rgba[idx],g=rgba[idx+1],b=rgba[idx+2];
    if(rgba[idx+3]!==255)return null;
    if(![r,g,b].every(Number.isFinite)||Math.max(r,g,b)>65||Math.min(r,g,b)<8||Math.max(r,g,b)-Math.min(r,g,b)>20)continue;
    let matching=0,total=0;
    for(let dy=0;dy<boxHeight;dy+=sampleY)for(let dx=0;dx<boxWidth;dx+=sampleX){const i=((y+dy)*width+x+dx)*4;
      if(rgba[i+3]!==255)return null;
      matching+=Number(Math.abs(rgba[i]-r)<=8&&Math.abs(rgba[i+1]-g)<=8&&Math.abs(rgba[i+2]-b)<=8);total++;}
    if(matching/total>=.85){
      const represented=candidates.some((old,index)=>old.cells.length===overlapping.length&&old.cells.every((value,i)=>value===overlapping[i])&&
        Math.abs(old.x-x)<=boxWidth*.15&&Math.abs(old.y-y)<=boxHeight*.2&&
        Math.abs(colors[index][0]-r)<=2&&Math.abs(colors[index][1]-g)<=2&&Math.abs(colors[index][2]-b)<=2);
      if(represented){suppressedMatches++;continue;}
      if(candidates.length===64)return result(true,'result-limit');
      candidates.push({x,y,width:boxWidth,height:boxHeight,cells:overlapping,match:matching/total});
      colors.push([r,g,b]);
    }
  }
  return result(true,null);
}
