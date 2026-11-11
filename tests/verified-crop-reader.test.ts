import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {createVerifiedCropReader} from '../src/features/card-scanner/acquisition/verified-crop-reader';

class TestImageData {
  constructor(public data:Uint8ClampedArray, public width:number, public height:number) {}
}
Object.defineProperty(globalThis,'ImageData',{value:TestImageData,configurable:true});
class FakeCanvas {
  private w=2; private h=2;
  pixels=new Uint8ClampedArray([10,20,30,255,40,50,60,255,70,80,90,255,100,110,120,255]);
  get width(){return this.w;} set width(n:number){this.w=n;this.pixels=new Uint8ClampedArray(this.w*this.h*4);}
  get height(){return this.h;} set height(n:number){this.h=n;this.pixels=new Uint8ClampedArray(this.w*this.h*4);}
  getContext(){return {getImageData:()=>({data:this.pixels.slice()}),putImageData:(image:TestImageData)=>{this.pixels.set(image.data);}};}
}
const digest=(p:Uint8Array)=>createHash('sha256').update(p).digest('hex');
const asCanvas=(c:FakeCanvas)=>c as unknown as HTMLCanvasElement;
function fixture() {
  const canvas=new FakeCanvas(),box={x:0,y:0,width:2,height:2};
  const source={sessionId:'session',frameId:1,observationId:'one',captureOrder:1,captureTime:5,phase:'input' as const,slot:0};
  const meta={diagnosticReadId:1,processingFrame:1,slot:0,source,group:0,trace:0,pixelKey:'key',stage:'visual' as const,stable:true,borderAlignment:1,sourceBox:box,sourceWidth:2,sourceHeight:2,cropWidth:2,cropHeight:2};
  const claim={frame:{version:1 as const,kind:'measured' as const,sourceFrameId:1,acquisitionFrameId:1,captureTime:5,width:2,height:2,hash:'a'.repeat(64)},crop:{slot:0,content:{...box},sha256:digest(canvas.pixels)}};
  return {canvas,meta,claim};
}
const readResult={id:'sample',name:'테스트',review:[] as string[],confidence:0.9};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const signal=()=>new AbortController().signal;
const opts=()=>({canvasFactory:()=>asCanvas(new FakeCanvas()),hash:async(bytes:Uint8Array)=>digest(bytes)});

test('snapshots before returning and calls only the private, readback-verified canvas',async()=>{
 const f=fixture(),owner=createVerifiedCropReader(opts());let privateCanvas:FakeCanvas|undefined;
 const original=[...f.canvas.pixels];
 const pending=owner.read(f.meta,f.claim,asCanvas(f.canvas),async canvas=>{
  privateCanvas=canvas as unknown as FakeCanvas;assert.notEqual(canvas,asCanvas(f.canvas));assert.deepEqual([...privateCanvas.pixels],original);return readResult;
 },signal());
 f.canvas.pixels.fill(0);f.claim.crop.sha256='b'.repeat(64);f.meta.sourceBox.x=1;
 const out=await pending;assert.equal(out.status,'identified');assert.equal(out.identity?.id,'sample');
 assert.equal(out.claimAuthenticated,false);assert.equal(out.modelExecutionVerified,false);assert.equal(out.completionEvidence,false);assert.equal(out.independentObservation,false);
 readResult.review.push('later');assert.deepEqual(out.identity?.review,[]);readResult.review.length=0;
 assert.equal(privateCanvas?.width,0);assert.equal(owner.stats().busy,false);
});

test('invalid dimensions, hash, transparency and private canvas corruption never call reader',async()=>{
 for(const kind of ['hash','size','alpha','corruption','reused','accessor'] as const){
  const f=fixture();let calls=0;
  if(kind==='hash')f.claim.crop.sha256='b'.repeat(64);
  if(kind==='size')f.claim.crop.content.width=1.5;
  if(kind==='alpha'){f.canvas.pixels[3]=0;f.claim.crop.sha256=digest(f.canvas.pixels);}
  if(kind==='accessor')Object.defineProperty(f.claim.crop,'sha256',{get(){throw Error('getter ran');},enumerable:true});
  const factory=()=>{
   if(kind==='reused')return asCanvas(f.canvas);
   const c=new FakeCanvas();if(kind==='corruption'){const context=c.getContext();context.putImageData=()=>{};c.getContext=()=>context;}
   return asCanvas(c);
  };
  const owner=createVerifiedCropReader({...opts(),canvasFactory:factory});
  const out=await owner.read(f.meta,f.claim,asCanvas(f.canvas),async()=>{calls++;return readResult;},signal());
  assert.equal(calls,0,kind);assert.equal(out.status,kind==='hash'?'mismatch':kind==='corruption'||kind==='reused'?'error':'unavailable',kind);
  assert.equal(owner.stats().busy,false);
 }
});

test('unknown, review and exceptions do not turn into a completed identity',async()=>{
 const f=fixture(),owner=createVerifiedCropReader(opts());
 assert.equal((await owner.read(f.meta,f.claim,asCanvas(f.canvas),async()=>null,signal())).status,'unknown');
 assert.equal((await owner.read(f.meta,f.claim,asCanvas(f.canvas),async()=>({...readResult,review:['inspect']}),signal())).status,'review');
 assert.equal((await owner.read(f.meta,f.claim,asCanvas(f.canvas),async()=>{throw Error('reader');},signal())).status,'error');
 const fake={...readResult};Object.defineProperty(fake,'unsafe',{enumerable:true,get(){throw Error('getter');}});
 assert.equal((await owner.read(f.meta,f.claim,asCanvas(f.canvas),async()=>fake,signal())).status,'error');
});

test('timeout retains private canvas and credit until reader settles; late result is ignored',async()=>{
 const f=fixture(),pending=deferred<typeof readResult>(),entered=deferred<void>();let privateCanvas:FakeCanvas|undefined;
 const owner=createVerifiedCropReader({...opts(),timeoutMs:25});
 const result=owner.read(f.meta,f.claim,asCanvas(f.canvas),async(canvas,abort)=>{
  privateCanvas=canvas as unknown as FakeCanvas;entered.resolve();const value=await pending.promise;assert.equal(abort.aborted,true);return value;
 },signal());
 await entered.promise;assert.equal((await result).status,'timeout');assert.equal(privateCanvas?.width,2);
 assert.deepEqual(owner.stats(),{busy:true,closed:false,reservedBytes:64});
 assert.equal((await owner.read(f.meta,f.claim,asCanvas(f.canvas),async()=>readResult,signal())).status,'capacity');
 pending.resolve(readResult);await flush();assert.equal(privateCanvas?.width,0);assert.equal(owner.stats().busy,false);
});

test('abort and close cancel immediately while retaining a noncooperative reader',async()=>{
 for(const mode of ['abort','close'] as const){
  const f=fixture(),pending=deferred<typeof readResult>(),entered=deferred<void>(),controller=new AbortController();let privateCanvas:FakeCanvas|undefined;
  const owner=createVerifiedCropReader(opts());const result=owner.read(f.meta,f.claim,asCanvas(f.canvas),async canvas=>{
   privateCanvas=canvas as unknown as FakeCanvas;entered.resolve();return pending.promise;
  },controller.signal);
  await entered.promise;if(mode==='abort')controller.abort();else owner.close();
  assert.equal((await result).status,'cancelled');assert.equal(owner.stats().busy,true);assert.equal(privateCanvas?.width,2);
  pending.resolve(readResult);await flush();assert.equal(privateCanvas?.width,0);assert.equal(owner.stats().busy,false);
 }
});

test('timeout during a stalled hash never invokes reader and holds credit until hash settles',async()=>{
 const f=fixture(),pending=deferred<string>();let calls=0;
 const owner=createVerifiedCropReader({...opts(),timeoutMs:20,hash:()=>pending.promise});
 const result=owner.read(f.meta,f.claim,asCanvas(f.canvas),async()=>{calls++;return readResult;},signal());
 assert.equal((await result).status,'timeout');assert.equal(owner.stats().busy,true);pending.resolve(f.claim.crop.sha256);
 await flush();assert.equal(calls,0);assert.equal(owner.stats().busy,false);
});

test('mutating hash input is rejected',async()=>{
 const f=fixture();let calls=0;const owner=createVerifiedCropReader({...opts(),hash:async bytes=>{bytes[0]=0;return f.claim.crop.sha256;}});
 assert.equal((await owner.read(f.meta,f.claim,asCanvas(f.canvas),async()=>{calls++;return readResult;},signal())).status,'error');assert.equal(calls,0);
});

test('default SHA-256 verifies the actual pixels before calling the reader',async()=>{
 const f=fixture();let called=false;const owner=createVerifiedCropReader({canvasFactory:()=>asCanvas(new FakeCanvas())});
 const result=await owner.read(f.meta,f.claim,asCanvas(f.canvas),async()=>{called=true;return readResult;},signal());
 assert.equal(result.status,'identified');assert.equal(called,true);
});
