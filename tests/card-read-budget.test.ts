import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CardReadAttempts,CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/card-read-budget';

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
