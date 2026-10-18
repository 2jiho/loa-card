import type { Box, Layout } from "./detector";
import type { CaptureQuality } from './capture-quality';
import { ExactPixelCache } from './exact-pixel-cache';
import { alignCardBorders } from "./card-borders";
import { insideCard, inspectCapture } from "./capture-quality";
import { createAcquisitionRaster, rasterContext } from './acquisition-raster';
import type { Raster } from './acquisition-raster';
import { createLabelReader } from './card-label';
import { integerCropPixels } from './integer-crop-pixels';
import { hasNamePixels } from './name-pattern';
import { createGridScrollProbe } from './grid-scroll-probe';
import { pixelRegion } from './pixel-region';

/** Geometry/pixels only. No names, OCR, counts, inventory or duplicate decisions. */
export function createCardAcquirer<T extends Raster>(make: (width:number,height:number)=>T, reuseExact = false, reusePixels = true, reuseScroll = true) {
 const raster=createAcquisitionRaster(make);
 const pixelNamespace=crypto.randomUUID();let pixelSequence=0;
 type Cell = { slot:number; content:Box; preview:Box; alignment:number; intact:boolean;
   borderSides:number[]; image:T; labelVisible:boolean; quality:CaptureQuality; pixelKey:string } & ReturnType<typeof raster.features>;
 const cache = new ExactPixelCache<Omit<Cell,'image'>>();
 const probe=reuseExact&&reuseScroll?createGridScrollProbe():undefined;
 let stats={rowShift:null as number|null,exact:0,moved:0,inspected:0,probeMs:0};
 let label: ReturnType<typeof createLabelReader<T>> | undefined;
 const acquire=(frame:T, layout:Layout) => {
  label ??= createLabelReader(make);
  const context = rasterContext(frame);
  const geometry=(box:Box)=>{
    const padding=Math.ceil(6*layout.scale);
    const left=Math.max(0,Math.floor(box.x)-padding),top=Math.max(0,Math.floor(box.y)-padding);
    const width=Math.min(frame.width-left,Math.ceil(box.width)+2*padding);
    const height=Math.min(frame.height-top,Math.ceil(box.height)+2*padding);
    return {left,top,width,height,key:JSON.stringify([box,layout.area,layout.scale,left,top,width,height,frame.width,frame.height])};
  };
  const regions=layout.cells.map(geometry);
  const valid=regions.filter((r,i)=>r.width>0&&r.height>0&&insideCard(layout.cells[i],{x:0,y:0,width:frame.width,height:frame.height}));
  const origin={x:Math.min(...valid.map(r=>r.left)),y:Math.min(...valid.map(r=>r.top))};
  const right=Math.max(...valid.map(r=>r.left+r.width)),bottom=Math.max(...valid.map(r=>r.top+r.height));
  // One readback serves both the cheap row probe and all forty padded crops.
  const shared=probe&&valid.length?context.getImageData(origin.x,origin.y,right-origin.x,bottom-origin.y):undefined;
  const started=performance.now(),rowShift=shared?probe!(shared,origin,layout,frame.width,frame.height):null;
  stats={rowShift,exact:0,moved:0,inspected:0,probeMs:performance.now()-started};
  // Keep the preceding grid alive until all source slots have been consulted.
  const prior=rowShift?cache.snapshot():undefined;
  return layout.cells.map((box, slot) => {
    const bounds=regions[slot],{left,top,width,height}=bounds;
    let content = box, preview = box, alignment = 0, intact = false;
    let borderSides = [0, 0, 0, 0];
    let sourcePixels: Uint8ClampedArray | undefined, key = '';
    let region: {data:Uint8ClampedArray;width:number;height:number} | undefined;
    if (width > 0 && height > 0 && insideCard(box, { x: 0, y: 0, width: frame.width, height: frame.height })) {
      region = (shared?pixelRegion(shared,left-origin.x,top-origin.y,width,height):undefined)??context.getImageData(left, top, width, height);
      if (reuseExact) {
        sourcePixels = region.data;
        key = bounds.key;
        const previous = cache.get(slot,key,sourcePixels);
        if(previous){stats.exact++;return {...previous,image:raster.crop(frame,previous.content)};}
        const oldSlot=slot+(rowShift??0)*10,oldBox=layout.cells[oldSlot];
        if(prior&&oldBox&&oldBox.x===box.x&&oldBox.width===box.width&&oldBox.height===box.height&&
          insideCard(box,layout.area)&&insideCard(oldBox,layout.area)){
          const oldBounds=regions[oldSlot];
          const samePadding=oldBounds.width===width&&oldBounds.height===height&&
            oldBox.x-oldBounds.left===box.x-left&&oldBox.y-oldBounds.top===box.y-top;
          const old=samePadding?prior.get(oldSlot,oldBounds.key,sourcePixels):undefined;
          const dy=box.y-oldBox.y;
          // An integer pixel translation preserves Canvas resampling phase.
          // Full padded RGBA equality also covers names, counters and overlays.
          if(old&&old.intact&&Number.isInteger(dy)){
            const moved={...old,slot,content:{...old.content,y:old.content.y+dy},preview:{...old.preview,y:old.preview.y+dy}};
            cache.setOwned(slot,key,sourcePixels,moved);stats.moved++;
            return {...moved,image:raster.crop(frame,moved.content)};
          }
        }
      }
      stats.inspected++;
      const aligned = alignCardBorders(region.data, region.width, region.height, { ...box, x: box.x-left, y: box.y-top }, layout.scale);
      content = { ...aligned.content, x: aligned.content.x+left, y: aligned.content.y+top };
      preview = { ...aligned.preview, x: aligned.preview.x+left, y: aligned.preview.y+top };
      alignment = aligned.alignment;
      intact = aligned.intact; borderSides = aligned.borderSides;
    }
    const image = raster.crop(frame, content);
    // Integer, unscaled crops are already present in the border readback.
    // Fractional coordinates, resampling and clipped edges retain Canvas.
    const extracted = reusePixels && region ? integerCropPixels(region.data,region.width,region.height,
      {...content,x:content.x-left,y:content.y-top}) : undefined;
    const pixels=extracted ?? rasterContext(image).getImageData(0,0,image.width,image.height).data;
    const labelVisible=reusePixels && image.width===140 && image.height===210
      ? hasNamePixels(pixels,(14*140+6)*4,140) : label!(image);
    const complete=insideCard(content,{x:0,y:0,width:frame.width,height:frame.height})&&insideCard(box,layout.area);
    const quality=inspectCapture(pixels,image.width,image.height,complete,labelVisible,intact,alignment>=.8);
    if(complete&&!intact&&quality.reason!=='미보유 카드 뒷면 · 빈 슬롯') {
      quality.usable=false;
      const sides=['왼쪽','오른쪽','위','아래'].filter((_,side)=>borderSides[side]<.85);
      quality.reason='카드 테두리 불완전 · '+sides.join('/')+' · 재관측 대기';
    }
    // This key survives only the exact RGBA/geometry cache above, never fuzzy
    // portrait deduplication. A changed byte or crop creates a different key.
    const result:Cell = { slot, content, preview, alignment, intact, borderSides, image, labelVisible, quality,
      pixelKey:`${pixelNamespace}/${++pixelSequence}`, ...raster.features(image,pixels) };
    if (sourcePixels && content.x >= left+1 && content.y >= top+1 &&
        content.x+content.width <= left+width-1 && content.y+content.height <= top+height-1) {
      const {image: _image,...fields}=result;
      // getImageData allocated this region. Nothing mutates or transfers it;
      // let the bounded cache own it instead of copying every fresh card again.
      cache.setOwned(slot,key,sourcePixels,fields);
    }
    return result;
  });
 };
 return Object.assign(acquire,{stats:()=>({...stats})});
}
export const acquireCards=createCardAcquirer((width,height)=>{
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;
});
