import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {createVisualClient} from '../src/features/card-scanner/recognition/visual-client';
import {readScrollGeometry} from '../src/features/card-scanner/session/scroll-position';
import {SLOT_UNUSABLE} from '../src/features/card-scanner/session/list-table';
import {openRecordedShareStream} from './recorded-share-frames';
import {COLUMNS,createRowReadSession,createThumbClock,EMPTY_REASON,GRID_ROWS,PROBE_COLUMNS} from './row-read';
import type {RowReadResult,RowReadVisual} from './row-read';

/** Development prototype (docs/scanner-live-redesign.md 13.9, step 3). Not a scanner.
 *
 * The row-centred reading of dev/row-read.ts with a LIGHT CHECK in front of it. Once the card
 * window is known, a frame is first looked at through a small atlas: the scrollbar strip and
 * the two probe slots of each visible row, cut at the places the last full acquisition used,
 * read back in one go. The probes are identified by the visual worker. When every visible
 * row turns out to be a row the list table already has complete, the frame is done: no frame
 * conversion in the acquisition worker, no 40 crops, no quality checks.
 *
 * The light check only decides that a frame needs nothing. Whatever it cannot vouch for goes
 * to the full acquisition, whose quality checks and reads are those of dev/row-read.ts:
 * a thumb that cannot be read, scrollbar arrows that changed (the window moved or closed),
 * a probe that is not identified, a row not known or not complete. Probe crops of the light
 * check are not quality checked, so they are never recorded as observations. */
export interface RowLightResult extends RowReadResult {
  /** Frames with a known window: finished by the light check / sent on to the full acquisition,
   * by reason. Frames before the window was known (or after it was lost) are `searched`. */
  readonly lightSkipped:number;readonly fullFrames:number;readonly searched:number;
  readonly fullReasons:Readonly<Record<string,number>>;
  /** Reads after which an unfinished slot is left to the name reading (see HAND_OVER_AFTER). */
  readonly handOverAfter:number;
  /** Main-thread time of the light check per frame: drawing and reading back the atlas, and
   * cutting the probe canvases. The probe identification runs in the visual workers. */
  readonly lightMs:{readonly atlasMean:number;readonly atlasP95:number;readonly cutMean:number;readonly probeRoundTripMean:number;readonly frames:number};
  /** Mean time of a full acquisition round trip, for comparison. */
  readonly acquireMsMean:number;
}

/** A slot the visual reader cannot finish is read three times, then left to the name reading
 * (which this prototype does not have). Without this, one such card keeps its row unfinished
 * and every frame showing that row would go to the full acquisition. */
export const HAND_OVER_AFTER=3;
const mean=(values:readonly number[])=>values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length*100)/100:0;
const p95=(values:readonly number[])=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?Math.round(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]*100)/100:0;};

export async function runRowLight(options:{recordingId:string;signal:AbortSignal;scrollSteps?:number;handOverAfter?:number;onProgress?:(text:string)=>void}):Promise<RowLightResult> {
  const {recordingId,signal}=options,scrollSteps=options.scrollSteps??51;
  const stream=await openRecordedShareStream({recordingId,signal});
  const acquisition=createAcquisitionClient(signal);
  const visuals=[createVisualClient(signal),createVisualClient(signal)];
  if(visuals.some(visual=>!visual))throw Error('이 브라우저는 시각 판독 워커를 지원하지 않습니다.');
  const strip=Object.assign(document.createElement('canvas'),{width:16,height:942});
  const stripContext=strip.getContext('2d',{willReadFrequently:true})!;
  // The atlas: the scrollbar strip on the left, then the eight probe crops in two columns.
  const atlas=document.createElement('canvas');
  const atlasContext=atlas.getContext('2d',{willReadFrequently:true})!;
  try{
    await Promise.all([acquisition.ready(),...visuals.map(visual=>visual!.ready())]);
    const session=createRowReadSession(visuals as RowReadVisual[],scrollSteps,options.handOverAfter??HAND_OVER_AFTER),thumbClock=createThumbClock();
    const probeSlots=Array.from({length:GRID_ROWS},(_,row)=>PROBE_COLUMNS.map(column=>row*COLUMNS+column)).flat();
    /** From the last full acquisition: where the scrollbar and the probe crops were, and the
     * scrollbar's arrow ends (they do not change while the window stays where it is). */
    let known:{bar:{x:number;y:number;width:number;height:number};boxes:Map<number,{x:number;y:number;width:number;height:number}>;guard:Uint8ClampedArray;frame:{width:number;height:number}}|undefined;
    const probeCanvases=probeSlots.map(()=>document.createElement('canvas'));
    let frames=0,located=0,lightSkipped=0,fullFrames=0,searched=0;
    const fullReasons:Record<string,number>={},atlasMs:number[]=[],cutMs:number[]=[],probeMs:number[]=[],acquireMs:number[]=[];
    const guardOf=(pixels:Uint8ClampedArray)=>{const part=16*16*4,guard=new Uint8ClampedArray(part*2);guard.set(pixels.subarray(0,part));guard.set(pixels.subarray(pixels.length-part),part);return guard;};
    const guardMatches=(guard:Uint8ClampedArray,reference:Uint8ClampedArray)=>{
      // As the live scroll preview does: one unchanged arrow end is enough (the other changes when disabled or hovered).
      const part=16*16*4,difference=[0,0];
      for(let index=0;index<guard.length;index++)if(index%4!==3)difference[index<part?0:1]+=Math.abs(guard[index]-reference[index]);
      return difference.some(total=>total/(16*16*3)<=8);
    };
    const started=performance.now();
    for await(const frame of stream.frames()){
      signal.throwIfAborted();frames++;
      const source=frame.element;
      let reason:string|undefined,thumbPosition:number|null|undefined;
      if(known&&(known.frame.width!==source.width||known.frame.height!==source.height))known=undefined;
      if(known){
        // --- The light check.
        const t0=performance.now();
        const boxes=probeSlots.map(slot=>known!.boxes.get(slot));
        const width=Math.max(1,...boxes.map(box=>box?Math.round(box.width):0)),height=Math.max(1,...boxes.map(box=>box?Math.round(box.height):0));
        const atlasWidth=16+width*2,atlasHeight=Math.max(942,height*GRID_ROWS);
        if(atlas.width!==atlasWidth||atlas.height!==atlasHeight){atlas.width=atlasWidth;atlas.height=atlasHeight;}
        atlasContext.drawImage(source,known.bar.x,known.bar.y,known.bar.width,known.bar.height,0,0,16,942);
        boxes.forEach((box,index)=>{
          if(box)atlasContext.drawImage(source,box.x,box.y,box.width,box.height,16+(index%2)*width,Math.floor(index/2)*height,Math.round(box.width),Math.round(box.height));
        });
        const pixels=atlasContext.getImageData(0,0,atlasWidth,atlasHeight);
        const t1=performance.now();
        const stripPixels=new Uint8ClampedArray(16*942*4);
        for(let y=0;y<942;y++)stripPixels.set(pixels.data.subarray(y*atlasWidth*4,y*atlasWidth*4+64),y*64);
        const geometry=readScrollGeometry(stripPixels,16,942);
        thumbPosition=geometry?.position??null;
        if(!geometry)reason='thumb unread';
        else if(!guardMatches(guardOf(stripPixels),known.guard))reason='scrollbar changed';
        else if(boxes.some(box=>!box))reason='probe place unknown';
        else{
          boxes.forEach((box,index)=>{
            const canvas=probeCanvases[index],w=Math.round(box!.width),h=Math.round(box!.height);
            if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
            const part=new ImageData(w,h),left=16+(index%2)*width,top=Math.floor(index/2)*height;
            for(let y=0;y<h;y++)part.data.set(pixels.data.subarray(((top+y)*atlasWidth+left)*4,((top+y)*atlasWidth+left+w)*4),y*w*4);
            canvas.getContext('2d',{willReadFrequently:true})!.putImageData(part,0,0);
          });
          const t2=performance.now();
          const results=await session.readAll(probeCanvases);
          const t3=performance.now();
          atlasMs.push(t1-t0);cutMs.push(t2-t1);probeMs.push(t3-t2);
          const code=new Map<number,number|null>();
          probeSlots.forEach((slot,index)=>code.set(slot,results[index]?.identity?session.knownCode(results[index]!.identity!.id):null));
          let allKnown=true;
          for(let row=0;row<GRID_ROWS&&allKnown;row++){
            // Which other slots are usable is not known here: ask as if all were.
            const plan=session.planRow(row,slot=>code.get(slot)??null,()=>true);
            if(!plan.known||plan.read.length)allKnown=false;
          }
          if(allKnown){
            // Nothing to read. The table still sees where the probes were (placement only, no values).
            const slots=Array<number>(COLUMNS*GRID_ROWS).fill(SLOT_UNUSABLE);
            for(const slot of probeSlots)slots[slot]=code.get(slot)!;
            const thumb=thumbClock(frame.time,thumbPosition);
            session.table.observe({time:frame.time,thumbRow:thumb.position===null?null:Math.round(thumb.position*scrollSteps),settledMs:thumb.settledMs,slots});
            located++;lightSkipped++;
            if(frames%20===0)options.onProgress?.(`가벼운 확인 · ${frames}/${stream.frameCount}프레임 · 건너뜀 ${lightSkipped}`);
            continue;
          }
          reason='rows to read';
        }
      }
      // --- The full acquisition.
      const a0=performance.now();
      const acquired=await acquisition.detectAndAcquire(source,frame.time);
      acquireMs.push(performance.now()-a0);
      const release=()=>{for(const cell of acquired.cells)if(cell.image)cell.image.width=0;};
      if(!acquired.layout||acquired.cells.length!==COLUMNS*GRID_ROWS){release();known=undefined;searched++;continue;}
      located++;
      if(reason){fullFrames++;fullReasons[reason]=(fullReasons[reason]??0)+1;}else searched++;
      const bar=acquired.layout.scrollbar;
      stripContext.drawImage(source,bar.x,bar.y,bar.width,bar.height,0,0,16,942);
      const stripData=stripContext.getImageData(0,0,16,942).data;
      const position=readScrollGeometry(stripData,16,942)?.position??null;
      // Remember where to look next time. A probe's crop place is kept from the last frame it was usable in.
      const boxes:Map<number,{x:number;y:number;width:number;height:number}>=known?.boxes??new Map();
      for(const slot of probeSlots){
        const cell=acquired.cells[slot];
        // Until the slot has been usable once, the grid cell itself is the best guess of its crop.
        if(cell.quality.usable&&cell.image)boxes.set(slot,{...cell.content});
        else if(!boxes.has(slot))boxes.set(slot,{...acquired.layout.cells[slot]});
      }
      known=position===null?undefined:{bar:{...bar},boxes,guard:guardOf(stripData),frame:{width:source.width,height:source.height}};
      await session.processFrame(frame.time,acquired.cells.map(cell=>({usable:cell.quality.usable,empty:cell.quality.reason===EMPTY_REASON,image:cell.image})),thumbClock(frame.time,position));
      release();
      if(frames%20===0)options.onProgress?.(`가벼운 확인 · ${frames}/${stream.frameCount}프레임 · 건너뜀 ${lightSkipped}`);
    }
    return {frames,locatedFrames:located,wallMs:Math.round(performance.now()-started),...session.stats,scrollSteps,table:session.summary(),cards:session.cards(),
      lightSkipped,fullFrames,searched,fullReasons,handOverAfter:options.handOverAfter??HAND_OVER_AFTER,
      lightMs:{atlasMean:mean(atlasMs),atlasP95:p95(atlasMs),cutMean:mean(cutMs),probeRoundTripMean:mean(probeMs),frames:atlasMs.length},
      acquireMsMean:mean(acquireMs)};
  }finally{acquisition.dispose();for(const visual of visuals)visual?.dispose();}
}
