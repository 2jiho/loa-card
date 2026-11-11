import test from 'node:test';import assert from 'node:assert/strict';
import {OcrResourceUnavailable} from '../src/features/card-scanner/recognition/ocr-worker-leases';
import {emitOcrResourceNotice,ocrResourceNotice} from '../src/features/card-scanner/recognition/ocr-resource-notice';

test('capacity and cleanup uncertainty produce distinct retry guidance',()=>{
 const capacity=ocrResourceNotice(new OcrResourceUnavailable('capacity'));
 const cleanup=ocrResourceNotice(new OcrResourceUnavailable('cleanup'));
 assert.match(capacity!,/기다리고/);assert.match(cleanup!,/확인하지 못했습니다/);
 for(const value of [capacity,cleanup])assert.match(value!,/부분 결과/);
 assert.equal(ocrResourceNotice(Error('unrelated')),null);
});
test('notice is published before caller continues; a failed publisher cannot mask the scanner failure',()=>{
 const error=new OcrResourceUnavailable('capacity'),state:{captureWarning?:string}={},order:string[]=[];
 assert.equal(emitOcrResourceNotice(error,state,()=>{order.push('emit');assert.match(state.captureWarning!,/기다리고/);}),true);
 order.push('caller-failure');assert.deepEqual(order,['emit','caller-failure']);
 assert.equal(emitOcrResourceNotice(error,state,()=>{throw Error('publisher failed');}),true);
 assert.equal(emitOcrResourceNotice(Error('other'),state,()=>{throw Error('unexpected');}),false);
});
