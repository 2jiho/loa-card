import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

test('diagnostic worker keeps source frame id, time, ROI and costs with its result',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'self');
 const replies:unknown[]=[];const scope={onmessage:null as unknown as (event:unknown)=>Promise<void>,postMessage(value:unknown){replies.push(value);}};
 const cryptoDescriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 Object.defineProperty(globalThis,'self',{configurable:true,value:scope});
 try{
  await import('../src/features/card-scanner/acquisition/frame-obstruction-worker');
  const width=150,height=110,pixels=new Uint8ClampedArray(width*height*4).fill(255);
  const roi={x:100,y:300,width,height};
  const cells=[{x:0,y:0,width:70,height:105,intact:false},{x:80,y:0,width:70,height:105,intact:false}];
  await scope.onmessage({data:{id:42,time:7.5,roi,readbackMs:2,readbackBytes:pixels.length,pixels,width,height,cells}});
  const reply=replies[0] as {id:number;time:number;roi:typeof roi;readbackMs:number;readbackBytes:number;computeMs:number;result:{canConcludeAbsence:boolean}|null};
  assert.equal(reply.id,42);assert.equal(reply.time,7.5);assert.deepEqual(reply.roi,roi);
  assert.equal(reply.readbackMs,2);assert.equal(reply.readbackBytes,pixels.length);assert.ok(reply.computeMs>=0);
  assert.equal(reply.result?.canConcludeAbsence,false);
  assert.equal('roiHash' in (reply as object),false,'hashing is opt-in');
  await scope.onmessage({data:{id:43,time:7.5,roi,readbackMs:2,readbackBytes:pixels.length,pixels,width,height,cells,hashRoi:true}});
  const hashed=replies[1] as {roiHash:{status:string;hex:string;hashMs:number;captureTimeVerified:boolean;physicalSourceVerified:boolean}};
  assert.equal(hashed.roiHash.status,'ok');assert.equal(hashed.roiHash.hex,createHash('sha256').update(pixels).digest('hex'));
  assert.ok(hashed.roiHash.hashMs>=0);assert.equal(hashed.roiHash.captureTimeVerified,false);assert.equal(hashed.roiHash.physicalSourceVerified,false);
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async()=>{throw Error('digest failure');}}}});
  await scope.onmessage({data:{id:44,time:7.5,roi,readbackMs:2,readbackBytes:pixels.length,pixels,width,height,cells,hashRoi:true}});
  const failed=replies[2] as {roiHash:{status:string;hex:null;reason:string};result:unknown};
  assert.equal(failed.roiHash.status,'failed');assert.equal(failed.roiHash.hex,null);assert.match(failed.roiHash.reason,/digest failure/);assert.ok(failed.result);
  let release!:(bytes:ArrayBuffer)=>void;
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:()=>new Promise<ArrayBuffer>(resolve=>{release=resolve;})}}});
  const pending=scope.onmessage({data:{id:45,time:7.5,roi,readbackMs:2,readbackBytes:pixels.length,pixels,width,height,cells,hashRoi:true}});
  await scope.onmessage({data:{id:46,time:7.6,roi,readbackMs:2,readbackBytes:pixels.length,pixels,width,height,cells,hashRoi:true}});
  const busy=replies[3] as {error:string;roiHash:{status:string;reason:string}};
  assert.equal(busy.error,'diagnostic-worker-busy');assert.equal(busy.roiHash.status,'failed');
  release(new ArrayBuffer(32));await pending;
 }finally{if(descriptor)Object.defineProperty(globalThis,'self',descriptor);else Reflect.deleteProperty(globalThis,'self');
  if(cryptoDescriptor)Object.defineProperty(globalThis,'crypto',cryptoDescriptor);else Reflect.deleteProperty(globalThis,'crypto');}
});
