import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPairedCropWorkerRuntime,PAIRED_CROP_WORKER_LIMITS,type PairedCropCanvas,type PairedCropWorkerPlatform,type PairedCropWorkerResult} from '../dev/paired-crop-worker';

const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const original=()=>new Uint8Array([20,180,220,255,90,40,10,255]);
const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4]);
const uri=`data:image/png;base64,${Buffer.from(png).toString('base64')}`;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function fixture(){
 const messages:Record<string,unknown>[]=[];
 const calls:string[]=[],canvases:{canvas:PairedCropCanvas;pixels:Uint8ClampedArray<ArrayBuffer>}[]=[];
 const state={corruptPaint:false,readbackBytes:null as number|null,contextMissing:false,putError:false,
  hashGate:null as ReturnType<typeof deferred<void>>|null,blobGate:null as ReturnType<typeof deferred<Blob>>|null,
  hashError:false,invalidHash:false,blob:new Blob([png],{type:'image/png'}),base64Error:false,postError:false};
 const hashes:Uint8Array[]=[];
 const platform:PairedCropWorkerPlatform={
  createImageData:(data,width,height)=>({data,width,height} as ImageData),
  createCanvas(width,height){
   const item={canvas:null as unknown as PairedCropCanvas,pixels:new Uint8ClampedArray(width*height*4)};
   const context={globalCompositeOperation:'source-over',
    putImageData(image:ImageData){calls.push('paint');if(state.putError)throw Error('paint failed');item.pixels=new Uint8ClampedArray(image.data);if(state.corruptPaint)item.pixels[0]^=1;},
    getImageData(){calls.push('readback');return {data:state.readbackBytes===null?item.pixels.slice():new Uint8ClampedArray(state.readbackBytes)};},
   };
   item.canvas={width,height,getContext:()=>state.contextMissing?null:context,
    async convertToBlob(){calls.push('png');return state.blobGate?state.blobGate.promise:state.blob;}};
   canvases.push(item);return item.canvas;
  },
  async hash(data){calls.push('hash');hashes.push(data.slice());if(state.hashGate){const gate=state.hashGate;state.hashGate=null;await gate.promise;}if(state.hashError)throw Error('hash failed');return state.invalidHash?'invalid':digest(data);},
  base64:data=>state.base64Error?'!'.repeat(4*Math.ceil(data.byteLength/3)):Buffer.from(data).toString('base64'),
 };
 const runtime=createPairedCropWorkerRuntime({postMessage(value){calls.push('post');if(state.postError)throw Error('channel closed');messages.push(structuredClone(value) as Record<string,unknown>);}},platform);
 return {runtime,state,messages,calls,canvases,hashes,result:()=>messages.at(-1) as unknown as PairedCropWorkerResult};
}
const rgbaRequest=(id=1,pixels=original().buffer,maxImageBytes=1024)=>({kind:'encode-rgba',id,width:2,height:1,pixels,maxImageBytes});

test('owned RGBA is hashed before paint and separately compared with PNG readback and encoded bytes',async()=>{
 const f=fixture(),request=rgbaRequest(),owned=structuredClone(request,{transfer:[request.pixels]});
 assert.equal(request.pixels.byteLength,0,'parent transfers ownership rather than retaining a mutable label alias');
 await f.runtime.handle(owned);
 const result=f.result();
 assert.equal(result.status,'encoded');assert.equal(Object.hasOwn(result,'bitmapClosed'),false,'RAW protocol carries no native bitmap lease');
 assert.equal(result.rgbaSha256,digest(original()));assert.equal(result.rasterRgbaSha256,digest(original()));
 assert.equal(result.rgbaMatchesRaster,true);assert.equal(result.pngSha256,digest(png));
 assert.notEqual(result.pngSha256,result.rgbaSha256);
 assert.equal(result.image,uri);assert.equal(result.imageBytes,uri.length);assert.equal(result.pngBytes,png.byteLength);
 assert.deepEqual(f.calls,['hash','paint','readback','hash','png','hash','post']);
 assert.deepEqual(f.hashes,[original(),original(),png]);
 assert.ok(f.canvases.every(v=>v.canvas.width===0&&v.canvas.height===0));
});

test('alpha/premultiplication or any other painted byte difference cannot become an exact-input PNG',async()=>{
 const f=fixture(),pixels=original();pixels[3]=0;f.state.corruptPaint=true;
 await f.runtime.handle(rgbaRequest(1,pixels.buffer));
 const result=f.result();
 assert.equal(result.status,'error');assert.equal(result.rgbaSha256,digest(pixels));
 assert.notEqual(result.rasterRgbaSha256,result.rgbaSha256);assert.equal(result.rgbaMatchesRaster,false);
 assert.equal(result.image,null);assert.equal(result.pngSha256,null);assert.match(result.error!,/differs/);
 assert.equal(f.calls.includes('png'),false,'mismatch stops before claiming an exact PNG');
 assert.equal(f.canvases[0].canvas.width,0);
});

test('sequential owned rasters do not share mutable bytes and every PNG canvas is released',async()=>{
 const f=fixture(),first=rgbaRequest();await f.runtime.handle(first);
 const firstResult=structuredClone(f.result());
 const next=original();next[0]=25;await f.runtime.handle(rgbaRequest(2,next.buffer));
 assert.equal(f.result().status,'encoded');assert.equal(f.result().rgbaSha256,digest(next));
 assert.equal(firstResult.rgbaSha256,digest(original()));assert.equal(new Uint8Array(first.pixels)[0],20);
 assert.equal(f.messages[0].rgbaSha256,firstResult.rgbaSha256);
 assert.ok(f.canvases.every(v=>v.canvas.width===0&&v.canvas.height===0));
});

test('ASCII data URI budget includes base64 expansion and exact boundary, not only PNG bytes',async()=>{
 for(const budget of [0,21,uri.length-1,uri.length]){
  const f=fixture();await f.runtime.handle(rgbaRequest(1,original().buffer,budget));
  const result=f.result();assert.equal(result.status,budget===uri.length?'encoded':'omitted-budget');
  assert.equal(result.image,budget===uri.length?uri:null);
  assert.equal(result.rgbaMatchesRaster,true);
  if(budget<22)assert.equal(f.calls.includes('png'),false);
  else assert.equal(result.pngBytes,png.byteLength);
  assert.equal(f.canvases[0].canvas.width,0);
 }
});

test('strict RAW-only size/protocol bounds reject unsupported native-image fields before painting',async()=>{
 const requests=[
  {...rgbaRequest(),width:0},{...rgbaRequest(),height:1.5},{...rgbaRequest(),width:Number.MAX_SAFE_INTEGER},
  {...rgbaRequest(),width:PAIRED_CROP_WORKER_LIMITS.rawBytes/4+1},
  {...rgbaRequest(),pixels:new ArrayBuffer(7)},
  {...rgbaRequest(),pixels:new ArrayBuffer(8,{maxByteLength:16})},
  {...rgbaRequest(),pixels:new SharedArrayBuffer(8)},
  {...rgbaRequest(),maxImageBytes:-1},{...rgbaRequest(),maxImageBytes:PAIRED_CROP_WORKER_LIMITS.imageBytes+1},
  {...rgbaRequest(),id:0},{...rgbaRequest(),kind:'invalid'}, {...rgbaRequest(),extra:true},
  {kind:'encode',id:1,bitmap:{width:2,height:1},maxImageBytes:1024},
  {...rgbaRequest(),bitmap:{width:2,height:1}},
 ];
 for(const request of requests){const f=fixture();await f.runtime.handle(request);assert.equal(f.result().status,'error');assert.equal(f.canvases.length,0);}
});

test('one active operation rejects busy/newer/duplicate messages without taking a second raster',async()=>{
 const f=fixture(),active=rgbaRequest(),gate=deferred<void>();f.state.hashGate=gate;
 const pending=f.runtime.handle(active);
 await f.runtime.handle(rgbaRequest(2));assert.equal(f.result().status,'error');
 await f.runtime.handle(active);assert.equal(f.result().status,'error');
 assert.equal(f.canvases.length,1);
 assert.deepEqual(new Uint8Array(active.pixels),original());
 gate.resolve();await pending;assert.equal(f.result().status,'encoded');
 await f.runtime.handle(rgbaRequest());assert.equal(f.result().status,'error');
 await f.runtime.handle(rgbaRequest(2));assert.equal(f.result().status,'encoded');
});

test('cancel while hashing retains the source until hash settles and publishes cancelled without PNG',async()=>{
 const f=fixture(),gate=deferred<void>();f.state.hashGate=gate;
 const pending=f.runtime.handle(rgbaRequest());await f.runtime.handle({kind:'cancel',id:1});
 assert.equal(f.canvases[0].canvas.width,2);assert.equal(f.messages.length,0);
 gate.resolve();await pending;
 assert.equal(f.result().status,'cancelled');assert.equal(f.result().image,null);
 assert.equal(f.calls.includes('png'),false);assert.equal(f.canvases[0].canvas.width,0);
});

test('dispose joins a pending PNG encode, acknowledges after cleanup, and disallows new work',async()=>{
 const f=fixture(),gate=deferred<Blob>();f.state.blobGate=gate;
 const pending=f.runtime.handle(rgbaRequest());
 for(let i=0;i<4&&!f.calls.includes('png');i++)await Promise.resolve();
 assert.ok(f.calls.includes('png'));
 let disposed=false;const disposal=f.runtime.handle({kind:'dispose',id:2}).then(()=>{disposed=true;});
 await Promise.resolve();assert.equal(disposed,false);assert.equal(f.canvases[0].canvas.width,2);
 gate.resolve(new Blob([png],{type:'image/png'}));await Promise.all([pending,disposal]);
 assert.equal(f.messages[0].status,'cancelled');
 assert.deepEqual(f.messages[1],{kind:'disposed',id:2,acknowledged:true});assert.equal(f.canvases[0].canvas.width,0);
 await f.runtime.handle(rgbaRequest(3));assert.equal(f.result().status,'error');
});

test('hash/paint/readback/PNG failures always release canvas without publishing image',async()=>{
 for(const failure of ['contextMissing','hashError','invalidHash','putError','readbackBytes','blob','base64Error'] as const){
  const f=fixture();
  if(failure==='readbackBytes')f.state.readbackBytes=4;
  else if(failure==='blob')f.state.blob=new Blob([png],{type:'image/jpeg'});
  else f.state[failure]=true;
  await f.runtime.handle(rgbaRequest());
  assert.equal(f.result().status,'error',failure);assert.equal(f.result().image,null,failure);
  assert.equal(f.canvases[0].canvas.width,0,failure);assert.equal(f.canvases[0].canvas.height,0,failure);
 }
 const postFailure=fixture();postFailure.state.postError=true;
 await postFailure.runtime.handle(rgbaRequest());assert.equal(postFailure.canvases[0].canvas.width,0);
});
