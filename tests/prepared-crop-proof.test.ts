import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPreparedCropProver,PREPARED_CROP_PROOF_LIMITS} from '../src/features/card-scanner/acquisition/prepared-crop-proof';
import {integerCropPixels} from '../src/features/card-scanner/acquisition/integer-crop-pixels';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';
import type {MeasuredSourceRasterReceipt} from '../src/features/card-scanner/acquisition/source-raster-receipt';

type Sample={name:string;intact:boolean;width:number;height:number;box:{x:number;y:number;width:number;height:number};rgba:string};
const samples=JSON.parse(readFileSync(new URL('./fixtures/border-integrity-samples.json',import.meta.url),'utf8')) as Sample[];
const makeFrame=async(source:Uint8ClampedArray,width:number,height:number):Promise<MeasuredSourceRasterReceipt>=>({
 version:1,kind:'measured',sourceFrameId:3,captureTime:1.25,acquisitionFrameId:9,width,height,hash:await pixelHash(new Uint8Array(source))});
const makeCell=(source:Uint8ClampedArray,width:number,height:number,content:{x:number;y:number;width:number;height:number},slot=0)=>({slot,content,complete:true,
 pixels:{width:content.width,height:content.height,data:integerCropPixels(source,width,height,content)!}});
const accounted=(proof:{total:number;checked:number;unsupported:number;mismatch:number;overBudget:number;hashFailed:number})=>
 assert.equal(proof.total,proof.checked+proof.unsupported+proof.mismatch+proof.overBudget+proof.hashFailed);

test('actual normal and tooltip card crops bind only exact opaque pixels to the measured frame',async()=>{
 for(const sample of samples){
  const source=new Uint8ClampedArray(Buffer.from(sample.rgba,'base64')),frame=await makeFrame(source,sample.width,sample.height),
    cell=makeCell(source,sample.width,sample.height,sample.box),proof=await createPreparedCropProver().measure(frame,source,[cell]);
  accounted(proof);assert.equal(proof.checked,1,sample.name);assert.equal(proof.frameCheck,'match');assert.equal(proof.frameBytesHashed,source.byteLength);
  assert.equal(proof.crops[0].sha256,await pixelHash(new Uint8Array(cell.pixels.data)));assert.deepEqual(proof.crops[0].content,sample.box);
  assert.equal(proof.scope,'prepared-worker-crop');assert.equal(proof.timedOut,false);assert.equal(proof.hashBusy,false);
 }
});

test('crop geometry, duplicate slots, transparency and changed source reject without asserting unobstructed cards',async()=>{
 const source=new Uint8ClampedArray(8*8*4).fill(255),frame=await makeFrame(source,8,8),box={x:1,y:1,width:2,height:2};
 const valid=makeCell(source,8,8,box),bad=makeCell(source,8,8,box,1);bad.pixels.data[0]=0;
 const transparent=makeCell(source,8,8,box,2);transparent.pixels.data[3]=128;
 const cropped={...makeCell(source,8,8,box,3),complete:false};
 const fractional={...makeCell(source,8,8,box,4),content:{...box,x:1.5}};
 const duplicate1=makeCell(source,8,8,box,5),duplicate2=makeCell(source,8,8,box,5);
 const p=await createPreparedCropProver().measure(frame,source,[valid,bad,transparent,cropped,fractional,duplicate1,duplicate2]);
 accounted(p);assert.deepEqual(p.crops.map(x=>x.slot),[0]);assert.equal(p.mismatch,1);assert.equal(p.unsupported,5);assert.equal(p.frameCheck,'match');
});

test('digest-time crop, frame and later-cell mutations never yield stale positive evidence',async()=>{
 const source=new Uint8ClampedArray(8*8*4).fill(255),frame=await makeFrame(source,8,8),box={x:1,y:1,width:2,height:2};
 {
  const a=makeCell(source,8,8,box),prover=createPreparedCropProver({hash:async bytes=>{a.pixels.data[0]^=1;return pixelHash(bytes);}});
  const p=await prover.measure(frame,source,[a]);accounted(p);assert.equal(p.checked,0);assert.equal(p.hashFailed,1);
 }
 {
  const a=makeCell(source,8,8,box),b=makeCell(source,8,8,box,1);let calls=0;
  const prover=createPreparedCropProver({hash:async bytes=>{if(++calls===2)a.pixels.data[0]^=1;return pixelHash(bytes);}});
  const p=await prover.measure(frame,source,[a,b]);accounted(p);assert.equal(p.frameCheck,'match');assert.deepEqual(p.crops.map(x=>x.slot),[1]);assert.equal(p.hashFailed,1);
 }
 {
  const a=makeCell(source,8,8,box);let calls=0;
  const prover=createPreparedCropProver({hash:async bytes=>{if(++calls===2)source[0]^=1;return pixelHash(bytes);}});
  const p=await prover.measure(frame,source,[a]);accounted(p);assert.equal(p.frameCheck,'mismatch');assert.equal(p.checked,0);assert.equal(p.hashFailed,1);
 }
});

test('digest byte limits account for all omitted cells and block oversized frames',async()=>{
 const width=512,height=512,source=new Uint8ClampedArray(width*height*4).fill(255),frame=await makeFrame(source,width,height),box={x:0,y:0,width,height};
 const crop=integerCropPixels(source,width,height,box)!;
 const cells=Array.from({length:9},(_,slot)=>({slot,content:box,complete:true,pixels:{width,height,data:crop}}));
 const p=await createPreparedCropProver({deadlineMs:5000}).measure(frame,source,cells);accounted(p);
 assert.equal(p.checked,8);assert.equal(p.overBudget,1);assert.equal(p.bytesHashed,PREPARED_CROP_PROOF_LIMITS.totalBytes);
 const large=new Uint8ClampedArray(PREPARED_CROP_PROOF_LIMITS.frameBytes+4),largeFrame=await makeFrame(large,large.length/4,1);
 const skipped=await createPreparedCropProver().measure(largeFrame,large,[{slot:0,content:{x:0,y:0,width:1,height:1},complete:true,pixels:{width:1,height:1,data:large.slice(0,4)}}]);
 accounted(skipped);assert.equal(skipped.frameCheck,'unsupported');assert.equal(skipped.unsupported,1);assert.equal(skipped.frameBytesHashed,0);
});

test('stalled digest reaches deadline and blocks new hashes until the old digest settles',async()=>{
 const source=new Uint8ClampedArray(8*8*4).fill(255),frame=await makeFrame(source,8,8),box={x:1,y:1,width:2,height:2};
 let release!:(value:string)=>void,calls=0;
 const stuck=new Promise<string>(resolve=>{release=resolve;});
 const prover=createPreparedCropProver({deadlineMs:25,hash:async bytes=>{calls++;return calls===1?stuck:pixelHash(bytes);}}),
  cells=[makeCell(source,8,8,box),makeCell(source,8,8,box,1)];
 const first=await prover.measure(frame,source,cells);accounted(first);assert.equal(first.timedOut,true);assert.equal(first.checked,0);
 assert.equal(first.hashFailed,2);assert.equal(first.bytesHashed,16);assert.equal(first.frameCheck,'failed');
 const second=await prover.measure(frame,source,cells);accounted(second);assert.equal(second.hashBusy,true);assert.equal(second.checked,0);assert.equal(calls,1);
 release('a'.repeat(64));await new Promise(resolve=>setTimeout(resolve,0));
 const third=await prover.measure(frame,source,cells);accounted(third);assert.equal(third.hashBusy,false);assert.equal(third.timedOut,false);assert.equal(third.checked,2);
});

test('failure or timeout in the final frame digest cannot leave a crop proof',async()=>{
 const source=new Uint8ClampedArray(8*8*4).fill(255),frame=await makeFrame(source,8,8),cell=makeCell(source,8,8,{x:1,y:1,width:2,height:2});
 for(const mode of ['failure','timeout'] as const){
  let calls=0;const prover=createPreparedCropProver({deadlineMs:25,hash:async bytes=>{
   if(++calls===2){if(mode==='failure')throw Error('digest failed');return new Promise<string>(()=>{});}
   return pixelHash(bytes);
  }});
  const result=await prover.measure(frame,source,[cell]);accounted(result);
  assert.equal(result.checked,0);assert.equal(result.hashFailed,1);assert.equal(result.frameCheck,'failed');
  assert.equal(result.frameBytesHashed,source.byteLength);assert.equal(result.timedOut,mode==='timeout');
 }
});

test('a replaced cell, crop, data buffer, or geometry cannot authorize different transmitted pixels',async()=>{
 const source=new Uint8ClampedArray(8*8*4).fill(255),frame=await makeFrame(source,8,8),box={x:1,y:1,width:2,height:2};
 for(const mode of ['cell','raster','data','geometry-object','geometry-value','slot','complete','dimensions'] as const){
  const cell=makeCell(source,8,8,box),cells=[cell];let calls=0;
  const prover=createPreparedCropProver({hash:async bytes=>{
   if(++calls===2){
    if(mode==='cell')cells[0]={...cell};
    if(mode==='raster')cell.pixels={...cell.pixels};
    if(mode==='data')cell.pixels.data=cell.pixels.data.slice();
    if(mode==='geometry-object')cell.content={...cell.content};
    if(mode==='geometry-value')cell.content.x=2;
    if(mode==='slot')cell.slot=1;
    if(mode==='complete')cell.complete=false;
    if(mode==='dimensions')cell.pixels.width=1;
   }
   return pixelHash(bytes);
  }});
  const proof=await prover.measure(frame,source,cells);accounted(proof);
  assert.equal(proof.frameCheck,'match',mode);assert.equal(proof.checked,0,mode);assert.equal(proof.hashFailed,1,mode);
 }
});
