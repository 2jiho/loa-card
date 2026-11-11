import test from 'node:test';
import assert from 'node:assert/strict';
import {comparabilityIssues,deliveryFaithful,diffRuns,sameInput,summarizeRun} from '../dev/recording-runs';
import type {RunCard,RunReport} from '../dev/recording-runs';

const card=(id:string,name:string,awakening:number|null=0,extraCopies:number|null=0):RunCard=>({id,name,awakening,extraCopies});

test('a diff separates read-only-in-one, changed, and identical cards regardless of order', () => {
  const a=[card('1','가'),card('2','나',1,2),card('3','다')];
  const b=[card('3','다'),card('2','나',1,3),card('4','라')];
  const diff=diffRuns(a,b);
  assert.deepEqual(diff.onlyA.map(item=>item.id),['1']);
  assert.deepEqual(diff.onlyB.map(item=>item.id),['4']);
  assert.deepEqual(diff.changed.map(item=>[item.a.extraCopies,item.b.extraCopies]),[[2,3]]);
  assert.equal(diff.same,1);
});

test('unread fields are not equal to a read zero', () => {
  const diff=diffRuns([card('1','가',null,null)],[card('1','가',0,0)]);
  assert.equal(diff.changed.length,1,'null (not read) and 0 (observed zero) stay different');
  assert.equal(diff.same,0);
});

test('identical runs have an empty diff', () => {
  const cards=[card('1','가'),card('2','나',2,1)];
  const diff=diffRuns(cards,[...cards].reverse());
  assert.deepEqual([diff.onlyA.length,diff.onlyB.length,diff.changed.length,diff.same],[0,0,0,2]);
});

test('summaries record how complete the replayed input was', () => {
  const delivery={meanLateMs:12,maxLateMs:90,lateOver33Ms:4,frames:70,declaredFrames:100};
  const summary=summarizeRun({build:'abc',read:383,expected:385,unidentified:1,delivery});
  assert.equal(summary.deliveredRatio,0.7);
  assert.deepEqual([summary.read,summary.expected,summary.maxLateMs],[383,385,90]);
  assert.equal(summarizeRun({build:'x',read:0,expected:null,unidentified:0,delivery:{...delivery,declaredFrames:0,frames:0}}).deliveredRatio,0);
});

test('only equal, known input hashes count as the same input', () => {
  const report=(sha256:string|null):RunReport=>({kind:'recording-replay',version:1,startedAt:'',finishedAt:'',
    recording:{id:'r',sha256,complete:true,frames:1},delivery:null,status:'',cards:[],
    summary:summarizeRun({build:'b',read:0,expected:null,unidentified:0,delivery:{meanLateMs:0,maxLateMs:0,lateOver33Ms:0,frames:1,declaredFrames:1}})});
  assert.equal(sameInput(report('a'.repeat(64)),report('a'.repeat(64))),true);
  assert.equal(sameInput(report('a'.repeat(64)),report('b'.repeat(64))),false);
  assert.equal(sameInput(report(null),report(null)),false,'an unhashed recording is never proven identical');
});

test('a replay is faithful only when it kept the recorded cadence', () => {
  const base={meanLateMs:3,maxLateMs:40,lateOver33Ms:2,frames:540,declaredFrames:543};
  assert.equal(deliveryFaithful(base),true);
  assert.equal(deliveryFaithful({...base,maxLateMs:400}),false,'one very late frame lets the pipeline merge neighbours');
  assert.equal(deliveryFaithful({...base,lateOver33Ms:200}),false,'persistent lateness');
  assert.equal(deliveryFaithful({...base,frames:400}),false,'input cut short');
  assert.equal(deliveryFaithful({...base,frames:0}),false);
  assert.equal(deliveryFaithful({...base,declaredFrames:0}),false);
});

test('runs are comparable only with equal input hashes and faithful delivery on both sides', () => {
  const good={meanLateMs:2,maxLateMs:30,lateOver33Ms:0,frames:100,declaredFrames:100};
  const report=(sha:string|null,delivery=good):RunReport=>({kind:'recording-replay',version:1,startedAt:'',finishedAt:'',
    recording:{id:'r',sha256:sha,complete:true,frames:100},delivery:null,status:'',cards:[],
    summary:summarizeRun({build:'b',read:0,expected:null,unidentified:0,delivery})});
  const hash='a'.repeat(64);
  assert.deepEqual(comparabilityIssues(report(hash),report(hash)),[]);
  const late=report(hash,{...good,maxLateMs:5000,meanLateMs:2800,lateOver33Ms:99});
  assert.equal(comparabilityIssues(report(hash),late).length,1);
  assert.match(comparabilityIssues(report(hash),late)[0],/B의 재실행/);
  assert.equal(comparabilityIssues(report(hash),report('b'.repeat(64))).length,1);
  assert.equal(comparabilityIssues(report(null),late).length,2,'unproven input and a late replay');
});

test('a sequential replay is faithful when every frame was fed; mixed modes are flagged', () => {
  const sequential={meanLateMs:0,maxLateMs:0,lateOver33Ms:0,frames:2171,declaredFrames:2171,mode:'sequential' as const};
  assert.equal(deliveryFaithful(sequential),true,'a sequential replay has no cadence to miss');
  assert.equal(deliveryFaithful({...sequential,frames:1000}),false,'input cut short');
  assert.equal(deliveryFaithful({...sequential,frames:0}),false);
  assert.equal(deliveryFaithful({...sequential,mode:'realtime',maxLateMs:5000,lateOver33Ms:2000}),false,'the same lateness fails the realtime test');
  const report=(delivery:Parameters<typeof summarizeRun>[0]['delivery']):RunReport=>({kind:'recording-replay',version:1,startedAt:'',finishedAt:'',
    recording:{id:'r',sha256:'a'.repeat(64),complete:true,frames:100},delivery:null,status:'',cards:[],
    summary:summarizeRun({build:'b',read:0,expected:null,unidentified:0,delivery})});
  const realtimeGood={meanLateMs:2,maxLateMs:30,lateOver33Ms:0,frames:2171,declaredFrames:2171};
  const issues=comparabilityIssues(report(sequential),report(realtimeGood));
  assert.equal(issues.length,1);assert.match(issues[0],/재생 방식/);
  assert.equal(comparabilityIssues(report(sequential),report(sequential)).length,0);
  assert.equal(summarizeRun({build:'b',read:0,expected:null,unidentified:0,delivery:realtimeGood}).mode,'realtime','older reports without a mode count as realtime');
});
