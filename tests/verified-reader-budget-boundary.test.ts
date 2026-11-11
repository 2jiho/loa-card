import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {CardReadBudget} from '../src/features/card-scanner/recognition/card-read-budget';
import {createVerifiedCropReader} from '../src/features/card-scanner/acquisition/verified-crop-reader';

class TestImageData {
  constructor(public data:Uint8ClampedArray,public width:number,public height:number) {}
}
Object.defineProperty(globalThis,'ImageData',{value:TestImageData,configurable:true});
class TestCanvas {
  private w=2;private h=2;
  pixels=new Uint8ClampedArray([10,20,30,255,40,50,60,255,70,80,90,255,100,110,120,255]);
  get width(){return this.w;}set width(n:number){this.w=n;this.pixels=new Uint8ClampedArray(this.w*this.h*4);}
  get height(){return this.h;}set height(n:number){this.h=n;this.pixels=new Uint8ClampedArray(this.w*this.h*4);}
  getContext(){return {getImageData:()=>({data:this.pixels.slice()}),putImageData:(image:TestImageData)=>this.pixels.set(image.data)};}
}
const canvas=(value:TestCanvas)=>value as unknown as HTMLCanvasElement;
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

test('reader callback settlement after a budget timeout does not prove worker and cleanup settlement',async()=>{
  const image=new TestCanvas(),box={x:0,y:0,width:2,height:2};
  const source={sessionId:'s',frameId:1,observationId:'o',captureOrder:1,captureTime:1,phase:'input' as const,slot:0};
  const meta={diagnosticReadId:1,processingFrame:1,slot:0,source,group:0,trace:1,pixelKey:'p',stage:'full' as const,
    stable:true,borderAlignment:1,sourceBox:box,sourceWidth:2,sourceHeight:2,cropWidth:2,cropHeight:2};
  const claim={frame:{version:1 as const,kind:'measured' as const,sourceFrameId:1,acquisitionFrameId:1,captureTime:1,
    width:2,height:2,hash:'a'.repeat(64)},crop:{slot:0,content:box,sha256:sha(image.pixels)}};
  const owner=createVerifiedCropReader({canvasFactory:()=>canvas(new TestCanvas()),hash:async bytes=>sha(bytes),timeoutMs:1000});
  const budget=new CardReadBudget(20,()=>performance.now(),true),work=deferred<void>(),cleanup=deferred<void>();
  let cleanupStarted=false;
  try {
    const result=await owner.read(meta,claim,canvas(image),async()=>{
      await budget.wait(()=>work.promise,()=>{cleanupStarted=true;return cleanup.promise;});
      return {id:'card',name:'card',review:[]};
    },new AbortController().signal);
    assert.equal(result.status,'error');
    assert.equal(cleanupStarted,true);
    assert.equal(await budget.waitForQuiescence(5),false);
    work.resolve();
    assert.equal(await budget.waitForQuiescence(5),false);
    cleanup.resolve();
    assert.equal(await budget.waitForQuiescence(100),true);
  } finally {work.resolve();cleanup.resolve();owner.close();}
});
