import test from 'node:test';
import assert from 'node:assert/strict';
import {preparedDecodedFrames} from '../src/features/card-scanner/prepared-decoded-frames';
import type {PreparedDecodeSample,PreparedDecodedFramesPlatform} from '../src/features/card-scanner/prepared-decoded-frames';
import {recordedFrames} from '../src/features/card-scanner/continuous-capture';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
async function until(predicate:()=>boolean){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw Error('Prepared decoder fixture timeout');await tick();}}
class Frame {closed=0;constructor(readonly displayWidth:number,readonly displayHeight:number){}
  get format():never{throw Error('decoder adapter must not choose native color/format support');}close(){this.closed++;}}
class Sample implements PreparedDecodeSample {
  timestamp=0;duration=.04;rotation=0;flip=false;pixelAspectRatio={num:1,den:1};displayWidth=2;displayHeight=2;
  closed=0;draws=0;conversions=0;frames:Frame[]=[];conversionError=false;drawError=false;closeError=false;
  toVideoFrame(){this.conversions++;if(this.conversionError)throw Error('conversion failed');const frame=new Frame(this.displayWidth,this.displayHeight);this.frames.push(frame);return frame as unknown as VideoFrame;}
  draw(context:CanvasRenderingContext2D,x:number,y:number,width:number,height:number){this.draws++;if(this.drawError)throw Error('draw failed');
    assert.equal(x,0);assert.equal(y,0);assert.equal(width,this.displayWidth);assert.equal(height,this.displayHeight);(context as any).paint(this);}
  close(){this.closed++;if(this.closeError)throw Error('sample close failed');}
}
function fixture(count=2){
  const samples=Array.from({length:count},(_,i)=>{const value=new Sample();value.timestamp=i*.04;return value;}),
    counts={inputs:0,disposed:0,next:0,returned:0,contexts:0,yields:0},canvas={width:0,height:0,painted:undefined as Sample|undefined,
      getContext(){counts.contexts++;return {globalCompositeOperation:'source-over',paint:(sample:Sample)=>{canvas.painted=sample;}};}};
  let index=0,nextGate:ReturnType<typeof deferred<IteratorResult<PreparedDecodeSample>>>|undefined,
    returnGate:ReturnType<typeof deferred<IteratorResult<PreparedDecodeSample>>>|undefined,available=true;
  const platform:PreparedDecodedFramesPlatform={
    createInput:()=>{counts.inputs++;return {getPrimaryVideoTrack:async()=>({canDecode:async()=>true,computeDuration:async()=>.08}),dispose(){counts.disposed++;}};},
    samples:()=>({async next(){counts.next++;if(nextGate)return nextGate.promise;return index<samples.length?{done:false,value:samples[index++]}:{done:true,value:undefined};},
      async return(){counts.returned++;return returnGate?returnGate.promise:{done:true,value:undefined};}}),
    createCanvas:()=>canvas as unknown as HTMLCanvasElement,nativeAvailable:()=>available,yieldTask:async()=>{counts.yields++;},
  };
  return {samples,counts,canvas,platform,setAvailable:(value:boolean)=>{available=value;},
    gate:()=>nextGate=deferred<IteratorResult<PreparedDecodeSample>>(),returnGate:()=>returnGate=deferred<IteratorResult<PreparedDecodeSample>>()};
}
const source=new Blob(['preserved encoded input']);

test('native samples stay native until preparation, with one borrowed frame and unchanged PTS/order',async()=>{
  const f=fixture(),frames=preparedDecodedFrames(source,new AbortController().signal,f.platform);
  assert.equal(f.counts.inputs,0,'decoder initialization is lazy');
  const first=await frames.next();assert.equal(first.value?.time,0);assert.equal(first.value?.nativeFrame,f.samples[0].frames[0]);
  assert.equal(first.value?.element,f.canvas);assert.deepEqual([f.canvas.width,f.canvas.height],[2,2]);assert.equal(f.counts.contexts,0);
  assert.equal(f.samples[0].closed,1);assert.equal(f.samples[0].frames[0].closed,0);assert.equal(f.counts.next,1);
  const second=await frames.next();assert.equal(f.samples[0].frames[0].closed,1);assert.equal(second.value?.time,.04);
  assert.equal(second.value?.percent,100);assert.equal(f.samples[1].closed,1);assert.equal(f.samples[1].frames[0].closed,0);
  assert.equal((await frames.next()).done,true);assert.equal(f.samples[1].frames[0].closed,1);
  assert.equal(f.counts.disposed,1);assert.equal(f.counts.returned,1);assert.equal(f.counts.contexts,0);
  assert.deepEqual([f.canvas.width,f.canvas.height],[0,0]);assert.equal(f.counts.yields,2);
});

test('orientation, sample aspect and absent native API render the same actual sample as explicit fallback',async()=>{
  for(const mode of ['rotation','flip','aspect','api']as const){
    const f=fixture(1),sample=f.samples[0];
    if(mode==='rotation'){sample.rotation=90;sample.displayWidth=3;sample.displayHeight=2;}
    if(mode==='flip')sample.flip=true;if(mode==='aspect'){sample.pixelAspectRatio={num:2,den:1};sample.displayWidth=4;}
    if(mode==='api')f.setAvailable(false);
    const frames=preparedDecodedFrames(source,new AbortController().signal,f.platform),first=await frames.next();
    assert.equal(first.value?.nativeFrame,undefined);assert.equal(first.value?.element,f.canvas);assert.equal(f.canvas.painted,sample);
    assert.equal(sample.draws,1);assert.equal(sample.conversions,0);assert.equal(sample.closed,1);assert.ok(first.value?.fallbackReason);
    assert.equal(first.value?.time,sample.timestamp);await frames.return();assert.equal(f.counts.disposed,1);
  }
});

test('signed and duplicate sample PTS remain original values while regressing order fails explicitly',async()=>{
  const f=fixture(3);f.samples[0].timestamp=-.01;f.samples[1].timestamp=0;f.samples[2].timestamp=0;
  const times=[];for await(const frame of preparedDecodedFrames(source,new AbortController().signal,f.platform))times.push(frame.time);
  assert.deepEqual(times,[-.01,0,0]);assert.equal(f.samples.length,3);
  const broken=fixture(2);broken.samples[0].timestamp=1;broken.samples[1].timestamp=.5;
  const frames=preparedDecodedFrames(source,new AbortController().signal,broken.platform);assert.equal((await frames.next()).value?.time,1);
  await assert.rejects(frames.next(),/표본 순서/);assert.equal(broken.samples[0].frames[0].closed,1);assert.equal(broken.samples[1].closed,1);
});

test('early return and abort while a frame is borrowed release owners without waiting for another sample',async()=>{
  const first=fixture(),frames=preparedDecodedFrames(source,new AbortController().signal,first.platform);
  await frames.next();await frames.return();assert.equal(first.samples[0].frames[0].closed,1);assert.equal(first.samples[0].closed,1);
  assert.equal(first.counts.next,1);assert.equal(first.counts.returned,1);assert.equal(first.counts.disposed,1);
  const second=fixture(),control=new AbortController(),active=preparedDecodedFrames(source,control.signal,second.platform);
  await active.next();control.abort();assert.equal(second.samples[0].frames[0].closed,1);assert.equal(second.counts.disposed,1);
  await assert.rejects(active.next(),{name:'AbortError'});assert.equal(second.samples[0].frames[0].closed,1);
});

test('abort and decoder deadline close late samples including same-turn cancellation races',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const mode of ['abort','same-turn','timeout']as const){
    const f=fixture(1),gate=f.gate(),control=new AbortController();f.platform.limits={operationTimeoutMs:10,cleanupTimeoutMs:10};
    const frames=preparedDecodedFrames(source,control.signal,f.platform),pending=frames.next(),rejected=assert.rejects(pending,mode==='timeout'?/時間|시간 초과/:{name:'AbortError'});
    await until(()=>f.counts.next===1);
    if(mode==='timeout')t.mock.timers.tick(10);else control.abort();if(mode==='same-turn')gate.resolve({done:false,value:f.samples[0]});
    await rejected;assert.equal(f.counts.disposed,1);assert.equal(f.counts.returned,1);
    if(mode!=='same-turn')gate.resolve({done:false,value:f.samples[0]});await tick();
    assert.equal(f.samples[0].closed,1);assert.equal(f.samples[0].conversions,0);
  }
});

test('cleanup deadlines are finite and late iterator-return samples still release',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(1),late=new Sample(),gate=f.returnGate();f.platform.limits={operationTimeoutMs:20,cleanupTimeoutMs:10};
  const frames=preparedDecodedFrames(source,new AbortController().signal,f.platform);await frames.next();
  const rejected=assert.rejects(frames.return(),/자원 해제 실패/);
  await until(()=>f.counts.returned===1);t.mock.timers.tick(10);await rejected;
  assert.equal(f.counts.disposed,1);assert.equal(f.samples[0].frames[0].closed,1);
  gate.resolve({done:false,value:late});await tick();assert.equal(late.closed,1);
});

test('invalid metadata, conversion/draw failures and empty input fail without leaking native resources',async()=>{
  for(const mode of ['size','time','conversion','draw','close']as const){
    const f=fixture(1),sample=f.samples[0];
    if(mode==='size'){sample.displayWidth=100_000;sample.displayHeight=100_000;}if(mode==='time')sample.timestamp=NaN;
    if(mode==='conversion')sample.conversionError=true;if(mode==='draw'){sample.rotation=90;sample.drawError=true;}if(mode==='close')sample.closeError=true;
    const frames=preparedDecodedFrames(source,new AbortController().signal,f.platform);await assert.rejects(frames.next());
    assert.equal(sample.closed,1);for(const frame of sample.frames)assert.equal(frame.closed,1);assert.equal(f.counts.disposed,1);
  }
  const empty=fixture(0);await assert.rejects(preparedDecodedFrames(source,new AbortController().signal,empty.platform).next(),/프레임이 없습니다/);
  assert.equal(empty.counts.disposed,1);
  const badLimit=fixture();badLimit.platform.limits={operationTimeoutMs:30_001};
  await assert.rejects(preparedDecodedFrames(source,new AbortController().signal,badLimit.platform).next(),/한도/);assert.equal(badLimit.counts.inputs,0);
});

test('native recovery is explicitly opt-in and cannot silently combine with the other decoder experiment',async()=>{
  const frames=recordedFrames({blob:source,duration:1},new AbortController().signal,{nativePrepared:true,explicitRgba:true});
  await assert.rejects(frames.next(),/하나만 선택/);
  const f=fixture(),control=new AbortController();control.abort();
  await assert.rejects(preparedDecodedFrames(source,control.signal,f.platform).next(),{name:'AbortError'});assert.equal(f.counts.inputs,0);
});
