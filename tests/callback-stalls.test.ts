import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeCallbackStalls} from '../scripts/analyze-callback-stalls.mjs';

const frame=(seq:number,time:number,mediaTime:number,playbackId='a')=>({seq,time,type:'source-playback',
 value:{type:'frame',playbackId,mediaTime,observedAtMs:900000+time*1000}});
const trace=(events:object[])=>({events,complete:true,dropped:0});
const perf=(samples:object[]=[])=>({clockOrigin:{runStartedAtMs:1000},mainThreadWork:{
 status:'measured',clock:'page-performance-now',omitted:0,samples}});

test('overlap uses run clock, clips and unions samples, and keeps playback sources separate',()=>{
 const r=analyzeCallbackStalls(trace([frame(1,1,0),frame(2,1.1,20,'b'),frame(3,1.2,.3)]),
  perf([{startTime:1980,duration:100},{startTime:2050,duration:100},{startTime:2190,duration:100}]));
 assert.equal(r.measuredIntervals,1);assert.equal(r.gaps[0].callbackGapMs,200);
 assert.equal(r.gaps[0].longTaskOverlapMs,160);assert.equal(r.gaps[0].mediaGapSeconds,.3);
});
test('missing, failed and truncated measurements stay explicit',()=>{
 const t=trace([frame(1,1,0),frame(2,2,1)]);
 assert.equal(analyzeCallbackStalls(t,{}).status,'unmeasured');
 assert.equal(analyzeCallbackStalls(t,{...perf(),mainThreadWork:{status:'failed'}}).status,'unmeasured');
 assert.equal(analyzeCallbackStalls({...t,complete:false},perf()).status,'partial');
 const p=perf();p.mainThreadWork.omitted=1;
 assert.equal(analyzeCallbackStalls(t,p).status,'partial');
 assert.equal(analyzeCallbackStalls(t,perf([{startTime:NaN,duration:80}])).status,'unmeasured');
});
test('regressions do not manufacture intervals and output retains only largest twenty gaps',()=>{
 const t=trace([frame(1,1,2),frame(2,.5,1),...Array.from({length:30},(_,i)=>frame(i+3,i+2,i+3))]);
 const r=analyzeCallbackStalls(t,perf());
 assert.equal(r.invalidIntervals,1);assert.equal(r.status,'partial');assert.equal(r.gaps.length,20);
 assert.equal(r.measuredIntervals,30);assert.equal(r.gaps[0].mediaGapSeconds,2);
});
