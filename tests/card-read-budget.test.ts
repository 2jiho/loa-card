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
