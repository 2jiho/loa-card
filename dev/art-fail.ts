import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {areaGray} from '../src/features/card-scanner/acquisition/area-gray';
import {createPortraitMatcher} from '../src/features/card-scanner/recognition/portrait-matcher';
import type {PortraitMatchDiagnostic} from '../src/features/card-scanner/recognition/portrait-matcher';
import {loadPortraitCompetitors} from '../src/features/card-scanner/recognition/portrait-competitors';
import type {Reference} from '../src/features/card-scanner/recognition/reference-types';
import {readScrollGeometry} from '../src/features/card-scanner/session/scroll-position';
import {openRecordedShareStream} from './recorded-share-frames';

/** Development measurement (measurement notes: fixtures/local/notes/, kept with the private recordings). Not a scanner.
 *
 * Runs the scanner's own artwork matcher, with its diagnostics on, over the usable crops of a
 * recording (one frame per scroll position) and keeps the numbers of the crops it does NOT
 * accept: which card came first and second, how well each of the two picture bands matched,
 * the gap to the runner-up, and which of the acceptance checks failed. It decides nothing. */
export interface ArtFailResult {
  readonly frames:number;readonly sampledFrames:number;readonly crops:number;readonly accepted:number;
  /** Rejected crops grouped by the card that ranked first. */
  readonly rejected:readonly {readonly first:string;readonly crops:number;readonly second:string;
    /** Medians over the group's crops, from the stage that came closest (highest correlation). */
    readonly upper:number;readonly lower:number;readonly correlation:number;readonly margin:number;
    /** Which acceptance checks failed, and in how many crops. */
    readonly failed:Readonly<Record<string,number>>;readonly reasons:Readonly<Record<string,number>>;
    /** Grades of the first and second card, and the grade read from the crop's border colour (crops per grade). */
    readonly firstGrade:number|null;readonly secondGrade:number|null;readonly borderGrade:Readonly<Record<string,number>>}[];
  /** The border colour as a grade reading, checked on the accepted crops: centres learnt from
   * every other accepted crop, the rest classified. `confusion[card grade][read grade]` = crops. */
  /** Border colour of every 140x210 crop, for checks outside this run: accepted crops as
   * [card grade, r, g, b, upper r, g, b], rejected ones as [first card grade, second card grade,
   * r, g, b, correlation, margin, upper r, g, b]. "Upper" is the border above row 70 only. */
  readonly features:{readonly borderPixels:number;readonly upperBorderPixels:number;readonly accepted:readonly (readonly number[])[];readonly rejected:readonly (readonly number[])[]};
  /** Artwork colour against colour references made from the composed card pictures (private,
   * work/composed-card-templates/normal): the two artwork bands, rows 9-18 and columns 2-21 of
   * the 24x32 card grid, for every 140x210 crop whose two leading cards both have a picture. Rows: [list row, column, first card id, second card id,
   * gray correlation, gray margin, colour correlation with first, with second, chroma distance to
   * first, to second, 0 (unused), accepted by the matcher (0/1),
   * colour correlation with first and with second over rows 9-15 only (clear of the "equipped" banner)]. */
  readonly colour:readonly (readonly number[])[];
  /** One crop per rejected group and per accepted card whose border reads another grade than its
   * card's (PNG data URLs, for a person to look at). */
  readonly samples:Readonly<Record<string,string>>;
  readonly borderGrade:{readonly learnt:number;readonly tested:number;readonly correct:number;readonly confusion:readonly (readonly number[])[];
    readonly centres:readonly (readonly [number,number,number]|null)[]};
}

/** Pixels that are solid border in the client's border sprite together with all eight
 * neighbours, so that a crop one pixel off still reads border there; the rows the "equipped"
 * banner covers are left out. */
async function borderPixels():Promise<Int32Array> {
  const response=await fetch('/work/composed-card-templates/borders/border-2.png');
  if(!response.ok)throw Error('테두리 기준 이미지를 열 수 없습니다.');
  const bitmap=await createImageBitmap(await response.blob());
  const canvas=Object.assign(document.createElement('canvas'),{width:140,height:210}),context=canvas.getContext('2d',{willReadFrequently:true})!;
  context.drawImage(bitmap,0,0);bitmap.close();
  const data=context.getImageData(0,0,140,210).data,solid=(x:number,y:number)=>x>=0&&y>=0&&x<140&&y<210&&data[(y*140+x)*4+3]>=250;
  const out:number[]=[];
  for(let y=1;y<209;y++){
    if(y>=97&&y<=141)continue;
    for(let x=1;x<139;x++){
      let inside=true;
      for(let dy=-1;dy<=1&&inside;dy++)for(let dx=-1;dx<=1&&inside;dx++)inside=solid(x+dx,y+dy);
      if(inside)out.push(y*140+x);
    }
  }
  return Int32Array.from(out);
}
/** Mean colour of those border pixels in a 140x210 crop. */
function borderColour(data:Uint8ClampedArray,pixels:Int32Array):[number,number,number] {
  let r=0,g=0,b=0;
  for(const index of pixels){r+=data[index*4];g+=data[index*4+1];b+=data[index*4+2];}
  return [r/pixels.length,g/pixels.length,b/pixels.length];
}
/** Mean RGB of each cell of the 24x32 card grid of a 140x210 crop. */
function colourGrid(data:Uint8ClampedArray):Float32Array {
  const grid=new Float32Array(24*32*3);
  for(let gy=0;gy<32;gy++)for(let gx=0;gx<24;gx++){
    const x0=Math.floor(gx*140/24),x1=Math.floor((gx+1)*140/24),y0=Math.floor(gy*210/32),y1=Math.floor((gy+1)*210/32);
    let r=0,g=0,b=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const at=(y*140+x)*4;r+=data[at];g+=data[at+1];b+=data[at+2];}
    const n=(x1-x0)*(y1-y0),at=(gy*24+gx)*3;grid[at]=r/n;grid[at+1]=g/n;grid[at+2]=b/n;
  }
  return grid;
}
/** The crop's artwork rows 9-18 against a reference's, over the nine one-cell shifts: the best
 * correlation of the 540 colour values (one mean removed, so a colour cast counts) and the
 * smallest mean distance between the cells' colour shares (brightness removed). */
function colourScore(grid:Float32Array,reference:Float32Array,rows=10):{correlation:number;chroma:number} {
  let correlation=-1,chroma=Infinity;
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    let sq=0,sr=0,qq=0,rr=0,qr=0,distance=0;
    const pairs:number[]=[];
    for(let row=0;row<rows;row++)for(let column=0;column<20;column++){
      const q=((9+row+dy)*24+2+column+dx)*3,r=((9+row)*24+2+column)*3;
      const qs=grid[q]+grid[q+1]+grid[q+2]+1,rs=reference[r]+reference[r+1]+reference[r+2]+1;
      distance+=Math.abs(grid[q]/qs-reference[r]/rs)+Math.abs(grid[q+1]/qs-reference[r+1]/rs)+Math.abs(grid[q+2]/qs-reference[r+2]/rs);
      for(let channel=0;channel<3;channel++){pairs.push(grid[q+channel],reference[r+channel]);sq+=grid[q+channel];sr+=reference[r+channel];}
    }
    const mq=sq/(rows*60),mr=sr/(rows*60);
    for(let index=0;index<pairs.length;index+=2){const a=pairs[index]-mq,b=pairs[index+1]-mr;qq+=a*a;rr+=b*b;qr+=a*b;}
    if(qq>1e-6&&rr>1e-6)correlation=Math.max(correlation,qr/Math.sqrt(qq*rr));
    chroma=Math.min(chroma,distance/(rows*20));
  }
  return {correlation:Math.round(correlation*1000)/1000,chroma:Math.round(chroma*10000)/10000};
}
const median=(values:readonly number[])=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?Math.round(sorted[Math.floor((sorted.length-1)/2)]*1000)/1000:0;};

export async function runArtFail(options:{recordingId:string;signal:AbortSignal;maxFrames?:number;onProgress?:(text:string)=>void}):Promise<ArtFailResult> {
  const {recordingId,signal}=options,maxFrames=options.maxFrames??60;
  const base=new URL(import.meta.env.BASE_URL,location.href).href;
  const load=async(name:string)=>{const response=await fetch(`${base}scanner/${name}`);if(!response.ok)throw Error(`자료 로드 실패: ${name}`);return response.json();};
  const [catalog,atlas,screen,competitors]=await Promise.all([load('cards.json'),load('artwork-details.json'),load('screen-artwork-details.json'),loadPortraitCompetitors(base)]);
  const cards=catalog.cards as Reference[],name=new Map(cards.map(card=>[card.id,card.name]));
  const match=createPortraitMatcher(cards,atlas,screen.cards,{competitors});
  const colourReferences=new Map<string,Promise<Float32Array|null>>();
  const reader=Object.assign(document.createElement('canvas'),{width:140,height:210}),readerContext=reader.getContext('2d',{willReadFrequently:true})!;
  const colourReference=(id:string)=>colourReferences.get(id)??colourReferences.set(id,(async()=>{
    const response=await fetch(`/work/composed-card-templates/normal/${id}.png`);
    if(!response.ok||!(response.headers.get('content-type')??'').startsWith('image/'))return null;
    const bitmap=await createImageBitmap(await response.blob());
    if(bitmap.width!==140||bitmap.height!==210){bitmap.close();return null;}
    readerContext.clearRect(0,0,140,210);readerContext.drawImage(bitmap,0,0);bitmap.close();
    return colourGrid(readerContext.getImageData(0,0,140,210).data);
  })()).get(id)!;
  const colourRows:number[][]=[];
  const ring=await borderPixels();
  // The upper part of the border only: the "equipped" banner and the glow of gold jewels colour
  // the border around and below them.
  const upperRing=ring.filter(index=>Math.floor(index/140)<70);
  const featureAccepted:number[][]=[],featureRejected:number[][]=[];
  const stream=await openRecordedShareStream({recordingId,signal});
  const acquisition=createAcquisitionClient(signal);
  const strip=Object.assign(document.createElement('canvas'),{width:16,height:942}),stripContext=strip.getContext('2d',{willReadFrequently:true})!;
  try{
    await acquisition.ready();
    const seen=new Set<number>();
    const groups=new Map<string,{second:Map<string,number>;upper:number[];lower:number[];correlation:number[];margin:number[];failed:Record<string,number>;reasons:Record<string,number>}>();
    let frames=0,sampledFrames=0,crops=0,accepted=0;
    const grade=new Map(cards.map(card=>[card.id,card.rarity]));
    const acceptedColours:{grade:number;colour:[number,number,number];name:string;png:()=>string}[]=[];
    const samples:Record<string,string>={};
    const rejectedColours=new Map<string,[number,number,number][]>(),firstIds=new Map<string,{first:string;second:string|null}>();
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
      for(const [slot,cell] of acquired.cells.entries()){
        if(!cell.quality.usable||!cell.image)continue;
        const {width,height}=cell.image;
        const data=cell.image.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,width,height).data;
        let diagnostic:PortraitMatchDiagnostic|undefined;
        const result=match(areaGray(data,width,height),undefined,value=>{diagnostic=value;});
        crops++;
        if(width!==140||height!==210){if(result)accepted++;continue;}
        const colour=borderColour(data,ring),rounded=colour.map(value=>Math.round(value*10)/10);
        // Colour of the artwork against the two leading cards' colour references.
        const colourRow=async(firstId:string,secondId:string|undefined,correlation:number,margin:number,resolved:string|null,wasAccepted:boolean)=>{
          const a=await colourReference(firstId),b=secondId?await colourReference(secondId):null;
          if(!a||!b||!secondId)return;
          const grid=colourGrid(data),first=colourScore(grid,a),second=colourScore(grid,b);
          colourRows.push([step+Math.floor(slot/10),slot%10,Number(firstId),Number(secondId),Math.round(correlation*1000)/1000,Math.round(margin*1000)/1000,
            first.correlation,second.correlation,first.chroma,second.chroma,resolved?Number(resolved):0,wasAccepted?1:0,
            // Rows 9-15 only: the part the "equipped" banner never covers.
            colourScore(grid,a,7).correlation,colourScore(grid,b,7).correlation]);
        };
        const image=cell.image;
        const png=image.toDataURL('image/png');
        if(result){
          const stage=diagnostic?.stages.find(item=>item.candidates[0]?.id===result.card.id);
          if(stage)await colourRow(result.card.id,stage.candidates[1]?.id,stage.candidates[0].correlation,stage.candidates[0].margin,null,true);
          accepted++;acceptedColours.push({grade:result.card.rarity,colour,name:result.card.name,png:()=>png});featureAccepted.push([result.card.rarity,...rounded,...borderColour(data,upperRing).map(value=>Math.round(value*10)/10)]);continue;}
        if(!diagnostic?.stages.length)continue;
        // The stage that came closest.
        const stage=[...diagnostic.stages].sort((a,b)=>(b.candidates[0]?.correlation??-1)-(a.candidates[0]?.correlation??-1))[0];
        const [first,second]=stage.candidates;
        if(!first)continue;
        const key=name.get(first.id)??first.id;
        let group=groups.get(key);
        if(!group){group={second:new Map(),upper:[],lower:[],correlation:[],margin:[],failed:{},reasons:{}};groups.set(key,group);}
        (rejectedColours.get(key)??rejectedColours.set(key,[]).get(key)!).push(colour);
        featureRejected.push([grade.get(first.id)??-1,second?grade.get(second.id)??-1:-1,...rounded,first.correlation,first.margin,...borderColour(data,upperRing).map(value=>Math.round(value*10)/10)]);
        if(!firstIds.has(key))firstIds.set(key,{first:first.id,second:second?.id??null});
        if(Object.keys(samples).filter(label=>label.startsWith(`rejected ${key} `)).length<3)samples[`rejected ${key} ${Object.keys(samples).length}`]=png;
        {
          await colourRow(first.id,second?.id,first.correlation,first.margin,null,false);
          // One crop per list cell of a same-grade pair, for a person to read the name from.
          if(second&&grade.get(first.id)===grade.get(second.id)&&first.margin<.2&&first.correlation>=.94){
            const label=`cell ${key} r${step+Math.floor(slot/10)}c${slot%10}`;
            if(!(label in samples)&&Object.keys(samples).filter(item=>item.startsWith('cell ')).length<16)samples[label]=png;
          }
        }
        const runnerUp=second?name.get(second.id)??second.id:'-';
        group.second.set(runnerUp,(group.second.get(runnerUp)??0)+1);
        group.upper.push(first.upper);group.lower.push(first.lower);group.correlation.push(first.correlation);group.margin.push(first.margin);
        const checks=stage.decision.independent.checks;
        if(checks)for(const [check,passed] of Object.entries(checks))if(passed===false)group.failed[check]=(group.failed[check]??0)+1;
        const reason=`${diagnostic.reason} (${stage.stage})`;
        group.reasons[reason]=(group.reasons[reason]??0)+1;
      }
      release();
      options.onProgress?.(`원화 대조 실패 분석 · ${frames}/${stream.frameCount}프레임 · 크롭 ${crops}`);
    }
    // The border colour as a grade reading: nearest of five centres learnt from half of the accepted crops.
    const sums=[0,1,2,3,4].map(()=>({r:0,g:0,b:0,n:0}));
    acceptedColours.forEach((item,index)=>{if(index%2===0&&item.grade>=0&&item.grade<=4){const sum=sums[item.grade];sum.r+=item.colour[0];sum.g+=item.colour[1];sum.b+=item.colour[2];sum.n++;}});
    const centres=sums.map(sum=>sum.n?[sum.r/sum.n,sum.g/sum.n,sum.b/sum.n] as [number,number,number]:null);
    const readGrade=(colour:readonly [number,number,number])=>{
      let best=-1,distance=Infinity;
      centres.forEach((centre,index)=>{if(!centre)return;const d=(centre[0]-colour[0])**2+(centre[1]-colour[1])**2+(centre[2]-colour[2])**2;if(d<distance){distance=d;best=index;}});
      return best;
    };
    const confusion=[0,1,2,3,4].map(()=>[0,0,0,0,0]);let tested=0,correct=0;
    acceptedColours.forEach((item,index)=>{
      if(index%2===0||item.grade<0||item.grade>4)return;
      const read=readGrade(item.colour);if(read<0)return;
      confusion[item.grade][read]++;tested++;if(read===item.grade)correct++;
      else if(!Object.keys(samples).some(label=>label.startsWith(`misread ${item.name} `)))samples[`misread ${item.name} card-g${item.grade} read-g${read}`]=item.png();
    });
    const borderGradeOf=(key:string)=>{const counts:Record<string,number>={};for(const colour of rejectedColours.get(key)??[]){const read=String(readGrade(colour));counts[read]=(counts[read]??0)+1;}return counts;};
    return {frames,sampledFrames,crops,accepted,samples,colour:colourRows,features:{borderPixels:ring.length,upperBorderPixels:upperRing.length,accepted:featureAccepted,rejected:featureRejected},
      borderGrade:{learnt:sums.reduce((total,sum)=>total+sum.n,0),tested,correct,confusion,centres:centres.map(centre=>centre?[Math.round(centre[0]),Math.round(centre[1]),Math.round(centre[2])] as const:null)},
      rejected:[...groups].map(([first,group])=>({first,crops:group.upper.length,second:[...group.second].sort((a,b)=>b[1]-a[1])[0]?.[0]??'-',
        upper:median(group.upper),lower:median(group.lower),correlation:median(group.correlation),margin:median(group.margin),failed:group.failed,reasons:group.reasons,
        firstGrade:grade.get(firstIds.get(first)?.first??'')??null,secondGrade:grade.get(firstIds.get(first)?.second??'')??null,borderGrade:borderGradeOf(first)}))
        .sort((a,b)=>b.crops-a.crops)};
  }finally{acquisition.dispose();}
}
