/** Conservative tooltip panel evidence: a long neutral rule and a flat dark
 * panel immediately below it, inside the portrait rather than the card border.
 * A negative result does not rule out an overlay. In particular, a textured
 * cover over the counter can still be mistaken for a zero by the separate
 * counter reader; callers must not treat this detector as proof of visibility. */
export function hasPanelOverlay(rgba:ArrayLike<number>,width:number,height:number){
  if(width<70||height<105||rgba.length!==width*height*4)return false;
  const left=Math.ceil(width*.08),right=Math.floor(width*.92),length=right-left;
  const rgb=(x:number,y:number)=>{const i=(y*width+x)*4;return [rgba[i],rgba[i+1],rgba[i+2]];};
  for(let y=Math.ceil(height*.25);y<height*.64;y++){
    const base=rgb(left,y);if(Math.max(...base)-Math.min(...base)>25||base[0]<65||base[0]>200)continue;
    let rule=0,flat=0;
    const below=Math.min(height-1,y+Math.max(3,Math.round(height*.025)));
    const dark=rgb(left,below);if(Math.max(...dark)>65)continue;
    for(let x=left;x<right;x++){
      const p=rgb(x,y),q=rgb(x,below);
      if(p.every((v,c)=>Math.abs(v-base[c])<=7))rule++;
      if(q.every((v,c)=>Math.abs(v-dark[c])<=5))flat++;
    }
    if(rule/length>.94&&flat/length>.94)return true;
  }
  return false;
}

export interface LowerPanelCandidate {readonly startY:number;readonly endY:number;readonly color:readonly [number,number,number]}
export interface LowerPanelResult {readonly status:'invalid'|'unsupported'|'none'|'candidate';readonly reason:string|null;readonly scope:'lower-dark-band-only';readonly canConcludeAbsence:false;readonly candidate:LowerPanelCandidate|null}
export interface PanelEdgeResult {readonly status:'invalid'|'unsupported'|'none'|'crosses';readonly reason:string|null;readonly scope:'same-color-card-edge-only';readonly canConcludeAbsence:false}

export interface SidePanelResult {
  readonly status:'invalid'|'unsupported'|'none'|'candidate';
  readonly reason:string|null;
  readonly scope:'dark-side-band-with-textured-interior-only';
  readonly canConcludeAbsence:false;
  readonly candidate:{readonly side:'left'|'right';readonly match:number;readonly color:readonly [number,number,number]}|null;
}
/** Exploratory evidence only. The solid margin of an enlarged card tooltip
 * can cover one side of an underlying card even when no horizontal rule is
 * visible. Dark artwork, clipping, or other UI can look the same. A missing
 * candidate cannot establish that a card is unobstructed: for example the
 * enlarged portrait can occupy the entire crop. Never use this result to
 * classify an empty slot, establish identity, or allow automatic completion.
 * The frame/crop relationship and a newer clear observation remain separate
 * evidence. Work and memory are bounded; only sampled alpha is checked. */
export function sidePanelCandidate(rgba:ArrayLike<number>,width:number,height:number,sides:readonly number[]):SidePanelResult {
  const result=(status:SidePanelResult['status'],reason:string|null=null,candidate:SidePanelResult['candidate']=null):SidePanelResult=>
    ({status,reason,scope:'dark-side-band-with-textured-interior-only',canConcludeAbsence:false,candidate});
  if(!(rgba instanceof Uint8Array)&&!(rgba instanceof Uint8ClampedArray))return result('invalid','rgba-format');
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||rgba.length!==width*height*4||
    !Array.isArray(sides)||sides.length!==4||sides.some(value=>!Number.isFinite(value)||value<0||value>1))return result('invalid','dimensions-or-sides');
  if(width<70||height<105||width>1024||height>1024||width*height>1_000_000)return result('unsupported','crop-size');
  if(sides.every(value=>value>=.5))return result('unsupported','complete-border');
  const stepX=Math.max(1,Math.round(width/47)),stepY=Math.max(1,Math.round(height/70));
  const top=Math.floor(height*.17),bottom=Math.floor(height*.95);
  for(const side of ['left','right'] as const){
    const left=side==='left'?0:Math.floor(width*.71),right=side==='left'?Math.ceil(width*.29):width;
    const hist=[new Uint32Array(256),new Uint32Array(256),new Uint32Array(256)];let count=0;
    for(let y=top;y<bottom;y+=stepY)for(let x=left;x<right;x+=stepX){const i=(y*width+x)*4;
      if(rgba[i+3]!==255)return result('invalid','sampled-alpha');
      for(let c=0;c<3;c++)hist[c][rgba[i+c]]++;count++;
    }
    const median=hist.map(values=>{let n=0;for(let v=0;v<256;v++){n+=values[v];if(n>count/2)return v;}return 255;}) as [number,number,number];
    if(Math.max(...median)>65||Math.min(...median)<8||Math.max(...median)-Math.min(...median)>20)continue;
    let matches=0;
    for(let y=top;y<bottom;y+=stepY)for(let x=left;x<right;x+=stepX){const i=(y*width+x)*4;
      if(median.every((value,c)=>Math.abs(rgba[i+c]-value)<=8))matches++;
    }
    if(matches/count<.8)continue;
    // Require contrast on the opposite interior; a uniform dark card back or
    // blank pane does not establish even this narrow side-band evidence.
    const otherLeft=Math.floor(width*(side==='left'?.61:.18)),otherRight=Math.ceil(width*(side==='left'?.82:.39));
    let n=0,sum=0,sumSq=0;
    for(let y=top;y<bottom;y+=stepY)for(let x=otherLeft;x<otherRight;x+=stepX){const i=(y*width+x)*4;
      if(rgba[i+3]!==255)return result('invalid','sampled-alpha');
      const v=(rgba[i]+rgba[i+1]+rgba[i+2])/3;n++;sum+=v;sumSq+=v*v;
    }
    if(n&&Math.max(0,sumSq/n-(sum/n)**2)>=100)return result('candidate',null,{side,match:matches/count,color:median});
  }
  return result('none');
}
/** Experimental diagnostic only. A dark, nearly uniform lower band following
 * textured pixels can be a tooltip, but can also be artwork, clipping or UI.
 * This is not an identity, occlusion, empty-slot or scan-completion proof and
 * is not used by the production quality filter. Border scores are measured
 * upstream; a missing/invalid score is uncertainty, never positive evidence.
 * The 1M pixel / 1024-side cap bounds row evaluation to at most 9,216 rows
 * and 9,520,128 sampled pixels including reference picks. Only sampled alpha
 * is checked, not every pixel in the crop. */
export function lowerPanelCandidate(rgba:ArrayLike<number>,width:number,height:number,sides:readonly number[]):LowerPanelResult {
  const result=(status:LowerPanelResult['status'],reason:string|null=null,candidate:LowerPanelCandidate|null=null):LowerPanelResult=>({status,reason,scope:'lower-dark-band-only',canConcludeAbsence:false,candidate});
  if(!(rgba instanceof Uint8Array)&&!(rgba instanceof Uint8ClampedArray))return result('invalid','rgba-format');
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||rgba.length!==width*height*4||
    !Array.isArray(sides)||sides.length!==4||sides.some(value=>!Number.isFinite(value)||value<0||value>1))return result('invalid','dimensions-or-sides');
  // Bound the repeated row scans as well as the source size.
  if(width<70||height<105||width>1024||height>1024||width*height>1_000_000)return result('unsupported','crop-size');
  if(sides[2]<.85||Math.max(sides[0],sides[1])<.75||sides[3]>=.35)return result('unsupported','border-pattern');
  const left=Math.ceil(width*.09),right=Math.floor(width*.91),count=right-left;
  const first=Math.ceil(height*.59),last=Math.floor(height*.98),required=Math.max(12,Math.ceil(height*.07));
  let start=-1,reference:[number,number,number]|undefined,invalid=false;
  const row=(y:number)=>{
    const picks:number[][]=[[],[],[]];
    for(let j=0;j<9;j++){const x=left+Math.floor((count-1)*j/8),index=(y*width+x)*4;
      if(rgba[index+3]!==255)invalid=true;
      for(let c=0;c<3;c++)picks[c].push(rgba[index+c]);}
    const median=picks.map(values=>values.sort((a,b)=>a-b)[4]) as [number,number,number];
    const dark=Math.max(...median)<=65&&Math.min(...median)>=8&&Math.max(...median)-Math.min(...median)<=20;
    let matches=0,sum=0,sumSq=0;
    for(let x=left;x<right;x++){const i=(y*width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2],v=(r+g+b)/3;
      if(rgba[i+3]!==255)invalid=true;
      if(Math.abs(r-median[0])<=8&&Math.abs(g-median[1])<=8&&Math.abs(b-median[2])<=8)matches++;
      sum+=v;sumSq+=v*v;
    }
    return {median,flat:dark&&matches/count>=.86,variance:Math.max(0,sumSq/count-(sum/count)**2)};
  };
  for(let y=first;y<last;y++){
    const current=row(y),same=reference&&current.median.every((value,index)=>Math.abs(value-reference![index])<=8);
    if(invalid)return result('invalid','sampled-alpha');
    if(!current.flat||reference&&!same){start=-1;reference=undefined;continue;}
    if(start<0){start=y;reference=current.median;}
    if(y-start+1>=required){
      // A uniformly dark full card/back is not enough. Require textured
      // content immediately before the band; this is still only a candidate.
      let textured=false;
      for(let above=Math.max(first-12,start-8);above<start;above++)if(row(above).variance>=100){textured=true;break;}
      if(invalid)return result('invalid','sampled-alpha');
      if(textured)return result('candidate',null,{startY:start,endY:y+1,color:reference!});
    }
  }
  return result('none');
}

/** Additional experimental evidence from the *same* source raster: check if
 * the candidate's panel colour crosses one nominal card boundary. It does not
 * prove an adjacent card is present, a tooltip identity, or frame provenance;
 * callers must bind box/candidate to these actual pixels themselves. A frame
 * is capped at 8M pixels and a boundary comparison at 200,000 pixels; only
 * sampled alpha is checked. */
export function panelCrossesCardEdge(rgba:ArrayLike<number>,width:number,height:number,
  box:{x:number;y:number;width:number;height:number},candidate:LowerPanelCandidate,side:'left'|'right'):PanelEdgeResult {
  const result=(status:PanelEdgeResult['status'],reason:string|null=null):PanelEdgeResult=>({status,reason,scope:'same-color-card-edge-only',canConcludeAbsence:false});
  if(!(rgba instanceof Uint8Array)&&!(rgba instanceof Uint8ClampedArray))return result('invalid','rgba-format');
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||rgba.length!==width*height*4||
    !box||![box.x,box.y,box.width,box.height].every(Number.isSafeInteger)||box.width<1||box.height<1||
    box.x<0||box.y<0||box.x+box.width>width||box.y+box.height>height||
    !candidate||!Array.isArray(candidate.color)||candidate.color.length!==3||candidate.color.some(v=>!Number.isFinite(v)||v<0||v>255)||
    !Number.isSafeInteger(candidate.startY)||!Number.isSafeInteger(candidate.endY)||candidate.startY<0||
    candidate.endY>box.height||candidate.endY-candidate.startY<12||!['left','right'].includes(side))return result('invalid','geometry-or-candidate');
  if(width*height>8_000_000||box.width<70||box.height<105||box.width>1024||box.height>1024||box.width*box.height>1_000_000)return result('unsupported','image-or-card-size');
  const edge=side==='left'?box.x:box.x+box.width,half=Math.max(3,Math.round(box.width*.03));
  const x0=edge-half,x1=edge+half,y0=box.y+candidate.startY,y1=box.y+candidate.endY;
  if(x0<0||x1>width||y0<0||y1>height)return result('unsupported','edge-outside-frame');
  if((x1-x0)*(y1-y0)>200_000)return result('unsupported','work-limit');
  let inside=0,outside=0,perSide=0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const i=(y*width+x)*4;if(rgba[i+3]!==255)return result('invalid','sampled-alpha');
    const match=candidate.color.every((v,c)=>Math.abs(rgba[i+c]-v)<=12);
    const inCard=side==='left'?x>=edge:x<edge;
    if(inCard)inside+=Number(match);else outside+=Number(match);
    if(x<edge)perSide++;
  }
  return result(perSide>0&&inside/perSide>=.8&&outside/perSide>=.8?'crosses':'none');
}
