import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {readScrollGeometry} from '../src/features/card-scanner/session/scroll-position';
import {openRecordedShareStream} from './recorded-share-frames';
import {fitLine,parabolaPeak,summarize} from './grid-fit-math';

/** Development measurement (docs/card-image-structure.md, "측정 도구"). Not a scanner.
 *
 * Finds where each card's border really is on screen from the SHAPE of the border, not its
 * colour: the outer contour of the client's border sprite (crest, corners and sides) is laid
 * over each grid cell, and the place where the most of it has the dark gap between cards just
 * outside it is taken, to a fraction of a pixel. All visible cards of a frame then give one grid: a first
 * column, a first row and the two pitches. The scanner's own per-card alignment looks at
 * brightness along straight edges only and decides each card on its own.
 *
 * The output is numbers about the grid (pitch, origin, how much they move from frame to
 * frame, how far the scanner's current grid is from them). Nothing here crops or reads a card.
 * The border sprites are private client extracts under work/ (served by the dev server only). */
const WIDTH=140,HEIGHT=210,SEARCH=4,MARGIN=SEARCH+3;
export interface GridFitResult {
  readonly frames:number;readonly sampledFrames:number;readonly cellsMeasured:number;readonly cellsWeak:number;
  /** How far each grade's border sprite sits from grade 2's, by outline (pixels). */
  readonly spriteOffsets:readonly {readonly grade:number;readonly dx:number;readonly dy:number}[];
  /** Per sampled frame: the fitted grid and how far the cells are from it (root mean square, pixels). */
  readonly perFrame:readonly {readonly time:number;readonly cells:number;readonly x0:number;readonly columnStep:number;readonly y0:number;readonly rowStep:number;readonly residual:number}[];
  /** Over the sampled frames: mean and standard deviation of each grid value. */
  readonly grid:{readonly x0:{mean:number;sd:number};readonly columnStep:{mean:number;sd:number};readonly y0:{mean:number;sd:number};readonly rowStep:{mean:number;sd:number};
    readonly residual:{mean:number;sd:number}};
  /** Per column and row: where the border is on average, how much that moves between frames,
   * and how far the scanner's current grid cell is from it (cell minus border). */
  readonly columns:readonly {readonly index:number;readonly border:number;readonly sd:number;readonly cell:number;readonly cellMinusBorder:number}[];
  readonly rows:readonly {readonly index:number;readonly border:number;readonly sd:number;readonly cell:number;readonly cellMinusBorder:number}[];
  /** The crop the scanner actually took (after its per-card alignment) minus the border, per axis. */
  readonly cropMinusBorder:{readonly x:{mean:number;sd:number};readonly y:{mean:number;sd:number}};
}

async function spriteAlpha(url:string):Promise<Float32Array> {
  const response=await fetch(url);
  if(!response.ok)throw Error(`테두리 기준 이미지를 열 수 없습니다: ${url}`);
  const bitmap=await createImageBitmap(await response.blob());
  if(bitmap.width!==WIDTH||bitmap.height!==HEIGHT)throw Error(`테두리 기준 이미지 크기가 ${WIDTH}×${HEIGHT}가 아닙니다: ${url}`);
  const canvas=Object.assign(document.createElement('canvas'),{width:WIDTH,height:HEIGHT}),context=canvas.getContext('2d',{willReadFrequently:true})!;
  context.drawImage(bitmap,0,0);bitmap.close();
  const data=context.getImageData(0,0,WIDTH,HEIGHT).data;
  return Float32Array.from({length:WIDTH*HEIGHT},(_,index)=>data[index*4+3]/255);
}
/** A point on the border's OUTER contour and the direction that leaves the card there. */
interface ContourPoint {readonly x:number;readonly y:number;readonly nx:number;readonly ny:number}
/** The outer contour of a border sprite: opaque pixels next to the transparent outside (the
 * part of the transparency connected to the sprite's edge, so the hole in the middle is not it). */
function outerContour(alpha:Float32Array):ContourPoint[] {
  const outside=new Uint8Array(WIDTH*HEIGHT),stack:number[]=[];
  const visit=(x:number,y:number)=>{
    if(x<0||y<0||x>=WIDTH||y>=HEIGHT)return;
    const index=y*WIDTH+x;
    if(outside[index]||alpha[index]>=.5)return;
    outside[index]=1;stack.push(index);
  };
  for(let x=0;x<WIDTH;x++){visit(x,0);visit(x,HEIGHT-1);}
  for(let y=0;y<HEIGHT;y++){visit(0,y);visit(WIDTH-1,y);}
  while(stack.length){const index=stack.pop()!,x=index%WIDTH,y=Math.floor(index/WIDTH);visit(x+1,y);visit(x-1,y);visit(x,y+1);visit(x,y-1);}
  const isOutside=(x:number,y:number)=>x<0||y<0||x>=WIDTH||y>=HEIGHT||outside[y*WIDTH+x]===1;
  const points:ContourPoint[]=[];
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++){
    if(alpha[y*WIDTH+x]<.5)continue;
    for(const [nx,ny] of [[1,0],[-1,0],[0,1],[0,-1]] as const)if(isOutside(x+nx,y+ny))points.push({x,y,nx,ny});
  }
  return points;
}
/** How well the contour sits at (ox,oy) of a brightness picture: the border is brighter than the
 * dark gap just outside it. Each point adds its inside-minus-outside brightness, capped so that
 * one bright spot cannot stand in for a missing edge. */
function agreement(contour:readonly ContourPoint[],luma:Float32Array,width:number,ox:number,oy:number):number {
  let total=0;
  for(const point of contour){
    const x=point.x+ox,y=point.y+oy;
    const contrast=luma[y*width+x]-luma[(y+point.ny*2)*width+x+point.nx*2];
    total+=Math.min(.2,Math.max(0,contrast));
  }
  return total;
}
/** Best place of the contour in a picture whose own origin is `MARGIN` inside it, to a fraction of a pixel. */
function locate(contour:readonly ContourPoint[],luma:Float32Array,width:number):{dx:number;dy:number;sharpness:number} {
  const side=SEARCH*2+1,scores=new Float32Array(side*side);
  let best=0;
  for(let dy=-SEARCH;dy<=SEARCH;dy++)for(let dx=-SEARCH;dx<=SEARCH;dx++){
    const at=(dy+SEARCH)*side+dx+SEARCH;
    scores[at]=agreement(contour,luma,width,MARGIN+dx,MARGIN+dy);
    if(scores[at]>scores[best])best=at;
  }
  const bx=best%side,by=Math.floor(best/side);
  const score=(x:number,y:number)=>x<0||y<0||x>=side||y>=side?null:scores[y*side+x];
  // The share of the contour that found an edge at all (each point can add at most 0.2).
  return {dx:bx-SEARCH+parabolaPeak(score(bx-1,by),scores[best],score(bx+1,by)),dy:by-SEARCH+parabolaPeak(score(bx,by-1),scores[best],score(bx,by+1)),
    sharpness:contour.length?scores[best]/(contour.length*.2):0};
}

export async function runGridFit(options:{recordingId:string;signal:AbortSignal;maxFrames?:number;onProgress?:(text:string)=>void}):Promise<GridFitResult> {
  const {recordingId,signal}=options,maxFrames=options.maxFrames??40;
  // The outline: where the alpha of the border sprites changes. The sprites of the five grades
  // have one shape but were cut a pixel apart; they are first laid on grade 2 by their outlines.
  const alphas=await Promise.all([0,1,2,3,4].map(grade=>spriteAlpha(`/work/composed-card-templates/borders/border-${grade}.png`)));
  const contours=alphas.map(outerContour);
  // The sprites of the five grades have one shape but were cut a pixel apart: each is laid on
  // grade 2 by counting contour points that land on grade 2's contour.
  const key=(x:number,y:number)=>y*1000+x;
  const referencePoints=new Set(contours[2].map(point=>key(point.x,point.y)));
  const spriteOffsets=contours.map((contour,grade)=>{
    let best={dx:0,dy:0,score:-1};
    for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){
      let score=0;
      for(const point of contour)if(referencePoints.has(key(point.x-dx,point.y-dy)))score++;
      if(score>best.score)best={dx,dy,score};
    }
    return {grade,dx:best.dx,dy:best.dy};
  });
  // Grade 2's contour is the one used; the others only say how far their sprite is from it.
  const outline=contours[2];
  const stream=await openRecordedShareStream({recordingId,signal});
  const acquisition=createAcquisitionClient(signal);
  const strip=Object.assign(document.createElement('canvas'),{width:16,height:942}),stripContext=strip.getContext('2d',{willReadFrequently:true})!;
  const patch=Object.assign(document.createElement('canvas'),{width:WIDTH+MARGIN*2,height:HEIGHT+MARGIN*2}),patchContext=patch.getContext('2d',{willReadFrequently:true})!;
  try{
    await acquisition.ready();
    const seen=new Set<number>();
    const perFrame:GridFitResult['perFrame'][number][]=[];
    const columnBorders=Array.from({length:10},()=>[] as number[]),rowBorders=Array.from({length:4},()=>[] as number[]);
    const columnCells=Array<number>(10).fill(0),rowCells=Array<number>(4).fill(0);
    const cropX:number[]=[],cropY:number[]=[];
    let frames=0,sampledFrames=0,cellsMeasured=0,cellsWeak=0;
    for await(const frame of stream.frames()){
      signal.throwIfAborted();frames++;
      if(sampledFrames>=maxFrames)continue;
      const acquired=await acquisition.detectAndAcquire(frame.element,frame.time);
      const release=()=>{for(const cell of acquired.cells)if(cell.image)cell.image.width=0;};
      if(!acquired.layout||acquired.cells.length!==40){release();continue;}
      const bar=acquired.layout.scrollbar;
      stripContext.drawImage(frame.element,bar.x,bar.y,bar.width,bar.height,0,0,16,942);
      const position=readScrollGeometry(stripContext.getImageData(0,0,16,942).data,16,942)?.position??null;
      const step=position===null?null:Math.round(position*51);
      if(step===null||seen.has(step)||acquired.cells.filter(cell=>cell.quality.usable&&cell.image).length<30){release();continue;}
      seen.add(step);sampledFrames++;
      const xs:{index:number;value:number}[]=[],ys:{index:number;value:number}[]=[];
      const found:{slot:number;x:number;y:number}[]=[];
      acquired.cells.forEach((cell,slot)=>{
        if(!cell.quality.usable||!cell.image)return;
        const box=acquired.layout!.cells[slot];
        if(!Number.isInteger(box.x)||!Number.isInteger(box.y)||box.width!==WIDTH||box.height!==HEIGHT)return;
        if(box.x<MARGIN||box.y<MARGIN||box.x+WIDTH+MARGIN>frame.element.width||box.y+HEIGHT+MARGIN>frame.element.height)return;
        patchContext.drawImage(frame.element,box.x-MARGIN,box.y-MARGIN,patch.width,patch.height,0,0,patch.width,patch.height);
        const data=patchContext.getImageData(0,0,patch.width,patch.height).data;
        const luma=Float32Array.from({length:patch.width*patch.height},(_,index)=>(.299*data[index*4]+.587*data[index*4+1]+.114*data[index*4+2])/255);
        const place=locate(outline,luma,patch.width);
        cellsMeasured++;
        if(place.sharpness<.5||Math.abs(place.dx)>=SEARCH||Math.abs(place.dy)>=SEARCH){cellsWeak++;return;}
        const x=box.x+place.dx,y=box.y+place.dy;
        found.push({slot,x,y});
        cropX.push(cell.content.x-x);cropY.push(cell.content.y-y);
      });
      release();
      if(found.length<12)continue;
      for(const item of found){xs.push({index:item.slot%10,value:item.x});ys.push({index:Math.floor(item.slot/10),value:item.y});}
      const column=fitLine(xs),row=fitLine(ys);
      const residual=Math.sqrt(found.reduce((total,item)=>total+(item.x-(column.origin+column.step*(item.slot%10)))**2+(item.y-(row.origin+row.step*Math.floor(item.slot/10)))**2,0)/found.length);
      perFrame.push({time:frame.time,cells:found.length,x0:column.origin,columnStep:column.step,y0:row.origin,rowStep:row.step,residual});
      // Per column and row: this frame's mean border position.
      for(let index=0;index<10;index++){const own=found.filter(item=>item.slot%10===index);if(own.length)columnBorders[index].push(own.reduce((t,item)=>t+item.x,0)/own.length);columnCells[index]=acquired.layout.cells[index].x;}
      for(let index=0;index<4;index++){const own=found.filter(item=>Math.floor(item.slot/10)===index);if(own.length)rowBorders[index].push(own.reduce((t,item)=>t+item.y,0)/own.length);rowCells[index]=acquired.layout.cells[index*10].y;}
      options.onProgress?.(`격자 맞춤 측정 · ${frames}/${stream.frameCount}프레임 · 표본 ${sampledFrames}장면`);
    }
    const round=(value:number,digits=3)=>Math.round(value*10**digits)/10**digits;
    const stat=(values:readonly number[])=>{const s=summarize(values);return {mean:round(s.mean),sd:round(s.sd)};};
    const axis=(borders:number[][],cells:number[])=>borders.map((values,index)=>{const s=summarize(values);return {index,border:round(s.mean,2),sd:round(s.sd,2),cell:cells[index],cellMinusBorder:round(cells[index]-s.mean,2)};});
    return {frames,sampledFrames,cellsMeasured,cellsWeak,spriteOffsets,
      perFrame:perFrame.map(item=>({time:round(item.time),cells:item.cells,x0:round(item.x0),columnStep:round(item.columnStep,4),y0:round(item.y0),rowStep:round(item.rowStep,4),residual:round(item.residual)})),
      grid:{x0:stat(perFrame.map(item=>item.x0)),columnStep:stat(perFrame.map(item=>item.columnStep)),y0:stat(perFrame.map(item=>item.y0)),rowStep:stat(perFrame.map(item=>item.rowStep)),
        residual:stat(perFrame.map(item=>item.residual))},
      columns:axis(columnBorders,columnCells),rows:axis(rowBorders,rowCells),cropMinusBorder:{x:stat(cropX),y:stat(cropY)}};
  }finally{acquisition.dispose();}
}
