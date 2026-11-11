import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cardReadDenialLosesEvidence,cardReadSourceKey,CardReadAdmissionDenied,CardReadAttempts,CardReadBudget,CardReadTimeout,isIncompleteCardRead} from '../src/features/card-scanner/recognition/card-read-budget';
import {reservedRecognitionBudget} from '../src/features/card-scanner/recognition/recognition-input-observer';

test('only the issuing budget owns its deadline, not an unrelated timeout or refused admission', async () => {
  const budget=new CardReadBudget(0,undefined,true),other=new CardReadBudget(0,undefined,true);
  let deadline:unknown;
  try{budget.check();}catch(error){deadline=error;}
  assert.ok(budget.ownsTimeout(deadline));
  assert.equal(budget.interruptedOperation(deadline),false);
  assert.equal(other.ownsTimeout(deadline),false);
  assert.equal(budget.ownsTimeout(new CardReadTimeout()),false);
  assert.equal(await budget.waitForQuiescence(20),true);
  assert.equal(await other.waitForQuiescence(20),false);
  const untracked=new CardReadBudget(0);
  assert.throws(()=>untracked.check(),CardReadTimeout);
  assert.equal(await untracked.waitForQuiescence(20),false);
  assert.equal(await budget.waitForQuiescence(30001),false);
});

test('timeout does not prove a worker or its asynchronous cleanup has stopped', async () => {
  const budget=new CardReadBudget(10,undefined,true);
  let finishWork!:()=>void,finishCleanup!:()=>void;
  const work=new Promise<void>(resolve=>{finishWork=resolve;}),cleanup=new Promise<void>(resolve=>{finishCleanup=resolve;});
  let error:unknown;
  try{await budget.wait(()=>work,()=>cleanup);}catch(e){error=e;}
  assert.ok(budget.ownsTimeout(error));
  assert.ok(budget.interruptedOperation(error));
  assert.equal(await budget.waitForQuiescence(5),false);
  finishWork();
  assert.equal(await budget.waitForQuiescence(5),false);
  finishCleanup();
  assert.equal(await budget.waitForQuiescence(100),true);
  await assert.rejects(budget.wait(async()=>{}),CardReadTimeout);
});

test('failed cleanup and a hung original fail closed', async () => {
  const failed=new CardReadBudget(5,undefined,true);
  await assert.rejects(failed.wait(()=>new Promise<void>(()=>{}),()=>Promise.reject(Error('termination failed'))),CardReadTimeout);
  assert.equal(await failed.waitForQuiescence(10),false);
  const hung=new CardReadBudget(5,undefined,true);
  await assert.rejects(hung.wait(()=>new Promise<void>(()=>{})),CardReadTimeout);
  assert.equal(await hung.waitForQuiescence(5),false);
});

test('a cancellation-induced worker rejection does not mask the deadline', async () => {
  const budget=new CardReadBudget(5,undefined,true);let rejectWork!:(error:Error)=>void;
  const work=new Promise<void>((_,reject)=>{rejectWork=reject;});
  let error:unknown;
  try{await budget.wait(()=>work,()=>rejectWork(new CardReadTimeout()));}catch(e){error=e;}
  assert.ok(budget.ownsTimeout(error));
  assert.equal(await budget.waitForQuiescence(50),true);
});

test('attempt budgets enable settlement tracking only when explicitly configured',async()=>{
  let now=0;
  const regular=new CardReadAttempts(()=>now).begin('crop')!;
  const experimental=new CardReadAttempts(()=>now,true).begin('crop')!;
  now=3000;
  assert.throws(()=>regular.budget.check(),CardReadTimeout);
  assert.throws(()=>experimental.budget.check(),CardReadTimeout);
  assert.equal(await regular.budget.waitForQuiescence(10),false);
  assert.equal(await experimental.budget.waitForQuiescence(10),true);
  regular.finish();experimental.finish();
});

test('one exact crop has two passes and shares three seconds of active reading, not queue time',()=>{
  let now=0;const attempts=new CardReadAttempts(()=>now);
  const first=attempts.begin('same-pixels')!;now=900;first.finish();first.finish();
  now=60_000;const second=attempts.begin('same-pixels')!;
  assert.equal(second.budget.remaining(),2100);now+=2100;
  assert.throws(()=>second.budget.check(),CardReadTimeout);second.finish();
  assert.equal(attempts.begin('same-pixels'),null);
  assert.equal(attempts.begin('clear-new-pixels')!.budget.remaining(),3000);
});
test('fast failed attempts cannot repeat forever during recovery',()=>{
  const attempts=new CardReadAttempts(()=>0);
  attempts.begin('replayed')!.finish();attempts.begin('replayed')!.finish();
  assert.equal(attempts.begin('replayed'),null);
});
test('separate observations share pixel time but reserve their own OCR stages without sharing results',()=>{
  let now=0;const attempts=new CardReadAttempts(()=>now),pixels='pixels';
  const source={sessionId:'s',frameId:93,observationId:'2925',captureOrder:772,captureTime:3,phase:'input' as const,slot:4,frame:'f93'};
  const a=cardReadSourceKey(source),b=cardReadSourceKey({...source,frameId:94,observationId:'2965',captureOrder:812,captureTime:3.1,frame:'f94'});
  assert.equal(cardReadSourceKey({...source}),a);assert.notEqual(a,b);
  const first=attempts.begin(pixels,'full',a)!;now=400;first.finish();
  assert.equal(attempts.begin(pixels,'full',a),null,'the same source cannot repeat its full read');
  assert.equal(attempts.denialReason(pixels,'full',a),'stage-used');
  assert.equal(cardReadDenialLosesEvidence(attempts.denialReason(pixels,'full',a)),false);
  const second=attempts.begin(pixels,'full',b)!;
  assert.equal(second.budget.remaining(),2600,'the new source does not reset the shared pixel clock');
  now=3000;assert.throws(()=>second.budget.check(),CardReadTimeout);second.finish();
  assert.equal(attempts.begin(pixels,'short',b),null);
  assert.equal(attempts.begin(pixels,'full','third-source'),null,'spent pixels cannot be reopened by a new source');
  assert.equal(attempts.denialReason(pixels,'full','third-source'),'time-exhausted');
  assert.equal(cardReadDenialLosesEvidence(attempts.denialReason(pixels,'full','third-source')),false);
});
test('source reservations are atomic and concurrent sources share the active-time deadline',()=>{
  let now=0;const attempts=new CardReadAttempts(()=>now);
  const a=attempts.begin('crop','short','a')!;
  assert.equal(attempts.begin('crop','short','a'),null);
  now=500;const b=attempts.begin('crop','short','b')!;
  assert.equal(b.budget.remaining(),2500);
  assert.equal(attempts.begin('crop','short','b'),null);
  now=1200;a.finish();a.finish();now=3000;
  assert.throws(()=>b.budget.check(),CardReadTimeout);b.finish();
  assert.equal(attempts.canBegin('crop','full','a'),false);
});
test('source visual reservations and entry/source limits fail closed without evicting history',()=>{
  const attempts=new CardReadAttempts(()=>0);
  attempts.begin('crop','visual','source-0')!.finish();
  assert.equal(attempts.begin('crop','visual','source-0'),null,'a source cannot repeatedly use free visual work');
  assert.equal(attempts.denialReason('crop','visual','source-0'),'visual-used');
  for(let i=1;i<16;i++)attempts.begin('crop','short',`source-${i}`)!.finish();
  assert.equal(attempts.begin('crop','short','source-16'),null,'distinct sources are bounded');
  assert.equal(attempts.denialReason('crop','short','source-16'),'source-capacity');
  assert.equal(cardReadDenialLosesEvidence(attempts.denialReason('crop','short','source-16')),true);
  assert.ok(attempts.begin('crop','full','source-0'),'recorded sources retain their remaining stage');
  assert.equal(attempts.begin('crop','short'),null,'legacy calls cannot bypass the source policy');
  assert.equal(cardReadDenialLosesEvidence(attempts.denialReason('crop','short')),true,'mode conflict is an invalid evidence boundary');
  assert.equal(cardReadDenialLosesEvidence(attempts.denialReason('','short','source')),true);
  const legacy=new CardReadAttempts(()=>0);legacy.begin('legacy','short')!.finish();
  assert.equal(legacy.begin('legacy','full','new-source'),null,'switching a legacy key cannot refund an attempt');
  for(let i=0;i<19_999;i++)legacy.begin(`p-${i}`,'short')!.finish();
  assert.equal(legacy.begin('overflow','short'),null,'entry capacity is bounded and no old entry is evicted');
  assert.equal(legacy.denialReason('overflow','short'),'key-capacity');
  assert.equal(legacy.begin('legacy','short'),null);
});
test('the total source reservation limit is bounded independently of the pixel-key limit',()=>{
  const attempts=new CardReadAttempts(()=>0);
  for(let key=0;key<2500;key++)for(let source=0;source<16;source++)
    attempts.begin(`p-${key}`,'short',`s-${source}`)!.finish();
  assert.equal(attempts.begin('new-pixel','short','new-source'),null);
  assert.equal(attempts.denialReason('new-pixel','short','new-source'),'total-source-capacity');
  assert.equal(cardReadDenialLosesEvidence(attempts.denialReason('new-pixel','short','new-source')),true);
  assert.equal(attempts.begin('p-0','short','s-0'),null,'old source stages were not evicted');
  assert.ok(attempts.begin('p-0','full','s-0'),'existing source can use its remaining stage');
});
test('read-admission stats are detached aggregate counts, not source IDs or heap estimates',()=>{
  const attempts=new CardReadAttempts(()=>0),before=attempts.stats();
  assert.deepEqual(before,{scope:'retained-admission-metadata',pixelKeys:0,sources:0,maxSourcesOnOneKey:0,
    limits:{pixelKeys:20_000,sources:40_000,sourcesPerKey:16,keyLength:1024}});
  assert.ok(Object.isFrozen(before)&&Object.isFrozen(before.limits));
  assert.equal(attempts.canBegin('card-image','short','private-source-a'),true);
  assert.deepEqual(attempts.stats(),before,'read-only admission checks do not reserve anything');
  attempts.begin('card-image','short','private-source-a')!.finish();
  attempts.begin('card-image','full','private-source-b')!.finish();
  attempts.begin('other-image','short','private-source-c')!.finish();
  attempts.beginVerifiedVisual({})!.finish();
  const after=attempts.stats();
  assert.deepEqual([after.pixelKeys,after.sources,after.maxSourcesOnOneKey],[2,3,2]);
  assert.equal(before.pixelKeys,0,'older snapshots are immutable');
  assert.doesNotMatch(JSON.stringify(after),/private-source|card-image/);
  assert.equal(attempts.begin('card-image','short','private-source-a'),null);
  assert.deepEqual(attempts.stats(),after,'refused attempts do not alter counts');
});
test('a denied duplicate or spent pass is not an operation deadline and never refunds the budget',()=>{
  let now=0;const attempts=new CardReadAttempts(()=>now);
  const short=attempts.begin('pixels','short')!;
  assert.equal(attempts.begin('pixels','short'),null,'active work has already reserved the short stage');
  const denied=new CardReadAdmissionDenied();
  assert.equal(denied instanceof CardReadTimeout,false);
  assert.equal(isIncompleteCardRead(denied),true);
  assert.equal(isIncompleteCardRead(new CardReadTimeout()),true);
  assert.equal(isIncompleteCardRead(new Error('unexpected')),false,'unexpected errors still fail the scan');
  assert.match(denied.message,/판독 시도 제한/);
  assert.equal(short.budget.ownsTimeout(denied),false);
  now=20;short.finish();
  const full=attempts.begin('pixels','full')!;
  assert.equal(full.budget.remaining(),2980,'the refusal did not reset or consume the full fallback');
  now=30;full.finish();
  assert.equal(attempts.begin('pixels','short'),null);
  assert.equal(attempts.begin('pixels','full'),null);
  assert.equal(attempts.begin('pixels','visual'),null);
  assert.equal(attempts.begin('different-pixels','short')!.budget.remaining(),3000);
});
test('diagnostic budget is unknown when no read was admitted',()=>{
  let now=0;const attempts=new CardReadAttempts(()=>now);
  const first=attempts.begin('crop','short')!;
  assert.equal(reservedRecognitionBudget(first),3000);
  assert.equal(reservedRecognitionBudget(attempts.begin('crop','short')),null,'duplicate admission reserves no budget');
  now=1000;assert.equal(reservedRecognitionBudget(first),2000);first.finish();
  const full=attempts.begin('crop','full')!;
  assert.equal(reservedRecognitionBudget(full),2000);full.finish();
  assert.equal(reservedRecognitionBudget(attempts.begin('crop','full')),null,'spent admission reserves no budget');
  assert.equal(reservedRecognitionBudget(undefined),null);
});
test('visual reading consumes the shared budget without consuming an OCR attempt',()=>{
  let now=0;const attempts=new CardReadAttempts(()=>now);
  const visual=attempts.begin('crop',false)!;now=400;visual.finish();
  const short=attempts.begin('crop')!;assert.equal(short.budget.remaining(),2600);
  now=1000;short.finish();
  const full=attempts.begin('crop')!;assert.equal(full.budget.remaining(),2000);
  full.finish();assert.equal(attempts.begin('crop',false),null);
});
test('duplicate short passes cannot consume the full fallback or refund its remaining time',()=>{
  let now=0;const attempts=new CardReadAttempts(()=>now);
  const short=attempts.begin('same-pixels','short')!;
  assert.equal(short.stage,'short');now=400;short.finish();
  assert.equal(attempts.begin('same-pixels','short'),null);
  assert.equal(attempts.canBegin('same-pixels','short'),false);
  assert.equal(attempts.canBegin('same-pixels','full'),true);
  now=60_000;
  const full=attempts.begin('same-pixels','full')!;
  assert.equal(full.stage,'full');assert.equal(full.budget.remaining(),2600);
  now+=100;full.finish();
  for(const stage of ['short','full'] as const){
    assert.equal(attempts.canBegin('same-pixels',stage),false);
    assert.equal(attempts.begin('same-pixels',stage),null);
  }
  assert.equal(attempts.begin('new-pixels','short')!.budget.remaining(),3000);
});
test('stage reservation is immediate while overlapping work shares a bounded active-time window',()=>{
  let now=0;const attempts=new CardReadAttempts(()=>now);
  const visual=attempts.begin('crop','visual')!;now=100;
  const short=attempts.begin('crop','short')!;
  assert.equal(short.budget.remaining(),2900);
  assert.equal(attempts.begin('crop','short'),null,'a pending short has already reserved its stage');
  now=200;visual.finish();visual.finish();
  now=300;short.finish();
  now=90_000;
  const full=attempts.begin('crop','full')!;
  assert.equal(full.budget.remaining(),2700,'overlapping time is counted once, with idle queue time excluded');
  assert.equal(attempts.begin('crop','full'),null);
  assert.equal(attempts.begin('independent','short')!.budget.remaining(),3000);
  now+=2700;
  assert.throws(()=>full.budget.check(),CardReadTimeout);
  assert.equal(attempts.canBegin('crop','visual'),false);
  full.finish();assert.equal(attempts.begin('crop','full'),null);
});
test('concurrent short and full passes expire at the same shared deadline',()=>{
  let now=0;const attempts=new CardReadAttempts(()=>now);
  const short=attempts.begin('crop','short')!;
  now=500;const full=attempts.begin('crop','full')!;
  assert.equal(full.budget.remaining(),2500);
  now=1200;short.finish();
  assert.equal(full.budget.remaining(),1800);
  now=3000;assert.throws(()=>full.budget.check(),CardReadTimeout);full.finish();
  assert.equal(attempts.begin('crop'),null);
});
test('a full-first read cannot reopen short OCR and legacy calls retain two distinct passes',()=>{
  const attempts=new CardReadAttempts(()=>0);
  const full=attempts.begin('full-first','full')!;full.finish();
  assert.equal(attempts.begin('full-first','short'),null);
  assert.equal(attempts.begin('full-first'),null);
  assert.equal(attempts.begin('full-first','full'),null);
  const visual=attempts.begin('legacy',false)!;assert.equal(visual.stage,'visual');visual.finish();
  const short=attempts.begin('legacy')!;assert.equal(short.stage,'short');short.finish();
  const fallback=attempts.begin('legacy',true)!;assert.equal(fallback.stage,'full');fallback.finish();
  assert.equal(attempts.begin('legacy',true),null);
});
test('a fresh verified visual token is one-shot and never restores exhausted OCR admission',()=>{
  const attempts=new CardReadAttempts(()=>0),token={};
  attempts.begin('crop','short')!.finish();attempts.begin('crop','full')!.finish();
  const fresh=attempts.beginVerifiedVisual(token)!;assert.equal(fresh.budget.remaining(),3000);fresh.finish();
  assert.equal(attempts.beginVerifiedVisual(token),null);
  assert.equal(attempts.begin('crop','short'),null);assert.equal(attempts.begin('crop','full'),null);
  assert.ok(attempts.beginVerifiedVisual({}),'another genuine observation gets its own visual-only token');
});
test('a hung operation is cancelled without waiting and late success never returns',{timeout:1000},async()=>{
  let finish!:(n:number)=>void,cancelled=0;
  const budget=new CardReadBudget(20);
  await assert.rejects(budget.wait(()=>new Promise<number>(r=>{finish=r;}),()=>{cancelled++;}),CardReadTimeout);
  assert.equal(cancelled,1);finish(42);
  assert.equal(await new CardReadBudget().wait(async()=>7),7);
});
test('already expired work never starts and cancellation errors cannot escape the timer',{timeout:1000},async()=>{
  await assert.rejects(new CardReadBudget(0).wait(async()=>assert.fail('started')),CardReadTimeout);
  await assert.rejects(new CardReadBudget(10).wait(()=>new Promise(()=>{}),()=>{throw Error('cleanup');}),CardReadTimeout);
});
