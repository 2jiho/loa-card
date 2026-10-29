import assert from 'node:assert/strict';
import test from 'node:test';
import {entryParts,exactEntries,exactPixels,exactReplayFrames,executionSummary,fastCompress,packPixels,pixelHash,type ExactFrame} from '../src/features/card-scanner/exact-recording-codec';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY} from '../src/features/card-scanner/rgba-window-policy';

const signal=()=>new AbortController().signal;
async function archive(count=3,window=true,extra?:{badHash?:number;missingPolicy?:number;legacyAt?:number;ninthDelta?:boolean}){
  const parts:BlobPart[]=[],values:Uint8Array<ArrayBuffer>[]=[],headers:ExactFrame[]=[];
  let previous:Uint8Array<ArrayBuffer>|undefined;
  for(let i=0;i<count;i++){
    const pixels=new Uint8Array([i+1,3,5,255,9,7,8,255]);values.push(pixels);
    const key=i===0||i%8===0&&!extra?.ninthDelta,isWindow=window&&extra?.legacyAt!==i;
    const header:ExactFrame={kind:'frame',id:i+1,time:i===1?.25:i,width:2,height:1,key,
      hash:extra?.badHash===i?'0'.repeat(64):await pixelHash(pixels),codec:isWindow?RGBA_WINDOW_CODEC:'lz4',
      ...(isWindow&&extra?.missingPolicy!==i?{policy:RGBA_WINDOW_POLICY}:{}),canonical:true,xor:true,phase:'input'};
    parts.push(...entryParts(header,fastCompress(packPixels(pixels,key?undefined:previous,true))));headers.push(header);previous=pixels;
  }
  return{blob:new Blob(parts),parts,values,headers};
}
async function decoded(blob:Blob,window=true){const values:Uint8Array[]=[],buffers:ArrayBuffer[]=[];
  for await(const frame of exactPixels(blob,signal(),0,window?RGBA_WINDOW_POLICY:undefined)){values.push(frame.pixels.slice());buffers.push(frame.pixels.buffer);}
  return{values,buffers};
}
test('window decoding is explicit; unchanged legacy frames decode with the legacy call',async()=>{
  const current=await archive(),legacy=await archive(3,false);
  await assert.rejects(async()=>{for await(const _frame of exactPixels(current.blob,signal()))void _frame;},/정책/);
  assert.deepEqual((await decoded(current.blob)).values,current.values);
  assert.deepEqual((await decoded(legacy.blob,false)).values,legacy.values);
  await assert.rejects(()=>decoded(legacy.blob),/정책/);
});
test('window supports eight dependencies followed by a required ninth key',async()=>{
  const good=await archive(10),bad=await archive(9,true,{ninthDelta:true});
  assert.deepEqual((await decoded(good.blob)).values,good.values);
  await assert.rejects(async()=>{for await(const _entry of exactEntries(bad.blob,signal()))void _entry;},/dependency/);
});
test('window output snapshots stay independent while one decoder target is reused',async()=>{
  const input=await archive(10),frames=[];
  for await(const frame of exactPixels(input.blob,signal(),0,RGBA_WINDOW_POLICY))frames.push(frame);
  assert.deepEqual(frames.map(frame=>frame.pixels),input.values);
  frames[0].pixels.fill(99);assert.deepEqual(frames[1].pixels,input.values[1]);
});
test('missing inner policy and mixed old/new frames fail before yielding an invalid entry',async()=>{
  for(const extra of [{missingPolicy:0},{legacyAt:1}]){
    const input=await archive(3,true,extra);await assert.rejects(()=>decoded(input.blob));
  }
});
test('a bad output hash never publishes its frame; prior verified output remains intact',async()=>{
  const input=await archive(3,true,{badHash:1}),published=[];
  await assert.rejects(async()=>{for await(const frame of exactPixels(input.blob,signal(),0,RGBA_WINDOW_POLICY))published.push(frame);},/픽셀 불일치/);
  assert.equal(published.length,1);assert.deepEqual(published[0].pixels,input.values[0]);
});
test('window metadata cannot select native storage or an unknown policy',async()=>{
  const input=await archive(1);
  await assert.rejects(async()=>{for await(const _frame of exactPixels(input.blob,signal(),1,RGBA_WINDOW_POLICY))void _frame;});
  await assert.rejects(async()=>{for await(const _frame of exactPixels(input.blob,signal(),0,'other' as typeof RGBA_WINDOW_POLICY))void _frame;});
});
test('execution summary requires matching explicit codec/policy totals and rejects downgrade',async()=>{
  const input=await archive(2),totals={complete:false,dropped:null,frames:2,events:0,codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY};
  assert.equal((await executionSummary(input.blob,signal(),totals)).frames,2);
  await assert.rejects(()=>executionSummary(input.blob,signal(),{complete:false,dropped:null,frames:2,events:0}),/정책/);
  await assert.rejects(()=>executionSummary(input.blob,signal(),{...totals,codec:undefined}),/정책/);
});
async function withCanvas(run:(draws:number[][])=>Promise<void>){
  const documentBefore=Object.getOwnPropertyDescriptor(globalThis,'document'),imageBefore=Object.getOwnPropertyDescriptor(globalThis,'ImageData');
  const draws:number[][]=[],canvas={width:0,height:0,getContext:()=>({putImageData:(value:{data:Uint8ClampedArray})=>draws.push([...value.data])})};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>canvas}});
  Object.defineProperty(globalThis,'ImageData',{configurable:true,value:class{constructor(public data:Uint8ClampedArray,public width:number,public height:number){}}});
  try{await run(draws);}finally{
    if(documentBefore)Object.defineProperty(globalThis,'document',documentBefore);else Reflect.deleteProperty(globalThis,'document');
    if(imageBefore)Object.defineProperty(globalThis,'ImageData',imageBefore);else Reflect.deleteProperty(globalThis,'ImageData');
  }
}
test('actual canonical replay follows recorded uses and verifies an unused backup without inventing a use',async()=>withCanvas(async draws=>{
  const input=await archive(3),events=[
    {kind:'event' as const,seq:1,time:3,type:'canonical-source-use',value:{sourceFrameId:2,acquisitionFrameId:40,captureTime:.25,phase:'input'}},
    {kind:'event' as const,seq:2,time:4,type:'canonical-source-use',value:{sourceFrameId:1,acquisitionFrameId:41,captureTime:0,phase:'recovery'}},
    {kind:'event' as const,seq:3,time:5,type:'canonical-source-use',value:{sourceFrameId:2,acquisitionFrameId:42,captureTime:.25,phase:'recovery'}},
  ],blob=new Blob([...input.parts,...events.flatMap(event=>entryParts(event))]),uses=[],verified:number[]=[];
  for await(const frame of exactReplayFrames(blob,signal(),count=>verified.push(count),3,false,0,RGBA_WINDOW_POLICY))uses.push(frame.provenance);
  assert.deepEqual(draws,[input.values[1],input.values[0],input.values[1]].map(value=>[...value]));
  assert.deepEqual(uses.map(use=>[use?.sourceFrameId,use?.frameId,use?.phase]),[[2,40,'input'],[1,41,'recovery'],[2,42,'recovery']]);
  assert.equal(verified.at(-1),3);
}));
test('canonical replay rejects outer/header mismatch before drawing pixels or yielding an input',async()=>withCanvas(async draws=>{
  const input=await archive(2,false);let inputs=0;
  await assert.rejects(async()=>{for await(const _frame of exactReplayFrames(input.blob,signal(),undefined,2,false,0,RGBA_WINDOW_POLICY))inputs++;},/정책/);
  assert.equal(inputs,0);assert.deepEqual(draws,[]);
}));
