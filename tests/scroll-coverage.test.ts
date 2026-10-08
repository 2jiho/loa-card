import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScrollCoverage} from '../src/features/card-scanner/scroll-coverage';
const all=Array<boolean>(40).fill(true);
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);

test('overlapping and adjacent four-row pages leave no actionable holes',()=>{
  const coverage=new ScrollCoverage();
  for(const position of [0,.02,.04,.12,.20])coverage.offer(position,.08,all);
  assert.deepEqual(coverage.gaps(),[]);
  coverage.offer(.281,.08,all); // pixel-level thumb quantization
  assert.deepEqual(coverage.gaps(),[]);
});
test('a skipped row warns before recognition and reverse scrolling fills it',()=>{
  const coverage=new ScrollCoverage();
  coverage.offer(0,.08,all);coverage.offer(.10,.08,all);
  assert.equal(coverage.gaps().length,1);
  near(coverage.gaps()[0].from,.08);near(coverage.gaps()[0].to,.10);
  coverage.offer(.06,.08,all);
  assert.deepEqual(coverage.gaps(),[]);
});
test('one rejected card is not hidden by good neighboring columns and can be recovered alone',()=>{
  const coverage=new ScrollCoverage(),partial=[...all];partial[27]=false;
  coverage.offer(0,.08,partial);
  assert.deepEqual(coverage.gaps(),[],'current page can still settle');
  coverage.offer(.08,.08,all);
  assert.equal(coverage.gaps().length,1);
  near(coverage.gaps()[0].from,.04);near(coverage.gaps()[0].to,.06);
  const onlyOne=Array<boolean>(40).fill(false);onlyOne[7]=true;
  coverage.offer(.04,.08,onlyOne);
  assert.deepEqual(coverage.gaps(),[],'no all-40 acceptance requirement');
});
test('top-row mode requires observation of each row and warns about jumped rows',()=>{
  const coverage=new ScrollCoverage(),top=all.map((_,i)=>i<10);
  coverage.offer(0,.08,top);coverage.offer(.02,.08,top);
  assert.deepEqual(coverage.gaps(),[]);
  coverage.offer(.08,.08,top);
  assert.equal(coverage.gaps().length,1);near(coverage.gaps()[0].from,.04);
  coverage.offer(.04,.08,top);coverage.offer(.06,.08,top);
  assert.deepEqual(coverage.gaps(),[]);
});
test('invalid geometry is ignored and new thumb scale or sort reset discards old coverage',()=>{
  const coverage=new ScrollCoverage();coverage.offer(0,.08,all);
  for(const [position,span] of [[NaN,.08],[1.2,.08],[.5,0],[.5,Infinity]])coverage.offer(position,span,all);
  coverage.offer(.9,.08,[]);assert.deepEqual(coverage.gaps(),[]);
  coverage.offer(.5,.16,all);assert.deepEqual(coverage.gaps(),[]);
  coverage.offer(.8,.16,all);assert.ok(coverage.gaps().length>0);
  coverage.reset();assert.deepEqual(coverage.gaps(),[]);
});
