import test from 'node:test';import assert from 'node:assert/strict';
import {OcrImageLimit,isIncompleteCardRead} from '../src/features/card-scanner/recognition/card-read-budget';
import {enlargedOcrSize,OCR_CANVAS_MAX_PIXELS,snapshotOcrCanvas,validateOcrCanvasSize} from '../src/features/card-scanner/recognition/ocr-canvas-snapshot';

test('inclusive side and area bounds; zero, unsafe and larger inputs are unresolved',()=>{
 assert.doesNotThrow(()=>validateOcrCanvasSize(4096,256));assert.equal(4096*256,OCR_CANVAS_MAX_PIXELS);
 for(const [w,h] of [[4097,1],[1025,1024],[0,1],[1,0],[-1,1],[NaN,1],[1.5,2],[Number.MAX_SAFE_INTEGER,2]])
  assert.throws(()=>validateOcrCanvasSize(w,h),error=>error instanceof OcrImageLimit&&isIncompleteCardRead(error));
});
test('preflight rejects an oversized expanded header before snapshot allocation',()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'document');let created=0;
 try{
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement(){created++;throw Error('allocation reached');}}});
  assert.throws(()=>snapshotOcrCanvas({width:4097,height:1} as HTMLCanvasElement),OcrImageLimit);
  assert.throws(()=>enlargedOcrSize(3000,100),OcrImageLimit);assert.equal(created,0);
 }finally{if(old)Object.defineProperty(globalThis,'document',old);else Reflect.deleteProperty(globalThis,'document');}
});
test('existing fixed-name crop and representative header scales fit the proposed limit',()=>{
 assert.deepEqual(enlargedOcrSize(128,36),{width:544,height:176});
 // Detector geometry is 200*s by 34*s; these samples are not an exhaustive
 // bound on detector tracking or proof that any given screen is detected.
 for(const scale of [0.55,1,1.59,2,2.5]){
  const header=enlargedOcrSize(Math.ceil(200*scale),Math.ceil(34*scale));
  assert.ok(header.width<=4096&&header.height<=4096&&header.width*header.height<=OCR_CANVAS_MAX_PIXELS);
 }
 assert.throws(()=>enlargedOcrSize(600,102),OcrImageLimit); // s=3 header exceeds area cap
});
