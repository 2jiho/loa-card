import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCardAcquirer} from '../src/features/card-scanner/card-acquisition';
import type {Layout} from '../src/features/card-scanner/detector';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';

type Sample={name:string;width:number;height:number;box:{x:number;y:number;width:number;height:number};rgba:string};
const samples=JSON.parse(readFileSync(new URL('./fixtures/border-integrity-samples.json',import.meta.url),'utf8')) as Sample[];

/** A byte-backed CPU reference, not an assertion about browser/GPU resampling.
 * Noninteger drawImage uses a deterministic nearest sample. Nonopaque source
 * deliberately incurs premultiplication rounding so bypassing Canvas is visible. */
class Canvas {
  private w:number;private h:number;data:Uint8ClampedArray;
  reads:{x:number;y:number;width:number;height:number}[]=[];draws:number[][]=[];
  context:{globalCompositeOperation:string;getImageData:(x:number,y:number,w:number,h:number)=>{width:number;height:number;data:Uint8ClampedArray};
    putImageData:(image:{data:Uint8ClampedArray;width:number;height:number},x:number,y:number)=>void;
    clearRect:(x:number,y:number,w:number,h:number)=>void;drawImage:(source:Canvas,...values:number[])=>void};
  constructor(width:number,height:number){
    this.w=width;this.h=height;this.data=new Uint8ClampedArray(width*height*4);
    this.context={globalCompositeOperation:'source-over',getImageData:(x,y,width,height)=>{
      x=Math.trunc(x);y=Math.trunc(y);width=Math.trunc(width);height=Math.trunc(height);this.reads.push({x,y,width,height});
      const data=new Uint8ClampedArray(width*height*4);
      for(let row=0;row<height;row++)for(let col=0;col<width;col++)if(x+col>=0&&y+row>=0&&x+col<this.w&&y+row<this.h){
        const at=((y+row)*this.w+x+col)*4;data.set(this.data.subarray(at,at+4),(row*width+col)*4);
      }
      return {width,height,data};
    },putImageData:(image,x,y)=>{
      for(let row=0;row<image.height;row++)for(let col=0;col<image.width;col++){
        const to=((y+row)*this.w+x+col)*4,from=(row*image.width+col)*4;
        this.data.set(image.data.subarray(from,from+4),to);
      }
    },clearRect:(x,y,width,height)=>{
      for(let row=y;row<y+height;row++)for(let col=x;col<x+width;col++)if(col>=0&&row>=0&&col<this.w&&row<this.h)
        this.data.fill(0,(row*this.w+col)*4,(row*this.w+col+1)*4);
    },drawImage:(source,...values)=>{
      this.draws.push(values);
      const [sx,sy,sw,sh,dx,dy,dw,dh]=values.length===2?[0,0,source.width,source.height,...values,source.width,source.height]:values;
      if(this.context.globalCompositeOperation==='copy')this.data.fill(0);
      for(let y=Math.max(0,Math.ceil(dy));y<Math.min(this.h,Math.ceil(dy+dh));y++)
        for(let x=Math.max(0,Math.ceil(dx));x<Math.min(this.w,Math.ceil(dx+dw));x++){
          const px=Math.floor(sx+(x-dx+.5)*sw/dw),py=Math.floor(sy+(y-dy+.5)*sh/dh),to=(y*this.w+x)*4;
          if(px<0||py<0||px>=source.width||py>=source.height)continue;
          const from=(py*source.width+px)*4,alpha=source.data[from+3];
          for(let c=0;c<3;c++)this.data[to+c]=alpha?Math.round(Math.round(source.data[from+c]*alpha/255)*255/alpha):0;
          this.data[to+3]=alpha;
        }
    }};
  }
  get width(){return this.w;}set width(value:number){this.w=value;this.data=new Uint8ClampedArray(value*this.h*4);}
  get height(){return this.h;}set height(value:number){this.h=value;this.data=new Uint8ClampedArray(value*this.w*4);}
  getContext(){return this.context;}
  transferToImageBitmap(){const result={width:this.w,height:this.h,data:this.data.slice(),close(){}};this.data.fill(0);return result;}
}
const make=(width:number,height:number)=>new Canvas(width,height) as unknown as OffscreenCanvas;
const acquirer=(reuseExact=true,reusePixels=true,reuseScroll=true)=>createCardAcquirer(make,reuseExact,reusePixels,reuseScroll);
const layoutFor=(frame:Canvas,cells:Layout['cells'],scale=1)=>({cells,scale,area:{x:0,y:0,width:frame.width,height:frame.height}} as Layout);
function source(sample=samples[0]){
  const frame=new Canvas(sample.width,sample.height);frame.data.set(Buffer.from(sample.rgba,'base64'));
  return {frame,layout:layoutFor(frame,[{...sample.box}])};
}
const measured=(frame:Canvas)=>({width:frame.width,height:frame.height,data:frame.data.slice()});
type Cell=ReturnType<ReturnType<typeof acquirer>>[number];
type LocalCell=ReturnType<ReturnType<typeof acquirer>['localPixels']>[number];
const fields=({image:_image,ownedPixels:_owned,pixelKey:_key,fieldRevision:_revision,...cell}:Cell|LocalCell)=>cell;
const canvasPixels=(cell:Cell)=>(cell.image as unknown as Canvas).context.getImageData(0,0,cell.image.width,cell.image.height).data;
function parity(control:Cell[],optimized:Cell[]){
  assert.equal(control.length,optimized.length);
  for(let i=0;i<control.length;i++){
    assert.deepEqual(fields(optimized[i]),fields(control[i]));
    assert.deepEqual(optimized[i].ownedPixels?.data,canvasPixels(control[i]));
    assert.deepEqual(optimized[i].ownedPixels?.data,canvasPixels(optimized[i]));
  }
}

function localParity(control:Cell[],optimized:LocalCell[]){
  assert.equal(control.length,optimized.length);
  for(let i=0;i<control.length;i++){
    assert.deepEqual(fields(optimized[i]),fields(control[i]));
    assert.deepEqual(optimized[i].ownedPixels?.data??canvasPixels(optimized[i] as Cell),canvasPixels(control[i]));
  }
}

test('local ROI output preserves all real sample fields and skips supported worker crop canvases without a measured raster',()=>{
  for(const sample of samples){
    const {frame,layout}=source(sample),allocated:Canvas[]=[],optimized=createCardAcquirer((w,h)=>{
      const canvas=new Canvas(w,h);allocated.push(canvas);return canvas as unknown as OffscreenCanvas;
    },true),before=frame.data.slice();
    const expected=acquirer()(frame as unknown as OffscreenCanvas,layout);
    frame.reads.length=0;
    const actual=optimized.localPixels(frame as unknown as OffscreenCanvas,layout);
    localParity(expected,actual);assert.equal(actual[0].image,undefined,sample.name);
    assert.equal(allocated.length,1,'only the reusable label raster is allocated');
    assert.equal(allocated[0].draws.length,0,'supported label analysis reads the existing pixels');
    assert.equal(frame.reads.length,1,'only the existing union ROI is read');
    assert.deepEqual(frame.data,before);assert.notEqual(actual[0].ownedPixels!.data.buffer,frame.data.buffer);
    assert.equal(optimized.stats().localPixelCrops,1);
    assert.equal(optimized.stats().gridReadbacksSaved,0);assert.equal(optimized.stats().cropReadbacksSaved,0);
  }
});

test('local exact cache deliveries own fresh mutable transferable crops and retain baseline caller shape',()=>{
  const {frame,layout}=source(),optimized=acquirer(),control=acquirer(),before=frame.data.slice();
  let key='';
  for(let iteration=0;iteration<3;iteration++){
    const actual=optimized.localPixels(frame as unknown as OffscreenCanvas,layout),cell=actual[0];
    localParity(control(frame as unknown as OffscreenCanvas,layout),actual);
    if(iteration){assert.equal(optimized.stats().exact,1);assert.equal(cell.pixelKey,key);}
    key=cell.pixelKey;cell.ownedPixels!.data[0]^=255;
    const moved=structuredClone(cell.ownedPixels!,{transfer:[cell.ownedPixels!.data.buffer]});
    assert.equal(cell.ownedPixels!.data.byteLength,0);assert.equal(moved.data.byteLength,140*210*4);
    assert.deepEqual(frame.data,before,'output mutation and transfer do not touch the source or padded cache');
  }
  const ordinary=optimized(frame as unknown as OffscreenCanvas,layout)[0];
  assert.ok(ordinary.image);assert.equal(Object.hasOwn(ordinary,'ownedPixels'),false);
  assert.equal(ordinary.pixelKey,key);assert.equal(optimized.stats().localPixelCrops,0);
});

test('all real rarity and tooltip samples preserve geometry, quality, feature and transport bytes',()=>{
  for(const sample of samples){
    const {frame,layout}=source(sample),control=acquirer(),optimized=acquirer(),proof=measured(frame),before=proof.data.slice();
    const expected=control(frame as unknown as OffscreenCanvas,layout),actual=optimized(frame as unknown as OffscreenCanvas,layout,{measuredRaster:proof,ownCardPixels:true});
    parity(expected,actual);assert.deepEqual(proof.data,before);assert.equal(optimized.stats().gridReadbacksSaved,1);
    assert.equal(optimized.stats().cropReadbacksSaved,1,sample.name);
  }
});

test('complete retains the original nominal grid boundary test, even when the refined crop fits',()=>{
 const {frame,layout}=source(),nominal=layout.cells[0];
 const clipped={...layout,area:{...layout.area,x:nominal.x+1,width:layout.area.width-nominal.x-1}};
 const cell=acquirer()(frame as unknown as OffscreenCanvas,clipped)[0];
 assert.ok(cell.content.x>=0&&cell.content.y>=0&&cell.content.x+cell.content.width<=frame.width&&cell.content.y+cell.content.height<=frame.height);
 assert.equal(cell.complete,false);assert.equal(cell.quality.usable,false);assert.equal(cell.quality.reason,'화면 경계에서 카드 잘림');
});

test('exact cached cells preserve authoritative completeness without recomputation',()=>{
 const {frame,layout}=source(),acquire=acquirer();
 const first=acquire(frame as unknown as OffscreenCanvas,layout)[0];
 const again=acquire(frame as unknown as OffscreenCanvas,layout)[0];
 assert.equal(typeof first.complete,'boolean');assert.equal(again.complete,first.complete);
 assert.equal(again.pixelKey,first.pixelKey);assert.equal(acquire.stats().exact,1);
});

test('field revisions preserve raw sparse changes while ignoring only pixels outside the three field regions',()=>{
 const {frame,layout}=source(),acquire=acquirer();
 const first=acquire(frame as unknown as OffscreenCanvas,layout)[0],before=frame.data.slice();
 assert.equal(first.intact,true);assert.equal(first.content.width,140);assert.equal(first.content.height,210);
 assert.ok(first.fieldRevision);
 const exact=acquire(frame as unknown as OffscreenCanvas,layout)[0];
 assert.equal(exact.fieldRevision,first.fieldRevision);assert.equal(exact.pixelKey,first.pixelKey);
 // Change the portrait only, leaving the complete field masks byte-identical.
 const portraitAt=((first.content.y+100)*frame.width+first.content.x+30)*4;
 frame.data[portraitAt]^=1;frame.reads.length=0;
 const portrait=acquire(frame as unknown as OffscreenCanvas,layout)[0];
 assert.notEqual(portrait.pixelKey,first.pixelKey);assert.equal(portrait.fieldRevision,first.fieldRevision);
 assert.equal(frame.reads.length,1,'field comparisons add no Canvas readback');
 frame.data[portraitAt]^=1;
 let previousRevision=portrait.fieldRevision;
 // A one-byte change can be lost by area averaging, and alpha is absent from
 // the RGB features entirely. Both must still create a new raw-field revision.
 for(const [x,y,channel] of [[20,20,0],[70,150,1],[30,185,2],[20,20,3]]){
  const at=((first.content.y+y)*frame.width+first.content.x+x)*4+channel;
  frame.data[at]^=1;const changedInput=frame.data.slice();frame.reads.length=0;
  const changed=acquire(frame as unknown as OffscreenCanvas,layout)[0];
  assert.notEqual(changed.fieldRevision,previousRevision,`field ${x}/${y}/${channel}`);
  if(channel===3)assert.deepEqual(changed.feature,first.feature,'alpha changed even though all RGB summaries are identical');
  assert.equal(frame.reads.length,1);assert.deepEqual(frame.data,changedInput,'acquisition does not mutate input pixels');
  previousRevision=changed.fieldRevision;
  const repeat=acquire(frame as unknown as OffscreenCanvas,layout)[0];
  assert.equal(repeat.fieldRevision,changed.fieldRevision);assert.equal(repeat.pixelKey,changed.pixelKey);
  frame.data[at]^=1;
 }
 assert.deepEqual(frame.data,before);
});

test('field revision does not survive a changed crop geometry or a different acquirer namespace',()=>{
 const {frame,layout}=source(),acquire=acquirer();
 const first=acquire(frame as unknown as OffscreenCanvas,layout)[0];
 const other=acquirer()(frame as unknown as OffscreenCanvas,layout)[0];
 assert.notEqual(other.fieldRevision,first.fieldRevision);
 const changed=acquire(frame as unknown as OffscreenCanvas,{...layout,cells:[{...layout.cells[0],width:139.5}]})[0];
 assert.notEqual(changed.fieldRevision,first.fieldRevision);
});

test('opaque integer grid reuse performs no grid or transport Canvas readback',()=>{
  const {frame,layout}=source(),optimized=acquirer(),proof=measured(frame);
  const cells=optimized(frame as unknown as OffscreenCanvas,layout,{measuredRaster:proof,ownCardPixels:true});
  assert.deepEqual(frame.reads,[]);
  assert.deepEqual((cells[0].image as unknown as Canvas).reads,[]);
  assert.equal(cells[0].ownedPixels?.data.buffer===proof.data.buffer,false);
  assert.equal(cells[0].ownedPixels?.data.byteLength,140*210*4);
  const normal=acquirer()(frame as unknown as OffscreenCanvas,layout);
  assert.equal(Object.hasOwn(normal[0],'ownedPixels'),false,'ordinary caller shape is preserved');assert.equal(frame.reads.length,1);
});

test('exact cache survives repeated transfer without retaining a transient crop or detaching measured pixels',()=>{
  const {frame,layout}=source(),optimized=acquirer(),proof=measured(frame),full=proof.data.slice();
  let previousKey='';
  for(let iteration=0;iteration<3;iteration++){
    const cells=optimized(frame as unknown as OffscreenCanvas,layout,{measuredRaster:proof,ownCardPixels:true}),cell=cells[0];
    if(iteration){assert.equal(optimized.stats().exact,1);assert.equal(cell.pixelKey,previousKey);}
    previousKey=cell.pixelKey;const pixels=cell.ownedPixels!,before=pixels.data.slice();
    const moved=structuredClone(pixels,{transfer:[pixels.data.buffer]});assert.equal(pixels.data.byteLength,0);assert.deepEqual(moved.data,before);
    assert.deepEqual(proof.data,full);assert.equal(proof.data.byteLength,frame.width*frame.height*4);
  }
  const ordinary=optimized(frame as unknown as OffscreenCanvas,layout);
  assert.equal(Object.hasOwn(ordinary[0],'ownedPixels'),false,'the exact cache never persists a transferred raster field');
});

function grid(offset=0){
  const frame=new Canvas(1540,908),cells:Layout['cells']=[];frame.data.fill(20);
  for(let i=3;i<frame.data.length;i+=4)frame.data[i]=255;
  const template=source().frame;
  for(let row=0;row<4;row++)for(let column=0;column<10;column++){
    const x=10+column*152,y=10+row*222,id=(row+offset)*10+column;
    for(let py=0;py<222;py++)frame.data.set(template.data.subarray(py*152*4,(py+1)*152*4),((y-6+py)*frame.width+x-6)*4);
    for(let py=55;py<140;py++)for(let px=18;px<122;px++)frame.data.set([(id*73+37)%251,(id*103+13)%251,(id*31+91)%251,255],((y+py)*frame.width+x+px)*4);
    cells.push({x,y,width:140,height:210});
  }
  return {frame,layout:layoutFor(frame,cells)};
}

test('row-shift field selection checks translated raw pixels even when the portrait prevents full-crop reuse',()=>{
 const acquire=acquirer(),initial=grid(0),next=grid(1);
 const first=acquire(initial.frame as unknown as OffscreenCanvas,initial.layout);
 const box=next.layout.cells[0];
 next.frame.data[((box.y+100)*next.frame.width+box.x+30)*4]^=1;
 const changedInput=next.frame.data.slice(),second=acquire(next.frame as unknown as OffscreenCanvas,next.layout);
 assert.equal(acquire.stats().rowShift,1);
 assert.equal(acquire.stats().shifted,1);
 assert.ok(acquire.stats().moveCompared>acquire.stats().moveMatched,'one changed portrait byte prevents full translated reuse');
 assert.equal(acquire.stats().moved,acquire.stats().moveMatched);
 assert.notEqual(second[0].pixelKey,first[10].pixelKey,'the whole padded raster is different');
 assert.equal(second[0].fieldRevision,first[10].fieldRevision,'only exact translated field regions lend their scheduling revision');
 assert.deepEqual(next.frame.data,changedInput);
});

test('upward and downward row-shift cache deliveries each own fresh transport buffers',()=>{
  const control=acquirer(),optimized=acquirer();let previous:Cell[]=[];
  for(const offset of [0,1,3,1]){
    const {frame,layout}=grid(offset),proof=measured(frame),expected=control(frame as unknown as OffscreenCanvas,layout),
      actual=optimized(frame as unknown as OffscreenCanvas,layout,{measuredRaster:proof,ownCardPixels:true});
    parity(expected,actual);assert.equal(optimized.stats().rowShift,control.stats().rowShift);
    assert.equal(optimized.stats().moved,control.stats().moved);
    if(previous.length)assert.ok(optimized.stats().moved>=10,'at least one integral row reuses the exact padded cache');
    assert.equal(new Set(actual.map(cell=>cell.ownedPixels!.data.buffer)).size,40);
    for(const cell of actual)structuredClone(cell.ownedPixels,{transfer:[cell.ownedPixels!.data.buffer]});
    assert.equal(proof.data.byteLength,frame.width*frame.height*4);previous=actual;
  }
});

test('local row-shift deliveries retain exact metadata and independent output ownership',()=>{
  const control=acquirer(),optimized=acquirer();
  for(const offset of [0,1,3,1]){
    const {frame,layout}=grid(offset),expected=control(frame as unknown as OffscreenCanvas,layout),
      actual=optimized.localPixels(frame as unknown as OffscreenCanvas,layout);
    localParity(expected,actual);assert.equal(optimized.stats().rowShift,control.stats().rowShift);
    assert.equal(optimized.stats().moved,control.stats().moved);assert.equal(optimized.stats().localPixelCrops,40);
    assert.ok(actual.every(cell=>!cell.image));assert.equal(new Set(actual.map(cell=>cell.ownedPixels!.data.buffer)).size,40);
    for(const cell of actual)structuredClone(cell.ownedPixels!,{transfer:[cell.ownedPixels!.data.buffer]});
    assert.equal(frame.data.byteLength,frame.width*frame.height*4);
  }
});

test('local output retains Canvas transport for fractional scaled clipped and transparent inputs on fresh and cached delivery',()=>{
  for(const scenario of ['fractional-x','fractional-size','scaled','clipped','nominal-boundary','transparent']){
    const {frame,layout}=source(),box=layout.cells[0];
    if(scenario==='fractional-x')layout.cells[0]={...box,x:box.x+.5};
    if(scenario==='fractional-size')layout.cells[0]={...box,width:139.5};
    if(scenario==='scaled')layout.scale=2;
    if(scenario==='clipped')layout.cells[0]={...box,x:-2};
    if(scenario==='nominal-boundary')layout.area={...layout.area,x:box.x+1};
    if(scenario==='transparent')frame.data.set([1,7,11,100],(50*frame.width+50)*4);
    const control=acquirer(),optimized=acquirer();
    for(let iteration=0;iteration<2;iteration++){
      const expected=control(frame as unknown as OffscreenCanvas,layout),actual=optimized.localPixels(frame as unknown as OffscreenCanvas,layout);
      localParity(expected,actual);assert.ok(actual[0].image,scenario);assert.equal(actual[0].ownedPixels,undefined,scenario);
      assert.equal(optimized.stats().localPixelCrops,0,scenario);
    }
  }
});

test('fractional, scaled, boundary and partially clipped cells preserve actual Canvas crop bytes',()=>{
  const cases=[{x:6.5,y:6,width:140,height:210},{x:6,y:6.5,width:140,height:210},
    {x:6,y:6,width:139.5,height:209.5},{x:0,y:0,width:140,height:210},
    {x:12,y:12,width:140,height:210},{x:-2,y:6,width:140,height:210}];
  for(const scale of [.75,1,1.25,2])for(const box of cases){
    const {frame}=source(),layout=layoutFor(frame,[box],scale),control=acquirer(),optimized=acquirer(),proof=measured(frame);
    const expected=control(frame as unknown as OffscreenCanvas,layout),actual=optimized(frame as unknown as OffscreenCanvas,layout,{measuredRaster:proof,ownCardPixels:true});
    parity(expected,actual);
    if(!Object.values(box).every(Number.isInteger)||box.x<0)
      assert.equal((actual[0].image as unknown as Canvas).reads.length,2,'one fallback analysis read plus the parity read');
  }
});

test('actual scaled card geometry preserves existing rounding and label resampling',()=>{
  const original=source().frame;
  for(const scale of [.75,1.25,2]){
    const frame=new Canvas(Math.ceil(original.width*scale)+8,Math.ceil(original.height*scale)+8);
    frame.context.drawImage(original,0,0,original.width,original.height,4,4,original.width*scale,original.height*scale);
    const box={x:4+6*scale,y:4+6*scale,width:140*scale,height:210*scale},layout=layoutFor(frame,[box],scale),
      control=acquirer(),optimized=acquirer(),expected=control(frame as unknown as OffscreenCanvas,layout),
      actual=optimized(frame as unknown as OffscreenCanvas,layout,{measuredRaster:measured(frame),ownCardPixels:true});
    parity(expected,actual);
    assert.deepEqual([actual[0].ownedPixels!.width,actual[0].ownedPixels!.height],[Math.round(box.width),Math.round(box.height)]);
    if(scale!==2)assert.equal((actual[0].image as unknown as Canvas).reads.length,2,'fractional scaled geometry retains actual Canvas analysis pixels');
  }
});

test('nonopaque integer transport keeps the existing Canvas roundtrip on fresh and exact-cache results',()=>{
  const {frame,layout}=source(),at=((50*frame.width)+50)*4;frame.data.set([1,7,11,100],at);
  const optimized=acquirer(),control=acquirer();
  for(let iteration=0;iteration<2;iteration++){
    const expected=control(frame as unknown as OffscreenCanvas,layout),actual=optimized(frame as unknown as OffscreenCanvas,layout,{measuredRaster:measured(frame),ownCardPixels:true});
    parity(expected,actual);assert.equal(optimized.stats().cropReadbacksSaved,0);
    const px=((50-actual[0].content.y)*140+50-actual[0].content.x)*4;
    assert.notEqual(actual[0].ownedPixels!.data[px],1,'CPU fixture makes premultiplication bypass observable');
  }
});

test('empty layouts, no-owned-output and disabled legacy optimizations keep their boundaries',()=>{
  const {frame,layout}=source(),proof=measured(frame),optimized=acquirer();
  assert.deepEqual(optimized(frame as unknown as OffscreenCanvas,{...layout,cells:[]},{measuredRaster:proof,ownCardPixels:true}),[]);
  assert.equal(optimized.stats().gridReadbacksSaved,0);assert.equal(optimized.stats().cropReadbacksSaved,0);
  const result=optimized(frame as unknown as OffscreenCanvas,layout,{measuredRaster:proof});assert.equal(Object.hasOwn(result[0],'ownedPixels'),false);
  const control=acquirer(false,false,false),alternative=acquirer(false,false,false);
  parity(control(frame as unknown as OffscreenCanvas,layout),alternative(frame as unknown as OffscreenCanvas,layout,{measuredRaster:proof,ownCardPixels:true}));
  assert.throws(()=>optimized(frame as unknown as OffscreenCanvas,layout,{measuredRaster:{...proof,width:proof.width+1}}),/측정 픽셀/);
});

type WorkerBitmap={canvas:Canvas;bitmap:ReturnType<Canvas['transferToImageBitmap']>;closed:number};
async function worker(run:(runtime:{send:(data:unknown)=>Promise<void>;replies:any[];canvases:Canvas[];bitmaps:WorkerBitmap[];transfers:unknown[][]})=>Promise<void>,rejectDelivery=false){
  const names=['self','OffscreenCanvas','ImageData'],prior=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)])),
    replies:any[]=[],canvases:Canvas[]=[],bitmaps:WorkerBitmap[]=[],transfers:unknown[][]=[],scope=Object.assign(Object.create(globalThis),{onmessage:null as any,postMessage(value:any,options?:{transfer:unknown[]}){
      if(rejectDelivery&&value.cells)throw new Error('mock crop delivery failed');
      const moved=options?.transfer??[];transfers.push(moved);
      // Mock bitmaps retain their copied bytes; real ArrayBuffers still move.
      replies.push(structuredClone(value,{transfer:moved.filter((item):item is ArrayBuffer=>item instanceof ArrayBuffer)}));
    }});
  // Cold tsx's synchronous lexer reads standard constructors from worker self.
  assert.equal(scope.Int8Array,Int8Array);assert.equal(scope.Uint16Array,Uint16Array);assert.equal(scope.Math,Math);
  class WorkerCanvas extends Canvas{
    constructor(width:number,height:number){super(width,height);canvases.push(this);}
    override transferToImageBitmap(){
      const bitmap=super.transferToImageBitmap(),entry={canvas:this,bitmap,closed:0};
      Object.defineProperty(bitmap,'close',{enumerable:false,value:()=>{entry.closed++;}});bitmaps.push(entry);return bitmap;
    }
  }
  Object.defineProperty(globalThis,'self',{configurable:true,value:scope});
  Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:WorkerCanvas});
  Object.defineProperty(globalThis,'ImageData',{configurable:true,value:class{constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}}});
  try{const url=new URL('../src/features/card-scanner/acquisition-worker.ts',import.meta.url);url.searchParams.set('measured-test',crypto.randomUUID());
    await import(url.href);await run({send:data=>scope.onmessage({data}),replies,canvases,bitmaps,transfers});}
  finally{for(const [name,descriptor]of Object.entries(prior))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}
}

test('actual worker control and reuse keep source proof, transport bytes and transfer ownership identical',async()=>{
  await worker(async({send,replies,canvases})=>{
    const {frame,layout}=source(),hash=await pixelHash(Uint8Array.from(frame.data)),outputs:any[]=[];
    for(const [index,mode]of [false,true,true].entries()){
      const readsBefore=canvases.reduce((sum,canvas)=>sum+canvas.reads.length,0);
      await send({kind:'prepared',id:index+1,prepared:{width:frame.width,height:frame.height,pixels:new Uint8Array(frame.data),
        binding:{sourceFrameId:index+1,captureTime:1.5}},layout,pixelTransport:true,pixelProof:true,measuredRasterReuse:mode});
      const result=replies.at(-1);assert.equal(result.error,undefined);outputs.push(result);
      assert.equal(result.rasterReceipt.hash,hash);assert.equal(result.pixelProof.hash,hash);assert.deepEqual(result.pixelProof.sample,Array.from(frame.data.subarray(0,32)));
      assert.equal(Object.hasOwn(result.cells[0],'ownedPixels'),false);assert.equal(result.cells[0].pixels.data.byteLength,140*210*4);
      const count=canvases.reduce((sum,canvas)=>sum+canvas.reads.length,0)-readsBefore;
      assert.equal(count,mode?1:3,'only the full proof readback remains in the opaque measured case');
      if(mode){assert.equal(result.timing.gridReadbacksSaved,1);assert.equal(result.timing.cropReadbacksSaved,1);}
      else{assert.equal(result.timing.gridReadbacksSaved,undefined);assert.equal(result.timing.cropReadbacksSaved,undefined);}
    }
    for(const result of outputs.slice(1)){
      assert.deepEqual(result.cells[0].pixels,outputs[0].cells[0].pixels);
      const {pixels:_pixels,bitmap:_bitmap,previewBitmap:_preview,pixelKey:_key,fieldRevision:_revision,...metadata}=result.cells[0];
      const {pixels:_controlPixels,bitmap:_controlBitmap,previewBitmap:_controlPreview,pixelKey:_controlKey,fieldRevision:_controlRevision,...controlMetadata}=outputs[0].cells[0];
      assert.deepEqual(metadata,controlMetadata);
    }
  });
});

function mixedPreviewSource(){
  const good=source(samples[0]),covered=source(samples.at(-1)),frame=new Canvas(good.frame.width+covered.frame.width,good.frame.height);
  frame.context.drawImage(good.frame,0,0);frame.context.drawImage(covered.frame,good.frame.width,0);
  const absent={x:frame.width+1,y:frame.height+1,width:1,height:1};
  const layout={...layoutFor(frame,[good.layout.cells[0],{...covered.layout.cells[0],x:covered.layout.cells[0].x+good.frame.width}]),
    header:absent,growthPoints:absent,sort:absent,scrollbar:absent};
  return {frame,layout};
}

test('worker skips only rejected previews while retaining actual crops, features and metadata in both transports',async()=>{
  for(const pixelTransport of [false,true])await worker(async({send,replies,canvases,bitmaps,transfers})=>{
    const {frame,layout}=mixedPreviewSource(),expected=acquirer()(frame as unknown as OffscreenCanvas,layout);
    assert.deepEqual(expected.map(cell=>cell.quality.usable),[true,false]);
    const inputs:number[]=[];
    const input=()=>{const index=inputs.push(0)-1;return Object.assign(frame,{close(){inputs[index]++;}});};
    await send({id:1,bitmap:input(),layout,pixelTransport,patches:false});
    const baseline=replies.at(-1);assert.equal(baseline.error,undefined);
    const before=canvases.length,bitmapBefore=bitmaps.length;
    await send({id:2,bitmap:input(),layout,pixelTransport,patches:true});
    const result=replies.at(-1);assert.equal(result.error,undefined);assert.equal(result.id,2);assert.deepEqual(result.layout,layout);
    assert.deepEqual(inputs,[1,1]);assert.deepEqual(result.patches,[]);
    for(const [index,cell]of result.cells.entries()){
      const {bitmap,pixels,previewBitmap:_preview,...metadata}=cell;
      const {pixelKey:_expectedKey,...expectedMetadata}=fields(expected[index]);
      const {pixelKey:_key,fieldRevision:_revision,...actualMetadata}=metadata;
      assert.deepEqual(actualMetadata,expectedMetadata,'quality, geometry and actual feature vectors remain authoritative');
      assert.deepEqual((pixels??bitmap).data,canvasPixels(expected[index]));
      const {previewBitmap:_baselinePreview,...baselineCell}=baseline.cells[index];
      const {previewBitmap:_actualPreview,...actualCell}=cell;
      assert.deepEqual(actualCell,baselineCell,'preview selection cannot change transport bytes or the exact-pixel provenance key');
    }
    assert.ok(result.cells[0].previewBitmap);assert.equal(result.cells[1].previewBitmap,undefined);
    const allocated=canvases.slice(before),preview=allocated[2],box=expected[0].preview;
    assert.equal(allocated.length,3,'two actual crops and only the usable preview allocate canvases');
    assert.equal(allocated.reduce((sum,canvas)=>sum+canvas.draws.length,0),3,'the rejected preview adds no draw');
    assert.deepEqual([preview.width,preview.height],[Math.round(box.width),Math.round(box.height)]);
    assert.deepEqual(preview.draws,[[box.x,box.y,box.width,box.height,0,0,preview.width,preview.height]]);
    assert.equal(bitmaps.length-bitmapBefore,pixelTransport?1:3,'only the usable preview adds a bitmap transfer');
    assert.equal(transfers.at(-1)!.length,3);assert.ok(bitmaps.every(bitmap=>bitmap.closed===0),'successfully transferred bitmaps remain owned by the receiver');
  });
});

test('worker delivery failure closes every actual crop and usable preview bitmap once',async()=>{
  await worker(async({send,replies,bitmaps})=>{
    const {frame,layout}=mixedPreviewSource();let closed=0;
    await send({id:1,bitmap:Object.assign(frame,{close(){closed++;}}),layout,patches:true});
    assert.match(replies.at(-1).error,/mock crop delivery failed/);assert.equal(closed,1);
    assert.equal(bitmaps.length,3,'two actual crops and the usable preview exist at failure');
    assert.deepEqual(bitmaps.map(bitmap=>bitmap.closed),[1,1,1]);
  },true);
});

test('worker keeps identical fallback payloads and whole-source proof for fractional and transparent crops',async()=>{
  await worker(async({send,replies})=>{
    let id=0;
    for(const transparent of [false,true]){
      const {frame,layout}=source();
      if(transparent)frame.data.set([1,7,11,100],(50*frame.width+50)*4);
      else layout.cells[0]={...layout.cells[0],x:layout.cells[0].x+.5,width:139.5};
      const hash=await pixelHash(Uint8Array.from(frame.data)),outputs:any[]=[];
      for(const mode of [false,true]){
        id++;await send({kind:'prepared',id,prepared:{width:frame.width,height:frame.height,pixels:new Uint8Array(frame.data),
          binding:{sourceFrameId:id,captureTime:2}},layout,pixelTransport:true,measuredRasterReuse:mode});
        const result=replies.at(-1);assert.equal(result.error,undefined);outputs.push(result);
        assert.equal(result.rasterReceipt.hash,hash);assert.equal(result.pixelProof.hash,hash);
        assert.equal(Object.hasOwn(result.cells[0],'ownedPixels'),false);
      }
      assert.deepEqual(outputs[0].cells[0].pixels,outputs[1].cells[0].pixels);
      assert.equal(outputs[1].timing.gridReadbacksSaved,1);
      assert.equal(outputs[1].timing.cropReadbacksSaved,0,'exact cached fractional/transparent crops still need their transport Canvas readback');
    }
  });
});

test('worker rejects a nonboolean reuse switch before painting and leaves ordinary no-proof acquisition unchanged',async()=>{
  await worker(async({send,replies,canvases})=>{
    const {frame,layout}=source();
    for(const invalid of [0,1,'false',null,{}]){
      await send({kind:'prepared',id:1,prepared:{width:frame.width,height:frame.height,pixels:new Uint8Array(frame.data),binding:{sourceFrameId:1,captureTime:0}},
        layout,pixelTransport:true,measuredRasterReuse:invalid});
      assert.match(replies.at(-1).error,/재사용 옵션/);assert.equal(canvases[0].reads.length,0);
    }
    let closed=0;const bitmap=Object.assign(frame,{close(){closed++;}});
    await send({id:2,bitmap,layout,pixelTransport:true,measuredRasterReuse:true});
    const result=replies.at(-1);assert.equal(result.error,undefined);assert.equal(result.pixelProof,undefined);assert.equal(result.rasterReceipt,undefined);
    assert.equal(result.timing.gridReadbacksSaved,undefined);assert.equal(result.timing.cropReadbacksSaved,undefined);assert.equal(closed,1);
    assert.equal(canvases.reduce((sum,canvas)=>sum+canvas.reads.length,0),2,'ordinary input still reads one grid plus one transport crop');
  });
});

test('normal local worker output mixes owned crops and baseline bitmaps without full-frame proof or receipt',async()=>{
  await worker(async({send,replies,canvases,bitmaps,transfers})=>{
    const {frame,layout}=mixedPreviewSource();
    frame.data.set([1,7,11,100],(50*frame.width+source().frame.width+50)*4);
    let closed=0;const input=()=>Object.assign(frame,{close(){closed++;}});
    await send({id:1,bitmap:input(),layout});const baseline=replies.at(-1);
    const before=canvases.length,bitmapBefore=bitmaps.length,readsBefore=canvases.reduce((n,c)=>n+c.reads.length,0);
    await send({id:2,bitmap:input(),layout,localCropPixels:true});const actual=replies.at(-1);
    assert.equal(actual.error,undefined);assert.equal(actual.pixelProof,undefined);assert.equal(actual.rasterReceipt,undefined);
    assert.equal(actual.timing.localPixelCrops,1);assert.equal(actual.timing.rasterReadbackMs,undefined);
    assert.equal(actual.timing.gridReadbacksSaved,undefined);assert.equal(actual.timing.cropReadbacksSaved,undefined);
    assert.equal(canvases.length-before,1,'only the transparent fallback allocates a crop Canvas');
    assert.equal(bitmaps.length-bitmapBefore,1,'only the fallback constructs a bitmap');
    assert.equal(canvases.reduce((n,c)=>n+c.reads.length,0)-readsBefore,1,'the existing grid ROI is the only readback');
    assert.ok(actual.cells[0].pixels);assert.equal(actual.cells[0].bitmap,undefined);
    assert.ok(actual.cells[1].bitmap);assert.equal(actual.cells[1].pixels,undefined);
    assert.equal(transfers.at(-1)!.length,2);assert.equal(closed,2);
    for(let i=0;i<actual.cells.length;i++){
      const {bitmap,pixels,...fields}=actual.cells[i],{bitmap:reference,pixels:_referencePixels,...referenceFields}=baseline.cells[i];
      assert.deepEqual(fields,referenceFields,'exact cached metadata and pixel provenance are unchanged');
      assert.deepEqual((pixels??bitmap).data,reference.data);
    }
    const retained=actual.cells[0].pixels.data.slice();
    await send({id:3,bitmap:input(),layout,localCropPixels:true});
    assert.deepEqual(replies.at(-1).cells[0].pixels.data,retained,'delivery uses a new buffer after the previous transfer');
    assert.deepEqual(actual.cells[0].pixels.data,retained,'later calls never overwrite retained output');
  });
});

test('local worker option rejects malformed or non-normal requests before Canvas work',async()=>{
  await worker(async({send,replies,canvases})=>{
    const {frame,layout}=source();let closed=0;
    for(const invalid of [0,1,'true',null,{}]){
      await send({id:1,bitmap:Object.assign(frame,{close(){closed++;}}),layout,localCropPixels:invalid});
      assert.match(replies.at(-1).error,/로컬 카드 픽셀 옵션/);
    }
    for(const other of [{patches:true},{recordOnly:true},{kind:'prepared',prepared:{width:frame.width,height:frame.height,
      pixels:new Uint8Array(frame.data),binding:{sourceFrameId:1,captureTime:0}}}]){
      await send({id:2,...(!('prepared' in other)?{bitmap:Object.assign(frame,{close(){closed++;}})}:{}),layout,localCropPixels:true,...other});
      assert.match(replies.at(-1).error,/일반 Canvas 수집/);
    }
    assert.equal(closed,7);assert.equal(canvases.length,1);assert.equal(canvases[0].reads.length,0);assert.equal(canvases[0].draws.length,0);
  });
});
