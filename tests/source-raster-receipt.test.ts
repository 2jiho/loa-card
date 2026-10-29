import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePreparedAcquisitionInput,parsePreparedRasterBinding,parseMeasuredSourceRasterReceipt,parseSourceRasterReceipt,
  validateMeasuredSourceRasterReceipt,parseAcquisitionPixelProof} from '../src/features/card-scanner/source-raster-receipt';

const input=()=>({pixels:new Uint8Array(8),width:2,height:1,binding:{sourceFrameId:7,captureTime:0}});
const receipt={version:1,kind:'measured',sourceFrameId:7,captureTime:0,acquisitionFrameId:2,width:2,height:1,hash:'a'.repeat(64)}as const;

test('prepared raster metadata and measured receipts detach/freeze bindings without copying owned pixel bytes',()=>{
  const source=input(),parsed=parsePreparedAcquisitionInput(source);source.binding.sourceFrameId=20;
  assert.equal(parsed.pixels,source.pixels);assert.equal(parsed.binding.sourceFrameId,7);assert.ok(Object.isFrozen(parsed.binding));
  const measured=parseMeasuredSourceRasterReceipt(receipt);assert.deepEqual(measured,receipt);assert.ok(Object.isFrozen(measured));
  const {version:_,kind:__,...expected}=receipt;void _;void __;
  assert.deepEqual(validateMeasuredSourceRasterReceipt(receipt,expected),receipt);
  for(const [key,value]of Object.entries({sourceFrameId:8,captureTime:1,acquisitionFrameId:3,width:1,height:2,hash:'b'.repeat(64)}))
    assert.throws(()=>validateMeasuredSourceRasterReceipt({...receipt,[key]:value},expected),/binding mismatch/);
});

test('prepared input rejects borrowed, padded, detached, shared, resizable and malformed full rasters',()=>{
  const detached=new Uint8Array(8);structuredClone(detached.buffer,{transfer:[detached.buffer]});
  const buffers=[new Uint8Array(7),new Uint8Array(12).subarray(0,8),new Uint8Array(12).subarray(2,10),
    new Uint8ClampedArray(8),new Uint8Array(new SharedArrayBuffer(8)),new Uint8Array(new ArrayBuffer(8,{maxByteLength:16})),detached];
  for(const pixels of buffers)assert.throws(()=>parsePreparedAcquisitionInput({...input(),pixels}));
  for(const value of [null,[],{}, {...input(),extra:1},{...input(),width:0},{...input(),height:NaN},
    {...input(),width:20_000,height:20_000},{...input(),binding:{sourceFrameId:0,captureTime:0}},
    {...input(),binding:{sourceFrameId:1,captureTime:Infinity}},{...input(),binding:{sourceFrameId:1,captureTime:0,hash:receipt.hash}}])
    assert.throws(()=>parsePreparedAcquisitionInput(value));
});

test('measured-only strict schema never accepts reused, extended, unsupported or nonfinite evidence',()=>{
  const invalid=[null,[],{}, {...receipt,version:2},{...receipt,kind:'analysis-reused'},
    {...receipt,originAcquisitionFrameId:1},{...receipt,hash:'A'.repeat(64)},{...receipt,hash:1},
    {...receipt,width:0},{...receipt,captureTime:NaN},{...receipt,captureTime:-1},
    {...receipt,acquisitionFrameId:Number.MAX_SAFE_INTEGER+1},{...receipt,sourceFrameId:'7'}];
  invalid.forEach(value=>assert.throws(()=>parseMeasuredSourceRasterReceipt(value)));
  assert.deepEqual(parsePreparedRasterBinding({sourceFrameId:1,captureTime:0}),{sourceFrameId:1,captureTime:0});
  assert.throws(()=>parsePreparedRasterBinding({sourceFrameId:1,captureTime:null}));
});

test('receipt union distinguishes reuse shape without claiming its origin has been measured',()=>{
  const reused={...receipt,kind:'analysis-reused',originAcquisitionFrameId:1}as const,
    parsed=parseSourceRasterReceipt(reused);
  assert.deepEqual(parseSourceRasterReceipt(receipt),receipt);assert.deepEqual(parsed,reused);assert.ok(Object.isFrozen(parsed));
  assert.equal(Object.keys(parsed).length,9);assert.throws(()=>parseMeasuredSourceRasterReceipt(reused));
  // Forward/backward origin ordering is checked by the consumer's measured map,
  // not invented by the shared shape parser.
  assert.equal(parseSourceRasterReceipt({...reused,originAcquisitionFrameId:3}).kind,'analysis-reused');
  const {originAcquisitionFrameId:_,...missing}=reused;void _;
  for(const invalid of [missing,{...reused,originAcquisitionFrameId:0},{...reused,originAcquisitionFrameId:2},
    {...reused,originAcquisitionFrameId:NaN},{...reused,originAcquisitionFrameId:'1'},
    {...reused,originAcquisitionFrameId:Number.MAX_SAFE_INTEGER+1},{...reused,extra:true},
    {...reused,version:2},{...reused,hash:'A'.repeat(64)},{...reused,captureTime:-1},
    {...reused,width:0},{...receipt,originAcquisitionFrameId:1},{...reused,kind:'reused'}])
    assert.throws(()=>parseSourceRasterReceipt(invalid));
});

test('optional pixel proof keeps bounded immutable samples and rejects malformed data rather than truncating',()=>{
  const sample=[1,2,255],parsed=parseAcquisitionPixelProof({hash:receipt.hash,sample});sample[0]=8;
  assert.deepEqual(parsed.sample,[1,2,255]);assert.ok(Object.isFrozen(parsed.sample));
  for(const value of [{hash:receipt.hash,sample:new Array(2)},{hash:receipt.hash,sample:Array(33).fill(1)},
    {hash:receipt.hash,sample:[256]},{hash:receipt.hash,sample:[1.5]},{hash:receipt.hash,sample:[-1]},
    {hash:receipt.hash,sample:[],pixels:new Uint8Array(4)}])assert.throws(()=>parseAcquisitionPixelProof(value));
});
