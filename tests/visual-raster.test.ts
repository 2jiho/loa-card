import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createVisualRaster} from '../src/features/card-scanner/recognition/visual-raster';

type Bitmap={width:number;height:number;data:Uint8ClampedArray;fail?:boolean};

/** Minimal source-over raster model: catches stale transparent pixels and
 * resize mistakes; it is not an assertion about browser color conversion. */
class Canvas {
 private w:number;private h:number;data:Uint8ClampedArray;
 constructor(w:number,h:number){this.w=w;this.h=h;this.data=new Uint8ClampedArray(w*h*4);}
 get width(){return this.w;}
 set width(value:number){this.w=value;this.data=new Uint8ClampedArray(this.w*this.h*4);}
 get height(){return this.h;}
 set height(value:number){this.h=value;this.data=new Uint8ClampedArray(this.w*this.h*4);}
 getContext(){return {
  clearRect:()=>this.data.fill(0),
  drawImage:(source:Bitmap)=>{
   if(source.fail){this.data.fill(255);throw Error('draw failed');}
   for(let i=0;i<this.data.length;i+=4){
    const alpha=source.data[i+3]/255,oldAlpha=this.data[i+3]/255,outAlpha=alpha+oldAlpha*(1-alpha);
    for(let c=0;c<3;c++)this.data[i+c]=outAlpha?Math.round((source.data[i+c]*alpha+this.data[i+c]*oldAlpha*(1-alpha))/outAlpha):0;
    this.data[i+3]=Math.round(outAlpha*255);
   }
  },
  getImageData:()=>({data:this.data.slice()}),
 };}
}
const bitmap=(width:number,height:number,seed:number,alpha:number):Bitmap=>{
 const data=new Uint8ClampedArray(width*height*4);
 for(let i=0;i<data.length;i+=4){data[i]=(i+seed)%256;data[i+1]=(i/4+seed)%256;data[i+2]=seed;data[i+3]=alpha;}
 return {width,height,data};
};
const asBitmap=(value:Bitmap)=>value as unknown as ImageBitmap;
const make=()=>{
 const canvases:Canvas[]=[];
 const raster=createVisualRaster((w,h)=>{const canvas=new Canvas(w,h);canvases.push(canvas);return canvas as unknown as OffscreenCanvas;});
 return {raster,canvases};
};
function fresh(source:Bitmap){return make().raster.read(asBitmap(source)).pixels;}

test('reused worker raster matches a fresh draw through transparency, dimension changes and real crop inputs',()=>{
 const samples=JSON.parse(readFileSync(new URL('./fixtures/border-integrity-samples.json',import.meta.url),'utf8')) as Array<{width:number;height:number;rgba:string}>;
 const real=samples.slice(0,4).map(row=>({width:row.width,height:row.height,data:new Uint8ClampedArray(Buffer.from(row.rgba,'base64'))}));
 const sources=[bitmap(3,5,4,255),bitmap(3,5,140,0),bitmap(3,5,29,128),bitmap(6,2,17,64),...real,bitmap(3,5,8,255)];
 const {raster,canvases}=make();let saved:Uint8ClampedArray|undefined,savedBytes:Uint8ClampedArray|undefined;
 for(const source of sources){
  const result=raster.read(asBitmap(source));assert.deepEqual(result.pixels,fresh(source));
  if(saved)assert.deepEqual(saved,savedBytes,'readback is owned even after subsequent reuse');
  saved=result.pixels;savedBytes=result.pixels.slice();
 }
 assert.equal(canvases.length,1);
});

test('a failed draw cannot contaminate the next input and oversized inputs are not retained',()=>{
 const {raster,canvases}=make(),opaque=bitmap(2,2,230,255),transparent=bitmap(2,2,10,0);
 raster.read(asBitmap(opaque));
 assert.throws(()=>raster.read(asBitmap({...opaque,fail:true})),/draw failed/);
 assert.deepEqual(raster.read(asBitmap(transparent)).pixels,fresh(transparent));
 const large=bitmap(1025,1024,5,255);
 assert.deepEqual(raster.read(asBitmap(large)).pixels,fresh(large));
 assert.equal(canvases.length,2,'large raster is separate from the bounded reusable canvas');
 assert.deepEqual(raster.read(asBitmap(opaque)).pixels,fresh(opaque));
 assert.equal(canvases.length,2);
});
