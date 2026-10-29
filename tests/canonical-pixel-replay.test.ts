import test from 'node:test';
import assert from 'node:assert/strict';
import {entryParts,exactReplayFrames,executionSummary,fastCompress,packPixels,pixelHash} from '../src/features/card-scanner/exact-recording-codec';
import type {ExactFrame} from '../src/features/card-scanner/exact-recording-codec';

type PixelSpec={kind:'pixels';id:number;time:number;value:number;canonical?:boolean;key?:boolean;hash?:string;width?:number};
type UseSpec={kind:'use';value:unknown};
const pixels=(id:number,time:number,value:number,more:Partial<PixelSpec>={}):PixelSpec=>({kind:'pixels',id,time,value,...more});
const use=(sourceFrameId:number,acquisitionFrameId:number,phase:'input'|'recovery',captureTime:number):UseSpec=>
  ({kind:'use',value:{sourceFrameId,acquisitionFrameId,phase,captureTime}});
const signal=()=>new AbortController().signal;

async function archive(specs:readonly (PixelSpec|UseSpec)[]){
  const parts:BlobPart[]=[],hashes=new Map<number,string>();let previous:Uint8Array<ArrayBuffer>|undefined,seq=0;
  for(const spec of specs){
    if(spec.kind==='use'){
      parts.push(...entryParts({kind:'event',seq:++seq,time:seq,type:'canonical-source-use',value:spec.value}));continue;
    }
    const data=new Uint8Array((spec.width??1)*4).fill(spec.value),key=spec.key??!previous;
    const hash=spec.hash??await pixelHash(data);hashes.set(spec.id,hash);
    const header:ExactFrame={kind:'frame',id:spec.id,time:spec.time,width:spec.width??1,height:1,key,hash,codec:'lz4',xor:true,
      ...(spec.canonical===false?{}:{canonical:true})};
    parts.push(...entryParts(header,fastCompress(packPixels(data,key?undefined:previous,true))));previous=data;
  }
  return {blob:new Blob(parts),hashes};
}

async function canvasScope(run:(canvas:HTMLCanvasElement,draws:number[][])=>Promise<void>){
  const oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),oldImageData=Object.getOwnPropertyDescriptor(globalThis,'ImageData');
  const draws:number[][]=[];
  const canvas={width:0,height:0,getContext:()=>({putImageData:(image:{data:Uint8ClampedArray})=>draws.push([...image.data])})} as unknown as HTMLCanvasElement;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>canvas}});
  Object.defineProperty(globalThis,'ImageData',{configurable:true,value:class {
    constructor(public data:Uint8ClampedArray<ArrayBuffer>,public width:number,public height:number){}
  }});
  try{await run(canvas,draws);}finally{
    if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else Reflect.deleteProperty(globalThis,'document');
    if(oldImageData)Object.defineProperty(globalThis,'ImageData',oldImageData);else Reflect.deleteProperty(globalThis,'ImageData');
  }
}
async function consume(blob:Blob,expectedFrames?:number,allowPartial=false){
  const seen:{time:number;frameId:number|undefined;phase:string|undefined;percent:number}[]=[];
  for await(const frame of exactReplayFrames(blob,signal(),undefined,expectedFrames,allowPartial)){
    seen.push({time:frame.time,frameId:frame.provenance?.frameId,phase:frame.provenance?.phase,percent:frame.percent});
  }
  return seen;
}

test('one physical frame replays each recorded use while an unused backup is verified without an OCR attempt',async()=>{
  const input=await archive([pixels(1,7,7),pixels(2,1,2),use(1,10,'input',7),use(1,20,'recovery',7)]);
  await canvasScope(async(canvas,draws)=>{
    const verified:{count:number;hash:string}[]=[],seen:unknown[]=[];
    for await(const frame of exactReplayFrames(input.blob,signal(),(count,hash)=>verified.push({count,hash}),2)){
      assert.equal(frame.element,canvas);assert.equal(canvas.width,1);
      seen.push(frame.provenance);
    }
    assert.deepEqual(seen,[
      {frameId:10,sourceFrameId:1,captureTime:7,phase:'input',phaseInferred:false,pixelHash:input.hashes.get(1)},
      {frameId:20,sourceFrameId:1,captureTime:7,phase:'recovery',phaseInferred:false,pixelHash:input.hashes.get(1)},
    ]);
    assert.deepEqual(draws,[[7,7,7,7],[7,7,7,7]]);
    assert.deepEqual(verified,[{count:1,hash:input.hashes.get(1)},{count:2,hash:input.hashes.get(2)}]);
    assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  });
});

test('processing-use order preserves older capture times and acquisition identities independently of storage order',async()=>{
  const input=await archive([pixels(1,9,1),pixels(2,.5,2),use(2,4,'input',.5),use(1,8,'input',9),use(2,12,'recovery',.5)]);
  await canvasScope(async(_canvas,draws)=>{
    const seen=await consume(input.blob,2);
    assert.deepEqual(seen.map(value=>[value.frameId,value.time,value.phase]),[[4,.5,'input'],[8,9,'input'],[12,.5,'recovery']]);
    assert.deepEqual(draws.map(value=>value[0]),[2,1,2]);
    assert.ok(seen.every((value,index)=>!index||value.percent>=seen[index-1].percent));assert.equal(seen.at(-1)?.percent,100);
  });
});

test('a use may arrive before its pixel transport commits, and lookup resolves after the bounded index is built',async()=>{
  const input=await archive([use(2,31,'input',2),pixels(1,1,1),pixels(2,2,2)]);
  await canvasScope(async(_canvas,draws)=>{
    assert.deepEqual((await consume(input.blob,2)).map(value=>value.frameId),[31]);assert.deepEqual(draws,[[2,2,2,2]]);
  });
});

test('expected frame count means stored physical frames, including unused backups',async()=>{
  const input=await archive([pixels(1,1,1),pixels(2,2,2),use(1,4,'input',1),use(1,5,'recovery',1)]);
  await canvasScope(async(canvas)=>{
    await assert.rejects(consume(input.blob,1),/프레임 수 불일치/);assert.equal(canvas.width,0);
    await assert.rejects(consume(input.blob,3),/프레임 수 불일치/);assert.equal(canvas.width,0);
    assert.equal((await consume(input.blob,2)).length,2);
  });
});

test('corrupt unused backups still fail verification instead of silently passing a successful use',async()=>{
  const input=await archive([pixels(1,1,1),pixels(2,2,2,{hash:'0'.repeat(64)}),use(1,9,'input',1)]);
  await canvasScope(async(canvas)=>{
    let verified=0;
    await assert.rejects(async()=>{for await(const _frame of exactReplayFrames(input.blob,signal(),()=>verified++,2)){/* consume */}},/픽셀|hash|해시|불일치/);
    assert.equal(verified,1);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  });
});

test('a corrupt used frame or truncated envelope cannot be accepted even in partial mode',async()=>{
  const wrong=await archive([pixels(1,1,1,{hash:'0'.repeat(64)}),use(1,2,'input',1)]);
  const good=await archive([pixels(1,1,1),use(1,2,'input',1)]);
  await canvasScope(async(canvas)=>{
    for(const partial of [false,true]){
      await assert.rejects(consume(wrong.blob,1,partial),/픽셀|hash|해시|불일치/);
      await assert.rejects(consume(good.blob.slice(0,good.blob.size-1),1,partial),/길이|잘린/);
      assert.equal(canvas.width,0);
    }
  });
});

test('missing source references fail complete replay and are skipped only when partial replay is explicit',async()=>{
  const input=await archive([pixels(1,1,1),use(99,2,'input',3),use(1,5,'recovery',1)]);
  await canvasScope(async(canvas,draws)=>{
    await assert.rejects(consume(input.blob,1),/기록에 없습니다/);assert.equal(canvas.width,0);
    assert.deepEqual((await consume(input.blob,1,true)).map(value=>value.frameId),[5]);
    assert.deepEqual(draws,[[1,1,1,1]]);
  });
});

test('partial mode cannot invent a use when every reference is absent or only unused pixels exist',async()=>{
  const missing=await archive([pixels(1,1,1),use(99,2,'input',3)]);
  const unused=await archive([pixels(1,1,1)]);
  await canvasScope(async(canvas,draws)=>{
    await assert.rejects(consume(missing.blob,1,true),/판독 사용 기록/);
    await assert.rejects(consume(unused.blob,1,true),/판독 사용 기록/);
    assert.equal(draws.length,0);assert.equal(canvas.width,0);
  });
});

test('source-use time must match the original capture even if archive event time differs',async()=>{
  const input=await archive([pixels(1,1,1),use(1,2,'recovery',1.01)]);
  await canvasScope(async(canvas)=>{
    await assert.rejects(consume(input.blob,1),/사용 시각 불일치/);assert.equal(canvas.width,0);
  });
});

test('duplicate or regressing acquisition use IDs are rejected independently of source IDs',async()=>{
  for(const lastId of [4,3]){
    const input=await archive([pixels(1,1,1),use(1,4,'input',1),use(1,lastId,'recovery',1)]);
    await canvasScope(async(canvas)=>{await assert.rejects(consume(input.blob,1),/사용 순서/);assert.equal(canvas.width,0);});
  }
});

test('malformed source-use events are rejected by both pixel replay and execution inspection',async()=>{
  const valid=use(1,2,'input',1).value as Record<string,unknown>;
  for(const value of [null,[],{...valid,sourceFrameId:0},{...valid,acquisitionFrameId:1.2},{...valid,phase:'backup'},
    {...valid,captureTime:-1},{...valid,arbitrary:'extension'},{sourceFrameId:1,acquisitionFrameId:2,phase:'input'}]){
    const input=await archive([pixels(1,1,1),{kind:'use',value}]);
    await canvasScope(async(canvas)=>{await assert.rejects(consume(input.blob,1),/공통 원본 사용 기록/);assert.equal(canvas.width,0);});
    await assert.rejects(executionSummary(input.blob,signal()),/공통 원본 사용 기록/);
  }
});

test('canonical and legacy physical frame formats cannot be mixed in either direction',async()=>{
  for(const flags of [[true,false],[false,true]]){
    const input=await archive([pixels(1,1,1,{canonical:flags[0]}),pixels(2,2,2,{canonical:flags[1]}),use(1,2,'input',1)]);
    await canvasScope(async(canvas)=>{await assert.rejects(consume(input.blob,2),/혼합/);assert.equal(canvas.width,0);});
  }
});

test('early exit and abort release the replay canvas without adding an unrecorded attempt',async()=>{
  const input=await archive([pixels(1,1,1),use(1,4,'input',1),use(1,5,'recovery',1)]);
  await canvasScope(async(canvas,draws)=>{
    for await(const _frame of exactReplayFrames(input.blob,signal()))break;
    assert.equal(draws.length,1);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
    const controller=new AbortController();
    await assert.rejects(async()=>{for await(const _frame of exactReplayFrames(input.blob,controller.signal)){controller.abort();}},{name:'AbortError'});
    assert.equal(draws.length,2);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  });
});

test('execution inspection counts source uses separately from physical pixels and preserves partial status',async()=>{
  const input=await archive([pixels(1,1,1),use(1,4,'input',1),use(1,5,'recovery',1)]);
  const totals={complete:false,dropped:null,frames:1,events:2};
  const result=await executionSummary(input.blob,signal(),totals);
  assert.equal(result.frames,1);assert.equal(result.events,2);assert.equal(result.kinds['canonical-source-use'],2);
  assert.equal(result.recordingComplete,false);assert.equal(result.input.matchesCapturedState,null);
});
