import test from 'node:test';
import assert from 'node:assert/strict';
import {createMainThreadWork} from '../dev/main-thread-work';
test('long task diagnostics retain a bounded detached window and count omitted samples',()=>{
 const work=createMainThreadWork(100,2);
 work.add([{startTime:99,duration:80},{startTime:100,duration:50},{startTime:200,duration:100},{startTime:400,duration:200}]);
 const r=work.snapshot();assert.equal(r.count,3);assert.equal(r.totalMs,350);assert.equal(r.maxMs,200);
 assert.equal(r.samples.length,2);assert.equal(r.omitted,1);r.samples[0].duration=999;
 assert.equal(work.snapshot().samples[0].duration,50);
});
test('short and malformed timings cannot manufacture a long task',()=>{
 const work=createMainThreadWork(100);
 work.add([{startTime:100,duration:49},{startTime:NaN,duration:100},{startTime:200,duration:Infinity}]);
 assert.equal(work.snapshot().count,0);assert.equal(work.snapshot().maxMs,null);
});
