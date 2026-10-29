import test from 'node:test';
import assert from 'node:assert/strict';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';

const emptyLayout={cells:[],header:{},growthPoints:{},sort:{},area:{},scrollbar:{},scale:1};
async function runtime(run:(h:any)=>Promise<void>){
  const names=['self','OffscreenCanvas','ImageData','crypto'],prior=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)])),
    replies:any[]=[],draws:any[]=[],puts:any[]=[],reads:any[]=[];
  class Canvas {
    private w:number;private h:number;private bytes:Uint8ClampedArray;
    constructor(width:number,height:number){this.w=width;this.h=height;this.bytes=new Uint8ClampedArray(width*height*4);}
    set width(value:number){this.w=value;this.bytes=new Uint8ClampedArray(value*this.h*4);}get width(){return this.w;}
    set height(value:number){this.h=value;this.bytes=new Uint8ClampedArray(value*this.w*4);}get height(){return this.h;}
    getContext(){return {putImageData:(image:any)=>{puts.push({width:image.width,height:image.height,data:image.data.slice()});this.bytes=image.data.slice();},
      drawImage:(value:any)=>{draws.push(value);},getImageData:(x:number,y:number,width:number,height:number)=>{
        reads.push({x,y,width,height});return {width,height,data:this.bytes.slice()};}};}
  }
  // WorkerGlobalScope includes the standard constructors. tsx's cold synchronous
  // lexer uses `self` before its asynchronous WASM lexer is ready; a plain mock
  // would lack Int8Array and fail while loading the worker, before any test runs.
  const scope=Object.assign(Object.create(globalThis),{onmessage:null as any,postMessage(value:unknown){replies.push(value);}});
  assert.equal(scope.Int8Array,Int8Array);assert.equal(scope.Uint16Array,Uint16Array);assert.equal(scope.Math,Math);
  Object.defineProperty(globalThis,'self',{configurable:true,value:scope});Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:Canvas});
  Object.defineProperty(globalThis,'ImageData',{configurable:true,value:class{constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}}});
  const send=(data:any)=>scope.onmessage({data});
  try{const url=new URL('../src/features/card-scanner/acquisition-worker.ts',import.meta.url);url.searchParams.set('prepared-runtime-test',crypto.randomUUID());
    await import(url.href);await run({send,replies,draws,puts,reads});}
  finally{for(const [name,value]of Object.entries(prior))if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name);}
}
const source=(id=1)=>({pixels:Uint8Array.from([11,12,13,255,41,42,43,255]),width:2,height:1,binding:{sourceFrameId:id,captureTime:4.75}});

test('actual worker prepared adapter hashes its full putImageData detector raster without bitmap conversion',async()=>{
  await runtime(async(h:any)=>{
    const input=source(9),snapshot=input.pixels.slice(),hash=await pixelHash(snapshot),prepared=structuredClone(input,{transfer:[input.pixels.buffer]});
    assert.equal(input.pixels.byteLength,0);
    await h.send({kind:'prepared',id:17,prepared,layout:emptyLayout,pixelProof:true});
    const result=h.replies.at(-1);assert.equal(result.id,17);assert.deepEqual(result.cells,[]);assert.equal(result.layout,emptyLayout);
    assert.deepEqual(result.rasterReceipt,{version:1,kind:'measured',sourceFrameId:9,captureTime:4.75,acquisitionFrameId:17,width:2,height:1,hash});
    assert.equal(result.pixelProof.hash,hash);assert.deepEqual(result.pixelProof.sample,Array.from(snapshot));
    assert.equal(h.draws.length,0);assert.equal(h.puts.length,1);assert.deepEqual(h.puts[0].data,new Uint8ClampedArray(snapshot));
    assert.deepEqual(h.reads,[{x:0,y:0,width:2,height:1}]);assert.ok(result.timing.rasterReadbackMs>=0);assert.ok(result.timing.rasterHashMs>=0);
  });
});

test('prepared raw protocol refuses source/bitmap and legacy recorder ambiguity before painting or forwarding',async()=>{
  await runtime(async(h:any)=>{
    let closed=0;await h.send({kind:'prepared',id:1,prepared:source(),bitmap:{close(){closed++;}},layout:emptyLayout});
    assert.match(h.replies.at(-1).error,/혼합/);assert.equal(closed,1);assert.equal(h.puts.length,0);
    const forwarded:any[]=[],port={onmessage:null,start(){},close(){},postMessage(value:unknown){forwarded.push(value);}};
    await h.send({kind:'record',port});await h.send({kind:'prepared',id:2,prepared:source(),layout:emptyLayout});
    assert.match(h.replies.at(-1).error,/혼합/);assert.equal(h.puts.length,0);assert.equal(forwarded.length,0);
    await h.send({kind:'record-end'});
    await h.send({kind:'prepared',id:3,prepared:{...source(),pixels:new Uint8Array(12).subarray(0,8)},layout:emptyLayout});
    assert.match(h.replies.at(-1).error,/whole RGBA/);assert.equal(h.puts.length,0);
    await h.send({kind:'prepared',id:4,prepared:source(),layout:emptyLayout});assert.ok(h.replies.at(-1).rasterReceipt);
  });
});

test('worker busy guard prevents a second prepared input from replacing the raster during an in-flight digest',async()=>{
  await runtime(async(h:any)=>{
    const first=source(1),hash=await pixelHash(first.pixels),realCrypto=crypto;let release!:(value:ArrayBuffer)=>void;
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:realCrypto.randomUUID.bind(realCrypto),subtle:{digest:()=>new Promise(resolve=>{release=resolve;})}}});
    const running=h.send({kind:'prepared',id:1,prepared:first,layout:emptyLayout});
    await h.send({kind:'prepared',id:2,prepared:source(2),layout:emptyLayout});assert.equal(h.replies.at(-1).id,2);
    assert.match(h.replies.at(-1).error,/동시 수집/);assert.equal(h.puts.length,1);
    release(Uint8Array.from(Buffer.from(hash,'hex')).buffer);await running;
    assert.equal(h.replies.at(-1).id,1);assert.equal(h.replies.at(-1).rasterReceipt.sourceFrameId,1);assert.equal(h.replies.at(-1).rasterReceipt.hash,hash);
  });
});
