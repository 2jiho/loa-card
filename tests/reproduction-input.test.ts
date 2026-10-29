import test from 'node:test';
import assert from 'node:assert/strict';
import {reproductionInput} from '../src/features/card-scanner/reproduction-input';
import type {ReproductionFile} from '../src/features/card-scanner/scan-reproduction';
import {entryParts,fastCompress,packPixels,pixelHash} from '../src/features/card-scanner/exact-recording-codec';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../src/features/card-scanner/scanner-name-configuration';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';
async function withReplayCanvas(run:(canvas:HTMLCanvasElement,draws:number[][])=>Promise<void>){
 const oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),oldImageData=Object.getOwnPropertyDescriptor(globalThis,'ImageData');
 const draws:number[][]=[];
 const canvas={width:0,height:0,getContext:()=>({putImageData:(image:{data:Uint8ClampedArray})=>draws.push([...image.data])})} as unknown as HTMLCanvasElement;
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>{assert.equal(tag,'canvas');return canvas;}}});
 Object.defineProperty(globalThis,'ImageData',{configurable:true,value:class{constructor(public data:Uint8ClampedArray,public width:number,public height:number){}}});
 try{await run(canvas,draws);}
 finally{
  if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else Reflect.deleteProperty(globalThis,'document');
  if(oldImageData)Object.defineProperty(globalThis,'ImageData',oldImageData);else Reflect.deleteProperty(globalThis,'ImageData');
 }
}


async function fixture(){
 const pixels=new Uint8Array([4,3,2,255]),hash=await pixelHash(pixels);
 const exact=new Blob(entryParts({kind:'frame',id:7,time:12.5,width:1,height:1,key:true,hash,phase:'recovery',codec:'lz4'},fastCompress(packPixels(pixels))));
 const metadata={version:4,createdAt:'2026-01-01T00:00:00Z',browser:'test',catalog:'test',build:'test',completed:true,warnings:[],
 duration:1,type:'video/webm',bytes:0,seed:[{id:'seed',review:[]} as unknown as ScannedCard],result:null,
 exact:{complete:true,frames:1,bytes:exact.size},nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION} as ReproductionFile['metadata'];
 return {metadata,video:new Blob(),exact};
}
test('shared replay supplies real pixels, capture provenance and isolated recorded seed',async()=>{
 const file=await fixture(),verified:number[]=[];
 const input=reproductionInput(file,new AbortController().signal,count=>verified.push(count));
 input.seed[0].review.push('local');assert.deepEqual(file.metadata.seed[0].review,[]);
 assert.equal(input.configurationRecorded,true);assert.equal(input.options.replay.truncated,false);
 await withReplayCanvas(async(_canvas,draws)=>{
  const frames=[];for await(const frame of input.options.replayInputs)frames.push({time:frame.time,source:frame.provenance});
  assert.equal(frames.length,1);assert.equal(frames[0].time,12.5);
  assert.equal(frames[0].source?.frameId,7);assert.equal(frames[0].source?.phase,'recovery');
  assert.deepEqual(draws,[[4,3,2,255]]);assert.deepEqual(verified,[1]);
 });
});
test('complete recorded input rejects a missing frame instead of reporting success',async()=>{
 const file=await fixture();file.metadata.exact!.frames=2;
 await withReplayCanvas(async()=>{await assert.rejects(async()=>{
  for await(const frame of reproductionInput(file,new AbortController().signal).options.replayInputs)void frame;
 });});
});
test('partial input and unknown historical name configuration remain explicit',async()=>{
 const file=await fixture();file.metadata.recordState='partial';file.metadata.exact!.complete=false;
 file.metadata.exact!.frames=2;delete file.metadata.nameConfiguration;
 const input=reproductionInput(file,new AbortController().signal);
 assert.equal(input.options.replay.truncated,true);assert.equal(input.configurationRecorded,false);
 await withReplayCanvas(async()=>{let count=0;for await(const frame of input.options.replayInputs){void frame;count++;}assert.equal(count,1);});
});
test('already cancelled replay does not construct an input generator',async()=>{
 const controller=new AbortController();controller.abort();
 assert.throws(()=>reproductionInput({} as ReproductionFile,controller.signal),{name:'AbortError'});
});
