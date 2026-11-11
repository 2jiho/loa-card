import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {createVerifiedRecoveryRead,type RecoveryReadIdentity} from '../src/features/card-scanner/acquisition/verified-recovery-read';
import {createRestoredPixelCapabilities} from '../src/features/card-scanner/acquisition/restored-pixel-capability';

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
const signal=()=>new AbortController().signal;
const readIdentity={id:'card-1',name:'베스칼',review:[] as string[],awakening:0,copies:1};
type ReaderValue=RecoveryReadIdentity|null|((canvas:HTMLCanvasElement)=>RecoveryReadIdentity|null);
const readerOf=(value:ReaderValue)=>async(canvas:HTMLCanvasElement)=>
  typeof value==='function'?value(canvas):value;

async function fixture(overrides:{oracle?:(id:string)=>number|null}={}) {
  // Original frame is 4x2; the retained crop is a 2x1 region at (1,0).
  const frame=new Uint8ClampedArray(Array.from({length:32},(_,i)=>i*7%256));
  for(let i=3;i<frame.length;i+=4)frame[i]=255;
  const box={x:1,y:0,width:2,height:1};
  const crop=new Uint8ClampedArray(8);
  for(let x=0;x<2;x++)crop.set(frame.subarray(4+x*4,8+x*4),x*4);
  const source={sessionId:'scan',frameId:3,observationId:'obs-1',captureOrder:2,captureTime:100,phase:'input' as const,slot:5};
  const recovery={...source,frameId:9,observationId:'obs-rec',phase:'recovery' as const};
  const physical={sourceFrameId:7,captureTime:100,width:4,height:2,hash:digest(frame)};
  const description=Object.freeze({scope:'prepared-source-metadata-only' as const,pixelsAuthenticated:false as const,
    originalSource:{...source},originalGroup:4,recoverySource:{...recovery},physical,content:{...box},
    preview:{x:0,y:0,width:2,height:1}});
  const unknownCrop={source:{...source,frame:'scan/3/obs-1'},group:4,recipe:'card-full',width:2,height:1,
    sourceWidth:4,sourceHeight:2,sourceBox:{...box},rgba:crop};
  const restored=createRestoredPixelCapabilities({maxFrames:8,lifetimeMs:60_000,maxWorkingBytes:16*1024*1024});
  const identity={sourceFrameId:7,time:100,width:4,height:2,hash:digest(frame)};
  const issued=await restored.issue(frame,identity,signal(),()=>true);
  return {...physical,box,source,recovery,description,unknownCrop,restored,identity,token:issued.token,cropBytes:crop,
    oracle:overrides.oracle};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const createReader=(f:Fixture,value:ReaderValue,opts:{timeoutMs?:number}={})=>createVerifiedRecoveryRead({
  reader:readerOf(value),canvasFactory:()=>asCanvas(new FakeCanvas()),hash:async bytes=>digest(bytes),
  ...(f.oracle?{latestConfirmedCaptureTime:f.oracle}:{}),
  ...(opts.timeoutMs?{timeoutMs:opts.timeoutMs}:{})
});
const request=(f:Fixture,crop:typeof f.unknownCrop=f.unknownCrop)=>({description:f.description,crop,
  restored:f.restored,token:f.token,identity:f.identity,signal:signal()});

test('byte-equal re-read resolves a single-source card without independent or completion authority',async()=>{
  const f=await fixture();
  const owner=createVerifiedRecoveryRead({reader:readerOf(readIdentity),canvasFactory:()=>asCanvas(new FakeCanvas()),
    hash:async bytes=>digest(bytes)});
  const out=await owner.read(request(f));
  assert.equal(out.status,'resolved');assert.equal(out.identity?.id,'card-1');assert.equal(out.identity?.name,'베스칼');
  assert.equal(out.independentObservation,false);assert.equal(out.completionEvidence,false);
  assert.equal(out.pixelByteMatch,true);assert.equal(out.restoredPixelsConsumed,true);
  assert.equal(out.latestConfirmedCaptureTime,null);assert.equal(out.reason,null);
  assert.equal(out.source?.observationId,'obs-1');
  // One-use handoff: the same token cannot fund a second read.
  assert.equal((await owner.read(request(f))).status,'unavailable');
});

test('the reader receives the crop bytes on a fresh canvas, not the whole frame',async()=>{
  const f=await fixture();
  const owner=createVerifiedRecoveryRead({reader:readerOf((canvas)=>{
    const c=asCanvas(canvas as unknown as FakeCanvas);
    assert.equal(c.width,2);assert.equal(c.height,1);
    assert.deepEqual([...c.pixels],[...f.cropBytes]);
    return readIdentity;
  }),canvasFactory:()=>asCanvas(new FakeCanvas()),hash:async bytes=>digest(bytes)});
  assert.equal((await owner.read(request(f))).status,'resolved');
});

test('stale check uses capture time: newer confirmed capture blocks overwrite, equal does not',async()=>{
  const stale=await fixture({oracle:()=>101}),equal=await fixture({oracle:()=>100});
  const a=await createReader(stale,readIdentity).read(request(stale));
  assert.equal(a.status,'stale');assert.equal(a.latestConfirmedCaptureTime,101);
  assert.equal(a.identity?.id,'card-1');assert.equal(a.independentObservation,false);assert.equal(a.completionEvidence,false);
  const b=await createReader(equal,readIdentity).read(request(equal));
  assert.equal(b.status,'resolved');assert.equal(b.latestConfirmedCaptureTime,100);
});

test('incomplete fields, review and no identity stay unresolved; explicit zero is a confirmed value',async()=>{
  const run=async(value:RecoveryReadIdentity|null)=>{
    const f=await fixture();
    return createReader(f,value).read(request(f));
  };
  assert.equal((await run(readIdentity)).status,'resolved');
  assert.equal((await run({...readIdentity,copies:null})).status,'unresolved');
  assert.equal((await run({...readIdentity,awakening:null})).status,'unresolved');
  assert.equal((await run({...readIdentity,review:['check']})).status,'unresolved');
  assert.equal((await run(null)).status,'unresolved');
  assert.equal((await run({...readIdentity,awakening:0,copies:0})).status,'resolved');
});

test('retained bytes differing from the restored region never reach the reader',async()=>{
  const f=await fixture();let calls=0;
  const owner=createVerifiedRecoveryRead({reader:readerOf((()=>{calls++;return readIdentity;}) as ReaderValue),
    canvasFactory:()=>asCanvas(new FakeCanvas()),hash:async bytes=>digest(bytes)});
  const tampered=new Uint8ClampedArray(f.cropBytes);tampered[0]=(tampered[0]+1)%256;
  const out=await owner.read({...request(f),crop:{...f.unknownCrop,rgba:tampered}});
  assert.equal(out.status,'mismatch');assert.match(out.reason??'',/restored original region/);
  assert.equal(calls,0);assert.equal(out.pixelByteMatch,false);assert.equal(out.restoredPixelsConsumed,true);
});

test('a restored raster that is not the bound original frame is rejected as mismatch',async()=>{
  const f=await fixture();let calls=0;
  const altered=new Uint8ClampedArray(32);
  for(let i=0;i<32;i++)altered[i]=i%2===3?255:i;
  const store=createRestoredPixelCapabilities({maxFrames:8,lifetimeMs:60_000,maxWorkingBytes:16*1024*1024});
  const issued=await store.issue(altered,{...f.identity,hash:digest(altered)},signal(),()=>true);
  const owner=createVerifiedRecoveryRead({reader:readerOf((()=>{calls++;return readIdentity;}) as ReaderValue),
    canvasFactory:()=>asCanvas(new FakeCanvas()),hash:async bytes=>digest(bytes)});
  const out=await owner.read({...request(f),restored:store,token:issued.token,
    identity:{sourceFrameId:7,time:100,width:4,height:2,hash:digest(altered)}});
  assert.equal(out.status,'mismatch');assert.match(out.reason??'',/bound original frame/);
  assert.equal(calls,0);
});

test('missing crop and metadata contradictions are rejected before any consumption',async()=>{
  const f=await fixture();
  const none=await createReader(f,readIdentity).read({...request(f),crop:null});
  assert.equal(none.status,'unidentified');assert.equal(none.restoredPixelsConsumed,false);
  assert.equal(await f.restored.verify(f.token,f.identity,signal()),true);
  const owner=createReader(f,readIdentity);
  assert.equal((await owner.read(request(f,{...f.unknownCrop,group:5}))).status,'mismatch');
  assert.equal((await owner.read(request(f,{...f.unknownCrop,sourceBox:{x:0,y:0,width:2,height:1}}))).status,'mismatch');
  assert.equal(await f.restored.verify(f.token,f.identity,signal()),true);
});

test('unavailable restored store and abort map to unavailable or cancelled',async()=>{
  const f=await fixture();
  const owner=createReader(f,readIdentity);
  assert.equal((await owner.read({description:f.description,crop:f.unknownCrop,restored:{consume:async()=>undefined},
    token:f.token,identity:f.identity,signal:signal()})).status,'unavailable');
  const aborted=new AbortController();aborted.abort();
  assert.equal((await owner.read({...request(f),signal:aborted.signal})).status,'cancelled');
});

test('timeout and capacity propagate from the shared reader budget; close cancels',async()=>{
  const f=await fixture(),f2=await fixture(),f3=await fixture();let started=false;
  const slow=createVerifiedRecoveryRead({reader:async()=>{
    started=true;await new Promise(r=>setTimeout(r,80));return readIdentity;
  },canvasFactory:()=>asCanvas(new FakeCanvas()),hash:async bytes=>digest(bytes),timeoutMs:25});
  const pending=slow.read(request(f));
  await new Promise(r=>setTimeout(r,10));
  assert.equal((await slow.read(request(f2))).status,'capacity');assert.equal(started,true);
  assert.equal((await pending).status,'timeout');
  assert.equal((await slow.read(request(f3))).status,'capacity');
  slow.close();
  assert.equal((await slow.read(request(f2))).status,'cancelled');
  assert.equal(slow.stats().closed,true);
});
