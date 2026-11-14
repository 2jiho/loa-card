import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {createVisualClient} from '../src/features/card-scanner/recognition/visual-client';
import {readScrollGeometry} from '../src/features/card-scanner/session/scroll-position';
import {openRecordedShareStream} from './recorded-share-frames';
import {createThumbClock} from './row-read';

/** Development measurement (docs/card-image-structure.md, "측정 도구"). Not a scanner.
 *
 * Takes the card crops of a server recording (one frame per scroll position), lines each crop up with the client's grade border for its card, and
 * stacks them. Whatever the game draws at a fixed place on every card (border, plates, jewel
 * sockets, the favourite button, the count icon) stays sharp in the stack and has a low
 * spread between cards; the artwork averages out and has a high spread.
 *
 * Outputs are pictures for a person to look at and numbers about how far the crops are from
 * the border template. Nothing here reads or decides a card value.
 *
 * The border templates and UI sheets are private client extracts under work/ (served by the
 * dev server only). */
const WIDTH=140,HEIGHT=210,PIXELS=WIDTH*HEIGHT;
export interface CardMapResult {
  readonly frames:number;readonly sampledFrames:number;readonly crops:number;readonly skippedSize:number;
  /** Per grade: crops, mean border difference at the best shift, and how often each shift was best. */
  readonly alignment:readonly {readonly grade:number;readonly crops:number;readonly meanDifference:number;
    readonly meanSecondBest:number;readonly shifts:Readonly<Record<string,number>>}[];
  /** How yellow the favourite button's place was per crop (mean R-B), in steps of 10. */
  readonly favouriteHistogram:Readonly<Record<string,number>>;
  readonly stacks:Readonly<Record<string,number>>;
  /** Best border shift by visible grid row (0..3), all grades together. */
  readonly shiftsByRow:readonly Readonly<Record<string,number>>[];
  /** Per grid slot (0..39): the grid cell the layout gives, how far the crop actually taken was
   * from it (the per-crop border alignment), and where the card's border really was on screen
   * by the template (crop place + best shift), each as "x,y" -> crops. Grade given separately
   * because the border extracts of different grades disagree by a pixel across. */
  readonly slotOrigins:readonly {readonly slot:number;readonly cell:{readonly x:number;readonly y:number};
    readonly cropOffset:Readonly<Record<string,number>>;readonly borderByGrade:Readonly<Record<string,Readonly<Record<string,number>>>>}[];
  /** Per crop: how much brighter the "equipped" lettering's place is than its surroundings, in steps of 5. */
  readonly equippedHistogram:Readonly<Record<string,number>>;
  /** Boxes in border-aligned card pixels (x0,y0 inclusive; x1,y1 exclusive), from differences between stacks. */
  readonly boxes:Readonly<Record<string,{readonly x0:number;readonly y0:number;readonly x1:number;readonly y1:number}|null>>;
  /** Runs of columns (x0..x1) inside a box where the difference is present: separate elements side by side. */
  readonly columns:Readonly<Record<string,readonly (readonly [number,number])[]>>;
  /** Per card row y: mean brightness of the stack of all crops and mean spread between cards, centre columns only. */
  readonly rowProfile:readonly {readonly y:number;readonly brightness:number;readonly spread:number}[];
  /** Pictures at 3x: PNG data URLs by name. */
  readonly images:Readonly<Record<string,string>>;
}

class Stack {
  readonly sum=new Float64Array(PIXELS*3);readonly squares=new Float64Array(PIXELS*3);count=0;
  /** Add a crop moved so that its border sits where the template's does. */
  add(data:Uint8ClampedArray,dx:number,dy:number):void {
    this.count++;
    for(let y=0;y<HEIGHT;y++){
      const sy=Math.min(HEIGHT-1,Math.max(0,y+dy));
      for(let x=0;x<WIDTH;x++){
        const from=(sy*WIDTH+Math.min(WIDTH-1,Math.max(0,x+dx)))*4,to=(y*WIDTH+x)*3;
        for(let channel=0;channel<3;channel++){const value=data[from+channel];this.sum[to+channel]+=value;this.squares[to+channel]+=value*value;}
      }
    }
  }
  mean():Float32Array {return Float32Array.from(this.sum,value=>this.count?value/this.count:0);}
  /** Spread between cards per pixel (standard deviation, mean of the three channels). */
  spread():Float32Array {
    const out=new Float32Array(PIXELS);
    if(!this.count)return out;
    for(let index=0;index<PIXELS;index++){
      let total=0;
      for(let channel=0;channel<3;channel++){
        const mean=this.sum[index*3+channel]/this.count;
        total+=Math.sqrt(Math.max(0,this.squares[index*3+channel]/this.count-mean*mean));
      }
      out[index]=total/3;
    }
    return out;
  }
}

function toPng(rgb:(index:number)=>readonly [number,number,number],scale=3):string {
  const small=Object.assign(document.createElement('canvas'),{width:WIDTH,height:HEIGHT}),context=small.getContext('2d')!;
  const image=context.createImageData(WIDTH,HEIGHT);
  for(let index=0;index<PIXELS;index++){const [r,g,b]=rgb(index);image.data.set([r,g,b,255],index*4);}
  context.putImageData(image,0,0);
  const big=Object.assign(document.createElement('canvas'),{width:WIDTH*scale,height:HEIGHT*scale}),bigContext=big.getContext('2d')!;
  bigContext.imageSmoothingEnabled=false;bigContext.drawImage(small,0,0,WIDTH*scale,HEIGHT*scale);
  return big.toDataURL('image/png');
}
const meanPng=(stack:Stack)=>{const mean=stack.mean();return toPng(index=>[mean[index*3],mean[index*3+1],mean[index*3+2]]);};
const spreadPng=(stack:Stack)=>{const spread=stack.spread();return toPng(index=>{const value=Math.min(255,spread[index]*3);return [value,value,value];});};
const differencePng=(a:Stack,b:Stack)=>{
  const first=a.mean(),second=b.mean();
  return toPng(index=>{
    const value=Math.min(255,(Math.abs(first[index*3]-second[index*3])+Math.abs(first[index*3+1]-second[index*3+1])+Math.abs(first[index*3+2]-second[index*3+2]))/3*4);
    return [value,value,value];
  });
};

type Box={x0:number;y0:number;x1:number;y1:number};
/** Mean absolute difference of two stacks per pixel. */
function differenceMap(a:Stack,b:Stack):Float32Array {
  const first=a.mean(),second=b.mean(),out=new Float32Array(PIXELS);
  for(let index=0;index<PIXELS;index++)out[index]=(Math.abs(first[index*3]-second[index*3])+Math.abs(first[index*3+1]-second[index*3+1])+Math.abs(first[index*3+2]-second[index*3+2]))/3;
  return out;
}
/** The box of pixels inside `window` whose value is at least `share` of the window's largest value. */
function boxOf(map:Float32Array,window:Box,share=.3):Box|null {
  let peak=0;
  for(let y=window.y0;y<window.y1;y++)for(let x=window.x0;x<window.x1;x++)peak=Math.max(peak,map[y*WIDTH+x]);
  if(peak<8)return null;
  let x0=Infinity,y0=Infinity,x1=-1,y1=-1;
  for(let y=window.y0;y<window.y1;y++)for(let x=window.x0;x<window.x1;x++)if(map[y*WIDTH+x]>=peak*share){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);}
  return x1<0?null:{x0,y0,x1,y1};
}
/** Runs of columns of a box that hold a value of at least `share` of the box's largest one. */
function columnRuns(map:Float32Array,box:Box|null,share=.3):[number,number][] {
  if(!box)return [];
  let peak=0;
  for(let y=box.y0;y<box.y1;y++)for(let x=box.x0;x<box.x1;x++)peak=Math.max(peak,map[y*WIDTH+x]);
  const runs:[number,number][]=[];
  for(let x=box.x0;x<box.x1;x++){
    let present=false;
    for(let y=box.y0;y<box.y1&&!present;y++)present=map[y*WIDTH+x]>=peak*share;
    if(!present)continue;
    const last=runs.at(-1);
    if(last&&last[1]===x)last[1]=x+1;else runs.push([x,x+1]);
  }
  return runs;
}

/** A card picture at 4x with labelled boxes drawn on it, for a person to check. */
function overlayPng(rgb:(index:number)=>readonly [number,number,number],boxes:readonly {label:string;box:Box;color:string}[]):string {
  const scale=4,margin=150;
  const small=Object.assign(document.createElement('canvas'),{width:WIDTH,height:HEIGHT}),smallContext=small.getContext('2d')!;
  const image=smallContext.createImageData(WIDTH,HEIGHT);
  for(let index=0;index<PIXELS;index++){const [r,g,b]=rgb(index);image.data.set([r,g,b,255],index*4);}
  smallContext.putImageData(image,0,0);
  const canvas=Object.assign(document.createElement('canvas'),{width:WIDTH*scale+margin,height:HEIGHT*scale}),context=canvas.getContext('2d')!;
  context.fillStyle='#111';context.fillRect(0,0,canvas.width,canvas.height);
  context.imageSmoothingEnabled=false;context.drawImage(small,0,0,WIDTH*scale,HEIGHT*scale);
  context.font='13px sans-serif';context.textBaseline='middle';
  boxes.forEach(({label,box,color},index)=>{
    context.strokeStyle=color;context.lineWidth=2;
    context.strokeRect(box.x0*scale+1,box.y0*scale+1,(box.x1-box.x0)*scale-2,(box.y1-box.y0)*scale-2);
    const y=18+index*30;
    context.fillStyle=color;context.fillRect(WIDTH*scale+8,y-6,12,12);
    context.fillStyle='#eee';context.fillText(label,WIDTH*scale+26,y);
    context.fillStyle='#999';context.fillText(`${box.x0},${box.y0} ${box.x1-box.x0}×${box.y1-box.y0}`,WIDTH*scale+26,y+14);
  });
  return canvas.toDataURL('image/png');
}

async function loadTemplate(url:string):Promise<{data:Uint8ClampedArray;ring:Int32Array}> {
  const response=await fetch(url);
  if(!response.ok)throw Error(`테두리 기준 이미지를 열 수 없습니다: ${url}`);
  const bitmap=await createImageBitmap(await response.blob());
  if(bitmap.width!==WIDTH||bitmap.height!==HEIGHT)throw Error(`테두리 기준 이미지 크기가 ${WIDTH}×${HEIGHT}가 아닙니다: ${url}`);
  const canvas=Object.assign(document.createElement('canvas'),{width:WIDTH,height:HEIGHT}),context=canvas.getContext('2d',{willReadFrequently:true})!;
  context.drawImage(bitmap,0,0);bitmap.close();
  const data=context.getImageData(0,0,WIDTH,HEIGHT).data;
  // Only the solid part of the frame is compared; its soft edge blends with whatever is behind it.
  const ring:number[]=[];
  for(let index=0;index<PIXELS;index++)if(data[index*4+3]>=250)ring.push(index);
  return {data,ring:Int32Array.from(ring)};
}

export async function runCardMap(options:{recordingId:string;signal:AbortSignal;maxFrames?:number;onProgress?:(text:string)=>void}):Promise<CardMapResult> {
  const {recordingId,signal}=options,maxFrames=options.maxFrames??80;
  const templates=await Promise.all([0,1,2,3,4].map(grade=>loadTemplate(`/work/composed-card-templates/borders/border-${grade}.png`)));
  const catalog=await (await fetch(`${import.meta.env.BASE_URL}scanner/cards.json`)).json() as {cards:{id:string;rarity:number}[]};
  const rarity=new Map(catalog.cards.map(card=>[card.id,card.rarity]));
  const stream=await openRecordedShareStream({recordingId,signal});
  const acquisition=createAcquisitionClient(signal),visual=createVisualClient(signal);
  if(!visual)throw Error('이 브라우저는 시각 판독 워커를 지원하지 않습니다.');
  const strip=Object.assign(document.createElement('canvas'),{width:16,height:942}),stripContext=strip.getContext('2d',{willReadFrequently:true})!;
  try{
    await Promise.all([acquisition.ready(),visual.ready()]);
    const thumbClock=createThumbClock(),seen=new Set<number>();
    const stacks={all:new Stack(),countShown:new Stack(),countZero:new Stack(),favouriteOn:new Stack(),favouriteOff:new Stack(),
      awakening0:new Stack(),awakening5:new Stack(),equippedOn:new Stack(),equippedOff:new Stack(),grade0:new Stack(),grade1:new Stack(),grade2:new Stack(),grade3:new Stack(),grade4:new Stack()};
    const alignment=[0,1,2,3,4].map(grade=>({grade,crops:0,total:0,second:0,shifts:{} as Record<string,number>}));
    const favouriteHistogram:Record<string,number>={},equippedHistogram:Record<string,number>={};
    const shiftsByRow=[0,1,2,3].map(()=>({} as Record<string,number>));
    const slotOrigins=Array.from({length:40},(_,slot)=>({slot,cell:{x:0,y:0},cropOffset:{} as Record<string,number>,borderByGrade:{} as Record<string,Record<string,number>>}));
    // Kept for the second pass, which sorts the crops by states the first pass makes visible.
    const kept:{data:Uint8ClampedArray;dx:number;dy:number}[]=[];
    let frames=0,sampledFrames=0,crops=0,skippedSize=0;
    for await(const frame of stream.frames()){
      signal.throwIfAborted();frames++;
      if(sampledFrames>=maxFrames)continue;
      const acquired=await acquisition.detectAndAcquire(frame.element,frame.time);
      const release=()=>{for(const cell of acquired.cells)if(cell.image)cell.image.width=0;};
      if(!acquired.layout||acquired.cells.length!==40){release();continue;}
      const bar=acquired.layout.scrollbar;
      stripContext.drawImage(frame.element,bar.x,bar.y,bar.width,bar.height,0,0,16,942);
      const thumb=thumbClock(frame.time,readScrollGeometry(stripContext.getImageData(0,0,16,942).data,16,942)?.position??null);
      const step=thumb.position===null?null:Math.round(thumb.position*51);
      // One frame per scroll position, taken the first time most of its slots are usable.
      if(step===null||seen.has(step)||acquired.cells.filter(cell=>cell.quality.usable&&cell.image).length<30){release();continue;}
      seen.add(step);sampledFrames++;
      for(const cell of acquired.cells){
        if(!cell.quality.usable||!cell.image)continue;
        if(cell.image.width!==WIDTH||cell.image.height!==HEIGHT){skippedSize++;continue;}
        const data=cell.image.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,WIDTH,HEIGHT).data;
        const result=await visual.read(cell.image);
        const grade=result.identity?rarity.get(result.identity.id):undefined;
        if(grade===undefined||grade<0||grade>4)continue;
        // Where does the crop's border sit against the client's border for this grade?
        const template=templates[grade];
        let best={dx:0,dy:0,difference:Infinity},second=Infinity;
        for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){
          let total=0,count=0;
          for(const index of template.ring){
            const x=index%WIDTH+dx,y=Math.floor(index/WIDTH)+dy;
            if(x<0||y<0||x>=WIDTH||y>=HEIGHT)continue;
            const at=(y*WIDTH+x)*4,reference=index*4;
            total+=Math.abs(data[at]-template.data[reference])+Math.abs(data[at+1]-template.data[reference+1])+Math.abs(data[at+2]-template.data[reference+2]);count+=3;
          }
          const difference=count?total/count:Infinity;
          if(difference<best.difference){second=best.difference;best={dx,dy,difference};}
          else if(difference<second)second=difference;
        }
        const entry=alignment[grade];
        entry.crops++;entry.total+=best.difference;entry.second+=second;
        entry.shifts[`${best.dx},${best.dy}`]=(entry.shifts[`${best.dx},${best.dy}`]??0)+1;
        const gridRow=Math.floor(acquired.cells.indexOf(cell)/10);
        if(gridRow>=0&&gridRow<4)shiftsByRow[gridRow][`${best.dx},${best.dy}`]=(shiftsByRow[gridRow][`${best.dx},${best.dy}`]??0)+1;
        kept.push({data,dx:best.dx,dy:best.dy});
        {
          const slot=acquired.cells.indexOf(cell),box=acquired.layout.cells[slot],origin=slotOrigins[slot];
          const bump=(map:Record<string,number>,key:string)=>{map[key]=(map[key]??0)+1;};
          origin.cell={x:box.x,y:box.y};
          bump(origin.cropOffset,`${cell.content.x-box.x},${cell.content.y-box.y}`);
          bump(origin.borderByGrade[String(grade)]??={},`${cell.content.x+best.dx},${cell.content.y+best.dy}`);
        }
        crops++;
        const add=(stack:Stack)=>stack.add(data,best.dx,best.dy);
        add(stacks.all);add(stacks[`grade${grade}` as 'grade0']);
        const extraCopies=result.values?.extraCopies??null,awakening=result.values?.awakening??null;
        if(extraCopies!==null&&extraCopies>0)add(stacks.countShown);
        if(extraCopies===0)add(stacks.countZero);
        if(awakening===0)add(stacks.awakening0);
        if(awakening===5)add(stacks.awakening5);
        // The favourite button at the lower left: gold when on, grey when off.
        let yellow=0,samples=0;
        for(let y=143;y<=165;y++)for(let x=12;x<=31;x++){
          const sx=Math.min(WIDTH-1,Math.max(0,x+best.dx)),sy=Math.min(HEIGHT-1,Math.max(0,y+best.dy)),at=(sy*WIDTH+sx)*4;
          yellow+=data[at]-data[at+2];samples++;
        }
        const metric=yellow/samples,bucket=String(Math.floor(metric/10)*10);
        favouriteHistogram[bucket]=(favouriteHistogram[bucket]??0)+1;
        add(metric>=40?stacks.favouriteOn:stacks.favouriteOff);
      }
      release();
      options.onProgress?.(`카드 배치 측정 · ${frames}/${stream.frameCount}프레임 · 표본 ${sampledFrames}장면 · 크롭 ${crops}`);
    }
    // Second pass: the "equipped" banner. Its lettering shows in the difference between cards with and
    // without a count (maxed cards are the ones worn); that picture gives the lettering's pixels, and each
    // crop is then sorted by how much brighter those pixels are than the rest of the banner's place.
    const countDifference=differenceMap(stacks.countShown,stacks.countZero);
    const letteringWindow:Box={x0:34,y0:102,x1:106,y1:130};
    let letteringPeak=0;
    for(let y=letteringWindow.y0;y<letteringWindow.y1;y++)for(let x=letteringWindow.x0;x<letteringWindow.x1;x++)letteringPeak=Math.max(letteringPeak,countDifference[y*WIDTH+x]);
    const lettering:number[]=[],around:number[]=[];
    for(let y=letteringWindow.y0;y<letteringWindow.y1;y++)for(let x=letteringWindow.x0;x<letteringWindow.x1;x++)
      (countDifference[y*WIDTH+x]>=letteringPeak*.5?lettering:around).push(y*WIDTH+x);
    for(const crop of kept){
      const brightness=(indices:number[])=>{
        let total=0;
        for(const index of indices){
          const x=Math.min(WIDTH-1,Math.max(0,index%WIDTH+crop.dx)),y=Math.min(HEIGHT-1,Math.max(0,Math.floor(index/WIDTH)+crop.dy)),at=(y*WIDTH+x)*4;
          total+=(crop.data[at]+crop.data[at+1]+crop.data[at+2])/3;
        }
        return indices.length?total/indices.length:0;
      };
      const metric=brightness(lettering)-brightness(around),bucket=String(Math.floor(metric/5)*5);
      equippedHistogram[bucket]=(equippedHistogram[bucket]??0)+1;
      (metric>=25?stacks.equippedOn:stacks.equippedOff).add(crop.data,crop.dx,crop.dy);
    }
    const equippedDifference=differenceMap(stacks.equippedOn,stacks.equippedOff),favouriteDifference=differenceMap(stacks.favouriteOn,stacks.favouriteOff);
    const awakeningDifference=differenceMap(stacks.awakening0,stacks.awakening5);
    const boxes:Record<string,Box|null>={
      countCluster:boxOf(countDifference,{x0:36,y0:132,x1:140,y1:172}),
      jewels:boxOf(awakeningDifference,{x0:8,y0:168,x1:132,y1:208}),
      favourite:boxOf(favouriteDifference,{x0:4,y0:132,x1:40,y1:172}),
      equippedBanner:boxOf(equippedDifference,{x0:0,y0:88,x1:140,y1:140},.15),
      equippedLettering:boxOf(equippedDifference,{x0:20,y0:96,x1:120,y1:134},.5),
    };
    // The banner's rows: where cards with and without it differ, away from the lettering.
    const bannerRow=(y:number)=>{let total=0,count=0;for(const x of [...Array(30).keys()].flatMap(offset=>[8+offset,102+offset])){total+=equippedDifference[y*WIDTH+x];count++;}return total/count;};
    const bannerProfile=Array.from({length:HEIGHT},(_,y)=>bannerRow(y));
    const bannerPeak=Math.max(...bannerProfile.slice(88,142));
    const bannerRows=bannerProfile.map((value,y)=>y>=88&&y<142&&value>=bannerPeak*.5?y:-1).filter(y=>y>=0);
    boxes.equippedBanner=bannerRows.length?{x0:0,y0:bannerRows[0],x1:WIDTH,y1:bannerRows.at(-1)!+1}:null;
    const columns={countCluster:columnRuns(countDifference,boxes.countCluster),jewels:columnRuns(awakeningDifference,boxes.jewels,.4)};
    const allMean=stacks.all.mean(),allSpread=stacks.all.spread();
    const rowProfile=Array.from({length:HEIGHT},(_,y)=>{
      let brightness=0,spread=0,count=0;
      for(let x=62;x<78;x++){const index=y*WIDTH+x;brightness+=(allMean[index*3]+allMean[index*3+1]+allMean[index*3+2])/3;spread+=allSpread[index];count++;}
      return {y,brightness:Math.round(brightness/count*10)/10,spread:Math.round(spread/count*10)/10};
    });
    // The layout as measured here, next to the areas the reader uses today.
    const drawn:{label:string;box:Box;color:string}[]=[
      {label:'이름 영역 (현재 코드)',box:{x0:6,y0:14,x1:134,y1:50},color:'#ff5c8a'},
      {label:'원화 위쪽 띠 (현재 코드)',box:{x0:12,y0:59,x1:128,y1:92},color:'#4dd0e1'},
      {label:'원화 아래쪽 띠 (현재 코드)',box:{x0:12,y0:92,x1:128,y1:125},color:'#26a69a'},
      ...(boxes.equippedBanner?[{label:'장착중 배너 (측정)',box:boxes.equippedBanner,color:'#ffd54f'}]:[]),
      ...(boxes.favourite?[{label:'즐겨찾기 버튼 (측정)',box:boxes.favourite,color:'#ff9800'}]:[]),
      ...(boxes.countCluster?[{label:'장수 아이콘+숫자 (측정)',box:boxes.countCluster,color:'#ba68c8'}]:[]),
      ...(boxes.jewels?columns.jewels.map(([x0,x1],index)=>({label:`각성 보석 ${index+1} (측정)`,box:{x0,y0:boxes.jewels!.y0,x1,y1:boxes.jewels!.y1},color:'#8bc34a'})):[]),
    ];
    const allMeanForOverlay=stacks.all.mean(),equippedMean=stacks.equippedOn.mean();
    const sample=(crop:{data:Uint8ClampedArray;dx:number;dy:number})=>(index:number):[number,number,number]=>{
      const x=Math.min(WIDTH-1,Math.max(0,index%WIDTH+crop.dx)),y=Math.min(HEIGHT-1,Math.max(0,Math.floor(index/WIDTH)+crop.dy)),at=(y*WIDTH+x)*4;
      return [crop.data[at],crop.data[at+1],crop.data[at+2]];
    };
    const images:Record<string,string>={
      'layout-on-mean':overlayPng(index=>[allMeanForOverlay[index*3],allMeanForOverlay[index*3+1],allMeanForOverlay[index*3+2]],drawn),
      'layout-on-equipped':overlayPng(index=>[equippedMean[index*3],equippedMean[index*3+1],equippedMean[index*3+2]],drawn),
      ...Object.fromEntries([0,Math.floor(kept.length/3),Math.floor(kept.length*2/3)].filter(index=>kept[index]).map((index,order)=>[`layout-on-crop-${order+1}`,overlayPng(sample(kept[index]),drawn)])),
      'mean-equipped-on':meanPng(stacks.equippedOn),'mean-equipped-off':meanPng(stacks.equippedOff),'difference-equipped':differencePng(stacks.equippedOn,stacks.equippedOff),
      'mean-all':meanPng(stacks.all),'spread-all':spreadPng(stacks.all),
      'mean-count-shown':meanPng(stacks.countShown),'mean-count-zero':meanPng(stacks.countZero),'difference-count':differencePng(stacks.countShown,stacks.countZero),
      'mean-favourite-on':meanPng(stacks.favouriteOn),'mean-favourite-off':meanPng(stacks.favouriteOff),'difference-favourite':differencePng(stacks.favouriteOn,stacks.favouriteOff),
      'mean-awakening-0':meanPng(stacks.awakening0),'mean-awakening-5':meanPng(stacks.awakening5),'difference-awakening':differencePng(stacks.awakening0,stacks.awakening5),
      ...Object.fromEntries([0,1,2,3,4].map(grade=>[`mean-grade-${grade}`,meanPng(stacks[`grade${grade}` as 'grade0'])])),
    };
    return {frames,sampledFrames,crops,skippedSize,
      alignment:alignment.map(entry=>({grade:entry.grade,crops:entry.crops,meanDifference:entry.crops?Math.round(entry.total/entry.crops*10)/10:0,
        meanSecondBest:entry.crops?Math.round(entry.second/entry.crops*10)/10:0,shifts:entry.shifts})),
      favouriteHistogram,equippedHistogram,shiftsByRow,slotOrigins,boxes,columns,rowProfile,stacks:Object.fromEntries(Object.entries(stacks).map(([name,stack])=>[name,stack.count])),images};
  }finally{acquisition.dispose();visual.dispose();}
}
