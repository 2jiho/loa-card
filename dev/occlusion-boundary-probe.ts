/** Experimental frame-local evidence, not a tooltip verdict or card identity. */
export interface ProbeCell {readonly x:number;readonly y:number;readonly width:number;readonly height:number}
export interface RailCandidate {readonly x:number;readonly y:number;readonly width:number;readonly height:number;readonly cells:readonly number[];
  readonly leftDensity:number;readonly rightDensity:number;readonly interiorLight:number}
export interface RailProbeResult {readonly scope:'parallel-dark-rails';readonly canConcludeAbsence:false;readonly truncated:boolean;
  readonly candidates:readonly RailCandidate[];readonly samples:number}

/** Search the same immutable pixels as the supplied nominal grid. The probe
 * looks for two tall, dark side rails with texture between them, crossing
 * multiple columns and rows. Dark artwork can have the same geometry, so a
 * candidate never proves a tooltip, complete covered extent or card identity.
 * Null means unsupported, not clear. This is not wired to production. */
export function occlusionBoundaryProbe(rgba:ArrayLike<number>,width:number,height:number,cells:readonly ProbeCell[]):RailProbeResult|null {
 if(!(rgba instanceof Uint8Array)&&!(rgba instanceof Uint8ClampedArray)||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||
   width<1||height<1||width*height>8_000_000||rgba.length!==width*height*4||!Array.isArray(cells)||cells.length<4||cells.length>40)return null;
 const first=cells[0];if(!first||![first.width,first.height].every(Number.isSafeInteger)||first.width<70||first.height<105)return null;
 if(cells.some(c=>!c||![c.x,c.y,c.width,c.height].every(Number.isSafeInteger)||c.width!==first.width||c.height!==first.height||
   c.x<0||c.y<0||c.x+c.width>width||c.y+c.height>height))return null;
 for(let i=0;i<cells.length;i++)for(let j=i+1;j<cells.length;j++){
  const a=cells[i],b=cells[j];if(Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)&&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y))return null;
 }
 const left=Math.min(...cells.map(c=>c.x)),right=Math.max(...cells.map(c=>c.x+c.width));
 const top=Math.min(...cells.map(c=>c.y)),bottom=Math.max(...cells.map(c=>c.y+c.height));
 const xStep=Math.max(2,Math.round(first.width/35)),yStep=Math.max(2,Math.round(first.height/35));
 const windowHeight=Math.round(first.height*1.5),rowStep=Math.max(1,Math.round(first.height/4));
 const minRail=Math.max(2,Math.ceil(first.width*.08/xStep)),candidates:RailCandidate[]=[];let samples=0,truncated=false,invalid=false;
 const dark=(x:number,y:number)=>{const i=(y*width+x)*4;samples++;if(rgba[i+3]!==255){invalid=true;return false;}
  const r=rgba[i],g=rgba[i+1],b=rgba[i+2];return Math.max(r,g,b)<=42&&Math.max(r,g,b)-Math.min(r,g,b)<=18;};
 const light=(x:number,y:number)=>{const i=(y*width+x)*4;samples++;if(rgba[i+3]!==255){invalid=true;return false;}
  return Math.max(rgba[i],rgba[i+1],rgba[i+2])>=65;};
 for(let y=top;y+windowHeight<=bottom;y+=rowStep){
  const rails:{x:number;end:number;density:number}[]=[];let active:{x:number;end:number;density:number;count:number}|undefined;
  for(let x=left;x<right;x+=xStep){let sum=0,total=0;for(let yy=y;yy<y+windowHeight;yy+=yStep){sum+=Number(dark(x,yy));total++;}
   const density=sum/total;
   if(density>=.88){if(active){active.end=x+xStep;active.density+=density;active.count++;}else active={x,end:x+xStep,density,count:1};}
   else if(active){if(active.count>=minRail)rails.push({x:active.x,end:active.end,density:active.density/active.count});active=undefined;}
  }
  if(active&&active.count>=minRail)rails.push({x:active.x,end:active.end,density:active.density/active.count});
  // Normal card gutters are also tall dark strips. They are not evidence of
  // an overlay unless the rail crosses a card interior rather than a gutter.
  const crossesCardInterior=(rail:{x:number;end:number})=>{
   const center=(rail.x+rail.end)/2;
   return cells.some(cell=>center>=cell.x+first.width*.1&&center<=cell.x+cell.width-first.width*.1);
  };
  for(let a=0;a<rails.length;a++)for(let b=a+1;b<rails.length;b++){
   const l=rails[a],r=rails[b],gap=r.x-l.end;if(!crossesCardInterior(l)||!crossesCardInterior(r)||gap<first.width*1.25||gap>first.width*2.8)continue;
   const x=l.x,xEnd=r.end,overlap:number[]=[],rows=new Set<number>(),columns=new Set<number>();
   cells.forEach((cell,index)=>{const iw=Math.min(xEnd,cell.x+cell.width)-Math.max(x,cell.x),ih=Math.min(y+windowHeight,cell.y+cell.height)-Math.max(y,cell.y);
    if(iw>=first.width*.2&&ih>=first.height*.2){overlap.push(index);rows.add(cell.y);columns.add(cell.x);}});
   if(rows.size<2||columns.size<2)continue;
   let bright=0,total=0;const ixStep=Math.max(1,Math.round(first.width/10)),iyStep=Math.max(1,Math.round(first.height/12));
   for(let yy=y;yy<y+windowHeight;yy+=iyStep)for(let xx=l.end;xx<r.x;xx+=ixStep){bright+=Number(light(xx,yy));total++;}
   const interiorLight=bright/total;if(interiorLight<.12)continue;
   if(candidates.some(old=>Math.abs(old.x-x)<first.width*.2&&Math.abs(old.y-y)<rowStep*2&&Math.abs(old.width-(xEnd-x))<first.width*.3))continue;
   if(candidates.length>=64){truncated=true;break;}
   candidates.push({x,y,width:xEnd-x,height:windowHeight,cells:overlap,leftDensity:l.density,rightDensity:r.density,interiorLight});
  }
  if(truncated)break;
 }
 if(invalid)return null;
 return {scope:'parallel-dark-rails',canConcludeAbsence:false,truncated,candidates,samples};
}
