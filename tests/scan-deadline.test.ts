import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scanDeadline,scanDeadlineMessage,scanInputState,scanStatusMessage} from '../src/features/card-scanner/session/scan-deadline';

test('progress deadline restarts on input/read progress and keeps a hard cap',()=>{
  const waiting=scanDeadline({firstInputAtMs:null,nowMs:1000});
  assert.equal(waiting.state,'waiting');
  assert.equal(waiting.elapsedMs,0);
  assert.equal(waiting.remainingMs,120_000,'a manual scan gets two minutes of idle tolerance');
  assert.equal(waiting.hardRemainingMs,300_000);
  assert.equal(scanDeadline({firstInputAtMs:2000,nowMs:1000}).state,'waiting','clock regression is not progress');
  assert.equal(scanDeadline({firstInputAtMs:1000,lastProgressAtMs:1000,nowMs:1000}).state,'running');
  assert.equal(scanDeadline({firstInputAtMs:1000,lastProgressAtMs:1000,nowMs:97_000}).state,'warning');
  assert.equal(scanDeadline({firstInputAtMs:1000,lastProgressAtMs:1000,nowMs:121_000}).state,'exceeded');
  assert.equal(scanDeadline({firstInputAtMs:1000,lastProgressAtMs:1000,nowMs:24_000,limitMs:30_000}).state,'running');
  const warning=scanDeadline({firstInputAtMs:1000,lastProgressAtMs:1000,nowMs:25_000,limitMs:30_000});
  assert.equal(warning.state,'warning');
  assert.equal(warning.remainingMs,6_000);
  const exceeded=scanDeadline({firstInputAtMs:1000,lastProgressAtMs:1000,nowMs:31_000,limitMs:30_000});
  assert.equal(exceeded.state,'exceeded');
  assert.equal(exceeded.reason,'idle');
  assert.equal(exceeded.remainingMs,0);
  assert.equal(exceeded.idleMs,30_000);
  const continued=scanDeadline({firstInputAtMs:1000,lastProgressAtMs:20_000,nowMs:45_000,limitMs:30_000});
  assert.equal(continued.state,'warning','a recent read restarts the idle window');
  assert.equal(continued.remainingMs,5_000);
  const hard=scanDeadline({firstInputAtMs:1000,lastProgressAtMs:200_000,nowMs:301_000});
  assert.equal(hard.state,'exceeded');
  assert.equal(hard.reason,'hard');
  assert.throws(()=>scanDeadline({firstInputAtMs:1,nowMs:2,limitMs:0}),RangeError);
  assert.throws(()=>scanDeadline({firstInputAtMs:1,nowMs:2,warningRatio:1}),RangeError);
  assert.throws(()=>scanDeadline({firstInputAtMs:1,nowMs:2,limitMs:30_000,hardLimitMs:20_000}),RangeError);
});

test('deadline guidance distinguishes waiting, progress, warning and failure',()=>{
  assert.equal(scanDeadlineMessage(scanDeadline({firstInputAtMs:null,nowMs:0})),'카드 화면을 기다리는 중이에요.');
  assert.equal(scanDeadlineMessage(scanDeadline({firstInputAtMs:0,lastProgressAtMs:0,nowMs:10_000,limitMs:30_000})),
    '스캔 중 · 20초 안에 새 카드가 없으면 멈춰요');
  assert.match(scanDeadlineMessage(scanDeadline({firstInputAtMs:0,lastProgressAtMs:0,nowMs:25_000,limitMs:30_000})),
    /25초째 새 카드가 없어요/);
  assert.equal(scanDeadlineMessage(scanDeadline({firstInputAtMs:0,lastProgressAtMs:0,nowMs:31_000,limitMs:30_000})),
    '오랫동안 새 화면이 없어 스캔을 멈췄어요. 다시 스캔해 주세요.');
  assert.equal(scanDeadlineMessage(scanDeadline({firstInputAtMs:0,lastProgressAtMs:0,nowMs:10_000})),
    '스캔 중 · 110초 안에 새 카드가 없으면 멈춰요');
});

test('status line prefers timeout, then stall, then the deadline guidance',()=>{
  const deadline=scanDeadline({firstInputAtMs:0,lastProgressAtMs:0,nowMs:25_000,limitMs:30_000});
  assert.equal(scanStatusMessage({deadline,inputState:'receiving',idleMs:0,timedOut:true}),
    '오랫동안 새 화면이 없어 스캔을 멈췄어요. 다시 스캔해 주세요.');
  assert.equal(scanStatusMessage({deadline,inputState:'stalled',idleMs:6500,timedOut:false}),
    '7초째 화면이 바뀌지 않아요. 카드 목록을 넘겨 주세요.');
  assert.match(scanStatusMessage({deadline,inputState:'receiving',idleMs:100,timedOut:false}),/25초째 새 카드가 없어요/);
});

test('input state separates no input, recent input and a stalled scan',()=>{
  assert.equal(scanInputState({lastInputAtMs:null,nowMs:1000}).state,'waiting');
  assert.equal(scanInputState({lastInputAtMs:2000,nowMs:1000}).state,'waiting');
  assert.equal(scanInputState({lastInputAtMs:1000,nowMs:2000}).state,'receiving');
  const stalled=scanInputState({lastInputAtMs:1000,nowMs:7000});
  assert.equal(stalled.state,'stalled');
  assert.equal(stalled.idleMs,6000);
  assert.throws(()=>scanInputState({lastInputAtMs:1,nowMs:2,stallMs:0}),RangeError);
});
