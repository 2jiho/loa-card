/** Development diagnostics only. Pixels and PNG bytes never leave this local Worker except as a bounded PNG URI. */
export const PAIRED_CROP_WORKER_LIMITS=Object.freeze({rawBytes:2*1024*1024,imageBytes:1024*1024});
export interface PairedCropWorkerResult {
 kind:'result';id:number;status:'encoded'|'omitted-budget'|'error'|'cancelled';
 width:number|null;height:number|null;rgbaSha256:string|null;pngSha256:string|null;
 rasterRgbaSha256:string|null;rgbaMatchesRaster:boolean|null;
 pngBytes:number|null;imageBytes:number|null;image:string|null;error:string|null;
}
export interface PairedCropCanvas {
 width:number;height:number;
 getContext(type:'2d',options?:{willReadFrequently?:boolean;colorSpace?:'srgb'}):{
  globalCompositeOperation:string;
  putImageData(source:ImageData,x:number,y:number):void;
  getImageData(x:number,y:number,width:number,height:number):{data:Uint8ClampedArray<ArrayBuffer>};
 }|null;
 convertToBlob(options:{type:'image/png'}):Promise<Blob>;
}
export interface PairedCropWorkerPlatform {
 createCanvas(width:number,height:number):PairedCropCanvas;
 createImageData(pixels:Uint8ClampedArray<ArrayBuffer>,width:number,height:number):ImageData;
 hash(data:Uint8Array<ArrayBuffer>):Promise<string>;
 base64(data:Uint8Array<ArrayBuffer>):string;
}
export interface PairedCropWorkerScope {postMessage(value:unknown):void}
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fixedBuffer=(value:unknown):value is ArrayBuffer=>value instanceof ArrayBuffer&&(value as ArrayBuffer&{resizable?:boolean}).resizable!==true;
const defaults:PairedCropWorkerPlatform={
 createCanvas:(width,height)=>new OffscreenCanvas(width,height),
 createImageData:(pixels,width,height)=>new ImageData(pixels,width,height),
 hash:async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),value=>value.toString(16).padStart(2,'0')).join(''),
 base64:data=>{let binary='';for(let offset=0;offset<data.length;offset+=16_384)binary+=String.fromCharCode(...data.subarray(offset,offset+16_384));return btoa(binary);},
};
function exact(value:Record<string,unknown>,keys:readonly string[]){if(Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw Error('Unexpected paired-crop request fields.');}

/** At most one transferred, owned raw raster is processed. Raw input bytes are
 * hashed before painting, then compared with the actual PNG canvas readback.
 * Disposal joins pending work before zeroing the PNG canvas. A parent deadline
 * must terminate a hung Worker rather than claim unacknowledged cleanup. */
export function createPairedCropWorkerRuntime(scope:PairedCropWorkerScope,platform:PairedCropWorkerPlatform=defaults){
 type Job={id:number;pixels:ArrayBuffer;width:number;height:number;maxImageBytes:number;controller:AbortController;work:Promise<void>};
 let active:Job|undefined,closing=false,lastId=0;
 const post=(value:unknown)=>{try{scope.postMessage(value);}catch{/* Parent owns the channel/Worker lifetime. */}};
 const rejected=(id:number,error:unknown)=>post({kind:'result',id,status:'error',width:null,height:null,rgbaSha256:null,pngSha256:null,
  rasterRgbaSha256:null,rgbaMatchesRaster:null,pngBytes:null,imageBytes:null,image:null,error:String(error).slice(0,1000)} satisfies PairedCropWorkerResult);
 async function encode(job:Job){
  const result:PairedCropWorkerResult={kind:'result',id:job.id,status:'error',width:null,height:null,rgbaSha256:null,pngSha256:null,
   rasterRgbaSha256:null,rgbaMatchesRaster:null,pngBytes:null,imageBytes:null,image:null,error:null};
  let canvas:PairedCropCanvas|undefined;
  const check=()=>job.controller.signal.throwIfAborted();
  try{
   check();const {width,height}=job,size=width*height*4;
   if(!positive(width)||!positive(height)||!Number.isSafeInteger(size)||size>PAIRED_CROP_WORKER_LIMITS.rawBytes)throw Error('Paired-crop raster size exceeds its bound.');
   result.width=width;result.height=height;
   canvas=platform.createCanvas(width,height);const context=canvas.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'});
   if(!context)throw Error('Paired-crop raster context unavailable.');
   context.globalCompositeOperation='copy';
   const source=new Uint8Array(job.pixels);
   result.rgbaSha256=await platform.hash(source);check();
   if(!sha(result.rgbaSha256))throw Error('Invalid paired-crop input RGBA hash.');
   context.putImageData(platform.createImageData(new Uint8ClampedArray(job.pixels),width,height),0,0);
   const pixels=context.getImageData(0,0,width,height).data;
   if(!fixedBuffer(pixels.buffer)||pixels.byteLength!==size)throw Error('Invalid paired-crop RGBA readback.');
   result.rasterRgbaSha256=await platform.hash(new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength));check();
   if(!sha(result.rasterRgbaSha256))throw Error('Invalid paired-crop painted RGBA hash.');
   result.rgbaMatchesRaster=result.rgbaSha256===result.rasterRgbaSha256;
   if(!result.rgbaMatchesRaster)throw Error('Paired-crop input RGBA differs from the PNG painted raster.');
   if(job.maxImageBytes<22){result.status='omitted-budget';return;}
   const blob=await canvas.convertToBlob({type:'image/png'});check();
   if(!(blob instanceof Blob)||blob.type!=='image/png'||!positive(blob.size))throw Error('Paired-crop PNG encoder returned an invalid Blob.');
   result.pngBytes=blob.size;
   const imageLength=22+4*Math.ceil(blob.size/3);
   if(imageLength>job.maxImageBytes){result.status='omitted-budget';return;}
   const data=new Uint8Array(await blob.arrayBuffer());check();if(data.byteLength!==blob.size)throw Error('Paired-crop PNG length changed.');
   result.pngSha256=await platform.hash(data);check();if(!sha(result.pngSha256))throw Error('Invalid paired-crop PNG hash.');
   const image=`data:image/png;base64,${platform.base64(data)}`;
   if(image.length!==imageLength||image.length>job.maxImageBytes||!/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/.test(image))throw Error('Invalid paired-crop PNG encoding.');
   result.image=image;result.imageBytes=image.length;result.status='encoded';
  }catch(error){result.status=job.controller.signal.aborted?'cancelled':'error';result.error=String(error).slice(0,1000);result.image=null;result.imageBytes=null;}
  finally{
   if(canvas)try{canvas.width=0;canvas.height=0;}catch{result.error??='Paired-crop canvas cleanup failed.';result.status='error';result.image=null;result.imageBytes=null;}
   post(result);
  }
 }
 return {
  async handle(value:unknown){
   if(!plain(value))return;
   const id=positive(value.id)?value.id:0;
   if(value.kind==='dispose'){
    try{exact(value,['kind','id']);if(!id||id<=lastId||closing)throw Error('Invalid paired-crop disposal id.');}catch(error){post({kind:'disposed',id,acknowledged:false,error:String(error).slice(0,1000)});return;}
    lastId=id;closing=true;active?.controller.abort(new DOMException('Paired crop disposed','AbortError'));await active?.work;
    post({kind:'disposed',id,acknowledged:true});return;
   }
   if(value.kind==='cancel'){
    try{exact(value,['kind','id']);if(!id)throw Error('Invalid paired-crop cancel id.');}catch(error){rejected(id,error);return;}
    if(active?.id===id)active.controller.abort(new DOMException('Paired crop cancelled','AbortError'));return;
   }
   try{
    exact(value,['kind','id','width','height','pixels','maxImageBytes']);
    if(value.kind!=='encode-rgba')throw Error('Invalid paired-crop request kind.');
    const size=(value.width as number)*(value.height as number)*4;
    if(!positive(value.width)||!positive(value.height)||!Number.isSafeInteger(size)||size>PAIRED_CROP_WORKER_LIMITS.rawBytes||
     !fixedBuffer(value.pixels)||value.pixels.byteLength!==size)throw Error('Invalid paired-crop owned RGBA.');
    if(!id||id<=lastId||active||closing||
     typeof value.maxImageBytes!=='number'||!Number.isSafeInteger(value.maxImageBytes)||value.maxImageBytes<0||value.maxImageBytes>PAIRED_CROP_WORKER_LIMITS.imageBytes)
     throw Error('Invalid or concurrent paired-crop request.');
   }catch(error){rejected(id,error);return;}
   lastId=id;const job:Job={id,pixels:value.pixels as ArrayBuffer,width:value.width as number,height:value.height as number,
    maxImageBytes:value.maxImageBytes as number,controller:new AbortController(),work:Promise.resolve()};active=job;
   job.work=encode(job);try{await job.work;}finally{if(active===job)active=undefined;}
  },
 };
}
if(typeof document==='undefined'&&typeof self!=='undefined'){
 const scope=self as unknown as PairedCropWorkerScope&{onmessage:((event:MessageEvent)=>void)|null};
 const runtime=createPairedCropWorkerRuntime(scope);scope.onmessage=event=>{void runtime.handle(event.data);};
}
