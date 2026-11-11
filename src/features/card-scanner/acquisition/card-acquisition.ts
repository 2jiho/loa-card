import type { Box, Layout } from "./detector";
import type { CaptureQuality, PreBorderEvidence } from './capture-quality';
import { ExactPixelCache } from './exact-pixel-cache';
import { alignCardBorders } from "./card-borders";
import { insideCard, inspectCapture, preBorderEvidence } from "./capture-quality";
import { createAcquisitionRaster, rasterContext } from './acquisition-raster';
import type { Raster } from './acquisition-raster';
import { createLabelReader } from './card-label';
import { integerCropPixels } from './integer-crop-pixels';
import { hasNamePixels } from '../recognition/name-pattern';
import { createGridScrollProbe } from '../session/grid-scroll-probe';
import { pixelRegion } from './pixel-region';
import { opaqueCardPixels, ownedCardRaster, requireMeasuredRaster } from './measured-raster';
import type { MeasuredRaster } from './measured-raster';
import type { PixelRaster } from './pixel-raster';
import { observationPixels } from './observation-pixels';
import { fieldPixelRegions } from './field-pixel-regions';
import {lowerPanelCandidate,panelCrossesCardEdge} from './overlay-quality';

export type AcquisitionRasterReuse = { measuredRaster:MeasuredRaster; ownCardPixels?:boolean };

type ReceiptSource = Readonly<{generation:string;frameId:number;slot:number}>;
type ReceiptGeometry = Readonly<{box:Box; bounds:{left:number;top:number;width:number;height:number}; content:Box;
  area:Box;scale:number;frameWidth:number;frameHeight:number}>;
export type ExperimentalExactReceipt = Readonly<{from:ReceiptSource;to:ReceiptSource;dy:number;
  fromGeometry:ReceiptGeometry;toGeometry:ReceiptGeometry}>;
type ReceiptFields = {content:Box};
type Bounds = {left:number;top:number;width:number;height:number};

/** Experimental, process-local evidence only. A serialized receipt is not a
 * capability; the worker/response/source binding and replay remain unimplemented. */
class ExactReceiptExperiment {
 private readonly generation=crypto.randomUUID();
 private origins=new WeakMap<object,{source:ReceiptSource;geometry:ReceiptGeometry}>();
 private readonly active=new Set<ExperimentalExactReceipt>();
 private readonly order:ExperimentalExactReceipt[]=[];
 private lastFrame=0;
 private frame=0;
 private receipts:ExperimentalExactReceipt[]=[];
 private closed=false;
 begin(frameId:number,frame:Raster,layout:Layout) {
  if(this.closed||!Number.isSafeInteger(frameId)||frameId<=this.lastFrame)throw new Error('Invalid or repeated experimental acquisition frame');
  this.lastFrame=frameId;this.frame=0;this.receipts=[];
  // An unsupported frame still scans normally, but yields no evidence. Bound the
  // total cache-sized padded input as well as the number of source references.
  const p=Math.ceil(6*layout.scale);
  const bytes=layout.cells.reduce((sum,box)=>sum+(Math.ceil(box.width)+2*p)*(Math.ceil(box.height)+2*p)*4,0);
  if(layout.cells.length<=40&&Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=32*1024*1024&&
    Number.isSafeInteger(frame.width)&&Number.isSafeInteger(frame.height)&&frame.width>0&&frame.height>0&&
    Number.isFinite(layout.scale)&&layout.scale>0)this.frame=frameId;
 }
 private geometry(fields:ReceiptFields,box:Box,bounds:Bounds,frame:Raster,layout:Layout):ReceiptGeometry|undefined {
  if(!this.frame||![...Object.values(box),bounds.left,bounds.top,bounds.width,bounds.height,...Object.values(fields.content),
    ...Object.values(layout.area)].every(Number.isSafeInteger)||
    box.width<=0||box.height<=0||bounds.width<=0||bounds.height<=0||fields.content.width<=0||fields.content.height<=0||
    !insideCard(box,layout.area)||!insideCard(box,{x:0,y:0,width:frame.width,height:frame.height})||
    !insideCard(fields.content,{x:bounds.left,y:bounds.top,width:bounds.width,height:bounds.height}))return;
  return Object.freeze({box:Object.freeze({...box}),bounds:Object.freeze({left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height}),content:Object.freeze({...fields.content}),
    area:Object.freeze({...layout.area}),scale:layout.scale,frameWidth:frame.width,frameHeight:frame.height});
 }
 store(fields:ReceiptFields,slot:number,box:Box,bounds:Bounds,frame:Raster,layout:Layout) {
  const geometry=this.geometry(fields,box,bounds,frame,layout);
  if(geometry&&Number.isSafeInteger(slot)&&slot>=0&&slot<40)
    this.origins.set(fields,{source:Object.freeze({generation:this.generation,frameId:this.frame,slot}),geometry});
 }
 match(fields:ReceiptFields,slot:number,box:Box,bounds:Bounds,frame:Raster,layout:Layout,dy:number) {
  const prior=this.origins.get(fields);
  const nextContent={...fields.content,y:fields.content.y+dy};
  const geometry=this.geometry({content:nextContent},box,bounds,frame,layout);
  if(!prior||!geometry||!Number.isSafeInteger(dy)||!Number.isSafeInteger(slot)||slot<0||slot>=40||
    prior.source.frameId>=this.frame)return;
  const a=prior.geometry,b=geometry;
  if(a.frameWidth!==b.frameWidth||a.frameHeight!==b.frameHeight||a.scale!==b.scale||
    JSON.stringify(a.area)!==JSON.stringify(b.area)||a.box.x!==b.box.x||a.box.y+dy!==b.box.y||
    a.box.width!==b.box.width||a.box.height!==b.box.height||a.bounds.left!==b.bounds.left||
    a.bounds.top+dy!==b.bounds.top||a.bounds.width!==b.bounds.width||a.bounds.height!==b.bounds.height||
    a.content.x!==b.content.x||a.content.y+dy!==b.content.y||a.content.width!==b.content.width||a.content.height!==b.content.height)return;
  const receipt=Object.freeze({from:prior.source,to:Object.freeze({generation:this.generation,frameId:this.frame,slot}),
    dy,fromGeometry:a,toGeometry:b});
  this.receipts.push(receipt);this.active.add(receipt);this.order.push(receipt);
  if(this.order.length>160)this.active.delete(this.order.shift()!);
 }
 finish(){this.frame=0;return this.receipts.slice();}
 owns(receipt:ExperimentalExactReceipt){return !this.closed&&this.active.has(receipt);}
 abort(){this.frame=0;this.origins=new WeakMap();this.active.clear();this.order.length=0;this.receipts=[];}
 close(){this.closed=true;this.abort();}
}

/** Geometry/pixels only. No names, OCR, counts, inventory or duplicate decisions. */
function createCardAcquirerCore<T extends Raster>(make: (width:number,height:number)=>T, reuseExact = false, reusePixels = true, reuseScroll = true, experiment?:ExactReceiptExperiment, measureMoveReuse=false) {
 const raster=createAcquisitionRaster(make);
 const pixelNamespace=crypto.randomUUID();let pixelSequence=0,fieldSequence=0;
 let advisoryCursor=0;
 type Cell = { slot:number; content:Box; preview:Box; alignment:number; intact:boolean;complete:boolean;
   borderSides:number[]; image:T; ownedPixels?:PixelRaster; labelVisible:boolean; quality:CaptureQuality; pixelKey:string;
   /** Original classifier output, before later border rejection overwrites its reason. */
   preBorder?:PreBorderEvidence;
   /** Display-only possible obstruction, never an identity or completion fact. */
   occlusionAdvisory?:true;
   /** Scheduling hint only, never identity, source or confirmed field evidence. */
   fieldRevision?:string } & ReturnType<typeof raster.features>;
 type LocalCell = Omit<Cell,'image'|'ownedPixels'>&{image?:never;ownedPixels:PixelRaster};
 const cache = new ExactPixelCache<Omit<Cell,'image'|'ownedPixels'>>();
 // Pending advisory work is attached to the immutable padded-pixel cache
 // entry's object lifetime; it never affects cached quality or recognition.
 const advisoryPending=new WeakSet<object>();
 const probe=reuseExact&&reuseScroll?createGridScrollProbe():undefined;
 let stats={rowShift:null as number|null,shifted:0,moveCompared:0,moveMatched:0,exact:0,moved:0,inspected:0,probeMs:0,gridReadbacksSaved:0,cropReadbacksSaved:0,localPixelCrops:0,exactRegionCopiesSaved:0};
 // Optional local diagnostic: neither matches nor profile data are evidence
 // of card identity, input completeness, or the cost without instrumentation.
 let moveMeasurement={lookups:0,eligible:0,bytesCompared:0,elapsedMs:0};
 let label: ReturnType<typeof createLabelReader<T>> | undefined;
 const acquireInternal=(frame:T, layout:Layout, reuse?:AcquisitionRasterReuse,localCropPixels=false):(Cell|LocalCell)[] => {
  label ??= createLabelReader(make);
  const context = rasterContext(frame);
  const measured=reuse?requireMeasuredRaster(reuse.measuredRaster,frame.width,frame.height):undefined;
  const extract=(region:{data:Uint8ClampedArray;width:number;height:number}|undefined,content:Box,left:number,top:number)=>
    reusePixels&&region?integerCropPixels(region.data,region.width,region.height,
      {...content,x:content.x-left,y:content.y-top}):undefined;
  // Local output is only a lossless subset of this call's actual Canvas ROI.
  // It carries no source binding or receipt and never bypasses label resampling.
  const localPixels=(pixels:Uint8ClampedArray|undefined,content:Box,box:Box)=>
    localCropPixels&&layout.scale===1&&content.width===140&&content.height===210&&
    Object.values(box).every(Number.isInteger)&&insideCard(content,{x:0,y:0,width:frame.width,height:frame.height})&&
    insideCard(box,layout.area)&&pixels&&opaqueCardPixels(pixels)?pixels:undefined;
  const deliver=(fields:Omit<Cell,'image'|'ownedPixels'>,region:{data:Uint8ClampedArray;width:number;height:number}|undefined,left:number,top:number):Cell|LocalCell=>{
    const extracted=localCropPixels||reuse?.ownCardPixels?extract(region,fields.content,left,top):undefined;
    const local=localPixels(extracted,fields.content,layout.cells[fields.slot]);
    if(local){stats.localPixelCrops++;return {...fields,ownedPixels:ownedCardRaster(local,140,210)};}
    const image=raster.crop(frame,fields.content);
    if(!reuse?.ownCardPixels)return {...fields,image};
    const opaque=extracted&&opaqueCardPixels(extracted);
    const pixels=opaque?extracted:rasterContext(image).getImageData(0,0,image.width,image.height).data;
    if(opaque)stats.cropReadbacksSaved++;
    return {...fields,image,ownedPixels:ownedCardRaster(pixels,image.width,image.height)};
  };
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
  // Reuse the actual full readback when available. Ordinary probe-enabled
  // acquisition reads one shared grid, then owns each padded pixel subregion.
  const shared=probe&&valid.length?measured??context.getImageData(origin.x,origin.y,right-origin.x,bottom-origin.y):undefined;
  const started=performance.now(),rowShift=shared?probe!(shared,measured?{x:0,y:0}:origin,layout,frame.width,frame.height):null;
  stats={rowShift,shifted:Number(rowShift!==null&&rowShift!==0),moveCompared:0,moveMatched:0,exact:0,moved:0,inspected:0,probeMs:performance.now()-started,
    gridReadbacksSaved:Number(!!(measured&&probe&&valid.length)),cropReadbacksSaved:0,localPixelCrops:0,exactRegionCopiesSaved:0};
  if(measureMoveReuse)moveMeasurement={lookups:0,eligible:0,bytesCompared:0,elapsedMs:0};
  // Keep the preceding grid alive until all source slots have been consulted.
  const prior=rowShift?cache.snapshot():undefined;
  // Limit extra work to four slots per acquisition and rotate even without an
  // exact cache. Deferred advisory work does not prevent normal quality cache
  // reuse and is resumed only after a complete padded RGBA cache comparison.
  const advisoryStart=advisoryCursor%Math.max(1,layout.cells.length);
  advisoryCursor=(advisoryStart+4)%Math.max(1,layout.cells.length);
  const advisoryTurn=(slot:number)=>(slot-advisoryStart+layout.cells.length)%layout.cells.length<4;
  const checkAdvisory=(source:{data:Uint8ClampedArray;width:number;height:number},crop:Uint8ClampedArray,
    cropWidth:number,cropHeight:number,content:Box,left:number,top:number,sides:number[])=>{
    const candidate=lowerPanelCandidate(crop,cropWidth,cropHeight,sides).candidate;
    const relative={...content,x:content.x-left,y:content.y-top};
    return !!candidate&&panelCrossesCardEdge(source.data,source.width,source.height,relative,candidate,'left').status==='crosses'&&
      panelCrossesCardEdge(source.data,source.width,source.height,relative,candidate,'right').status==='crosses';
  };
  const continueAdvisory=(fields:Omit<Cell,'image'|'ownedPixels'>,
    region:{data:Uint8ClampedArray;width:number;height:number}|undefined,left:number,top:number,slot:number)=>{
    if(!advisoryPending.has(fields)||!advisoryTurn(slot)||!region)return;
    const crop=extract(region,fields.content,left,top);if(!crop)return;
    advisoryPending.delete(fields);
    if(checkAdvisory(region,crop,fields.content.width,fields.content.height,fields.content,left,top,fields.borderSides))
      fields.occlusionAdvisory=true;
  };
  return layout.cells.map((box, slot) => {
    const bounds=regions[slot],{left,top,width,height}=bounds;
    let content = box, preview = box, alignment = 0, intact = false;
    let borderSides = [0, 0, 0, 0];
    let sourcePixels: Uint8ClampedArray | undefined, key = '';
    let region: {data:Uint8ClampedArray;width:number;height:number} | undefined;
    let sameSlotChecked=false;
    if (width > 0 && height > 0 && insideCard(box, { x: 0, y: 0, width: frame.width, height: frame.height })) {
      // Only ordinary integer-coordinate transport may skip the temporary region.
      // Canvas still creates the actual current-frame crop on every hit.
      if(reuseExact&&shared&&!measured&&!localCropPixels&&!reuse?.ownCardPixels&&
        Object.values(box).every(Number.isSafeInteger)&&insideCard(box,layout.area)){
        const previous=cache.getRectangle(slot,bounds.key,shared.data,shared.width,shared.height,
          left-origin.x,top-origin.y,width,height);
        if(previous?.matched){
          // The expensive copy is needed only when this exact entry's deferred
          // advisory has its turn; all other cache hits retain the fast path.
          const needsAdvisory=advisoryPending.has(previous.value)&&advisoryTurn(slot);
          const deferredRegion=needsAdvisory?pixelRegion(shared,left-origin.x,top-origin.y,width,height):undefined;
          continueAdvisory(previous.value,deferredRegion,left,top,slot);
          experiment?.match(previous.value,slot,box,bounds,frame,layout,0);stats.exact++;
          if(!deferredRegion)stats.exactRegionCopiesSaved++;
          return deliver(previous.value,deferredRegion,left,top);
        }
        sameSlotChecked=previous?.matched===false;
      }
      region = (measured?pixelRegion(measured,left,top,width,height):shared?pixelRegion(shared,left-origin.x,top-origin.y,width,height):undefined)??context.getImageData(left, top, width, height);
      if (reuseExact) {
        sourcePixels = region.data;
        key = bounds.key;
        const previous = sameSlotChecked?undefined:cache.get(slot,key,sourcePixels);
        if(previous){continueAdvisory(previous,region,left,top,slot);experiment?.match(previous,slot,box,bounds,frame,layout,0);stats.exact++;return deliver(previous,region,left,top);}
        const oldSlot=slot+(rowShift??0)*10,oldBox=layout.cells[oldSlot];
        if(prior&&oldBox&&oldBox.x===box.x&&oldBox.width===box.width&&oldBox.height===box.height&&
          insideCard(box,layout.area)&&insideCard(oldBox,layout.area)){
          const oldBounds=regions[oldSlot];
          const samePadding=oldBounds.width===width&&oldBounds.height===height&&
            oldBox.x-oldBounds.left===box.x-left&&oldBox.y-oldBounds.top===box.y-top;
          if(samePadding)stats.moveCompared++;
          let old:ReturnType<typeof prior.get>;
          if(samePadding&&measureMoveReuse){
            const start=performance.now(),measurement=prior.getMeasured(oldSlot,oldBounds.key,sourcePixels);
            moveMeasurement.elapsedMs+=performance.now()-start;moveMeasurement.lookups++;
            moveMeasurement.eligible+=Number(measurement.eligible);moveMeasurement.bytesCompared+=measurement.bytesCompared;
            old=measurement.value;
          } else old=samePadding?prior.get(oldSlot,oldBounds.key,sourcePixels):undefined;
          if(old)stats.moveMatched++;
          const dy=box.y-oldBox.y;
          // An integer pixel translation preserves Canvas resampling phase.
          // Full padded RGBA equality also covers names, counters and overlays.
          if(old&&old.intact&&Number.isInteger(dy)){
            const moved={...old,slot,content:{...old.content,y:old.content.y+dy},preview:{...old.preview,y:old.preview.y+dy}};
            experiment?.match(old,slot,box,bounds,frame,layout,dy);
            experiment?.store(moved,slot,box,bounds,frame,layout);
            cache.setOwned(slot,key,sourcePixels,moved);stats.moved++;
            return deliver(moved,region,left,top);
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
    // Integer, unscaled crops are already present in the border readback.
    // Fractional coordinates, resampling and clipped edges retain Canvas.
    const extracted = extract(region,content,left,top);
    const local=localPixels(extracted,content,box),image=local?undefined:raster.crop(frame,content);
    const imageWidth=image?.width??140,imageHeight=image?.height??210;
    const pixels=extracted ?? rasterContext(image!).getImageData(0,0,imageWidth,imageHeight).data;
    const labelVisible=reusePixels && imageWidth===140 && imageHeight===210
      ? hasNamePixels(pixels,(14*140+6)*4,140) : label!(image!);
    const complete=insideCard(content,{x:0,y:0,width:frame.width,height:frame.height})&&insideCard(box,layout.area);
    const quality=inspectCapture(pixels,imageWidth,imageHeight,complete,labelVisible,intact,alignment>=.8);
    const preBorder=preBorderEvidence(quality);
    let occlusionAdvisory:true|undefined,advisoryDeferred=false;
    // Only exact integer subsets from this very same padded source raster can
    // be compared with both neighboring edges. A negative or skipped result
    // cannot prove visibility. This deliberately does not change quality.
    if(complete&&!intact&&preBorder.kind==='moving'&&region&&extracted&&
      imageWidth===content.width&&imageHeight===content.height&&
      imageWidth<=280&&imageHeight<=420&&
      borderSides[2]>=.85&&Math.max(borderSides[0],borderSides[1])>=.75&&borderSides[3]<.35){
      if(!advisoryTurn(slot))advisoryDeferred=true;
      else {
        if(checkAdvisory(region,extracted,imageWidth,imageHeight,content,left,top,borderSides))occlusionAdvisory=true;
      }
    }
    if(complete&&!intact&&quality.reason!=='미보유 카드 뒷면 · 빈 슬롯') {
      quality.usable=false;
      const sides=['왼쪽','오른쪽','위','아래'].filter((_,side)=>borderSides[side]<.85);
      quality.reason='카드 테두리 불완전 · '+sides.join('/')+' · 재관측 대기';
    }
    // Compare raw field pixels in the already-owned bounded padded cache. The
    // portrait may animate without reopening fields, while even one changed
    // digit/alpha byte gets a new scheduling revision. No image is copied/read
    // back here and this subset match never reuses the full crop's pixelKey.
    let fieldRevision:string|undefined;
    const fieldRegions=region&&fieldPixelRegions({...content,x:content.x-left,y:content.y-top},region.width,region.height);
    if(sourcePixels&&fieldRegions) {
      const sameContent=(old:Omit<Cell,'image'|'ownedPixels'>,dy=0)=>old.intact&&intact&&
        old.content.x===content.x&&old.content.y+dy===content.y&&
        old.content.width===content.width&&old.content.height===content.height;
      const oldSlot=slot+(rowShift??0)*10,oldBox=layout.cells[oldSlot];
      if(prior&&oldBox&&oldBox.x===box.x&&oldBox.width===box.width&&oldBox.height===box.height&&
        insideCard(box,layout.area)&&insideCard(oldBox,layout.area)) {
        const oldBounds=regions[oldSlot],dy=box.y-oldBox.y;
        const samePadding=oldBounds.width===width&&oldBounds.height===height&&
          oldBox.x-oldBounds.left===box.x-left&&oldBox.y-oldBounds.top===box.y-top;
        if(samePadding&&Number.isInteger(dy))fieldRevision=prior.getRegions(oldSlot,oldBounds.key,sourcePixels,width,
          fieldRegions,old=>sameContent(old,dy))?.fieldRevision;
      }
      fieldRevision??=cache.getRegions(slot,key,sourcePixels,width,fieldRegions,sameContent)?.fieldRevision;
    }
    // This key survives only the exact RGBA/geometry cache above, never fuzzy
    // portrait deduplication. A changed byte or crop creates a different key.
    const fields={ slot, content, preview, alignment, intact, complete, borderSides, labelVisible, quality, preBorder,
      ...(occlusionAdvisory?{occlusionAdvisory}:{}),
      pixelKey:`${pixelNamespace}/${++pixelSequence}`,fieldRevision:fieldRevision??`${pixelNamespace}/fields/${++fieldSequence}`,
      ...(image?raster.features(image,pixels):observationPixels(pixels,imageWidth,imageHeight)) };
    const result:Cell|LocalCell=local?{...fields,ownedPixels:ownedCardRaster(local,140,210)}:{...fields,image:image!};
    if(local)stats.localPixelCrops++;
    if(reuse?.ownCardPixels) {
      // Fractional/scaled/clipped crops already used the actual cropped Canvas.
      // For transparent integer crops preserve that Canvas transport as well.
      const needsReadback=extracted&&!opaqueCardPixels(extracted);
      const transportPixels=needsReadback
        ?rasterContext(image!).getImageData(0,0,imageWidth,imageHeight).data:pixels;
      result.ownedPixels=ownedCardRaster(transportPixels,imageWidth,imageHeight);
      if(!needsReadback)stats.cropReadbacksSaved++;
    }
    if (sourcePixels && content.x >= left+1 && content.y >= top+1 &&
        content.x+content.width <= left+width-1 && content.y+content.height <= top+height-1) {
      const {image: _image,ownedPixels: _ownedPixels,...fields}=result;
      if(advisoryDeferred)advisoryPending.add(fields);
      experiment?.store(fields,slot,box,bounds,frame,layout);
      // getImageData allocated this region. Nothing mutates or transfers it;
      // let the bounded cache own it instead of copying every fresh card again.
      cache.setOwned(slot,key,sourcePixels,fields);
    }
    return result;
  });
 };
 const acquire=(frame:T,layout:Layout,reuse?:AcquisitionRasterReuse)=>acquireInternal(frame,layout,reuse) as Cell[];
 return Object.assign(acquire,{stats:()=>({...stats,...(measureMoveReuse?{moveMeasurement:{...moveMeasurement}}:{})}),
  localPixels:(frame:T,layout:Layout)=>acquireInternal(frame,layout,undefined,true)});
}
export function createCardAcquirer<T extends Raster>(make: (width:number,height:number)=>T, reuseExact = false, reusePixels = true, reuseScroll = true) {
 return createCardAcquirerCore(make,reuseExact,reusePixels,reuseScroll);
}
/** Development measurement only. No live worker is wired to this factory. */
export function createMeasuredMoveAcquirer<T extends Raster>(make:(width:number,height:number)=>T) {
 if(import.meta.env&&!import.meta.env.DEV)throw Error('Move profiling is available only in development');
 return createCardAcquirerCore(make,true,true,true,undefined,true);
}
/** Isolated development experiment. Frame IDs must be strictly increasing per
 * instance and refer to the actual invocation; this API does not bind a worker
 * response or an ObservationSource and must not change recognition decisions. */
export function createExperimentalReceiptAcquirer<T extends Raster>(make:(width:number,height:number)=>T, reuseScroll=true) {
 const experiment=new ExactReceiptExperiment();
 let acquire=createCardAcquirerCore(make,true,true,reuseScroll,experiment);
 return {
  acquire(frameId:number,frame:T,layout:Layout,reuse?:AcquisitionRasterReuse) {
   // A supplied raster is only shape-checked, not authenticated as pixels of
   // this frame. Until ownership is bound, evidence requires our own readback.
   if(reuse)throw new Error('Experimental receipts do not accept externally supplied rasters');
   experiment.begin(frameId,frame,layout);
   try {const cells=acquire(frame,layout);return {cells,receipts:experiment.finish()};}
   catch(error){
    // A failed invocation can leave cached pixels behind after its source
    // lineage is invalidated. Recreate both cache and scroll probe so the
    // next successful frame becomes a new origin, never a stale cache hit.
    experiment.abort();
    acquire=createCardAcquirerCore(make,true,true,reuseScroll,experiment);
    throw error;
   }
  },
  owns:(receipt:ExperimentalExactReceipt)=>experiment.owns(receipt),
  stats:()=>acquire.stats(),
  close:()=>experiment.close(),
 };
}
export const acquireCards=createCardAcquirer((width,height)=>{
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;
});
