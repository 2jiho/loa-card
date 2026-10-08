import {test} from 'node:test';
import assert from 'node:assert/strict';
import {merchantSchedule,merchantSessions,relativeKoreanTime,remainingTime,sessionTime} from '../src/features/merchants/merchant-schedule';
import {merchants} from '../src/features/merchants/merchant-progress';
const at=(value:string)=>Date.parse(`${value}+09:00`);
test('Korean weekday groups cover all 22 regions twice a day, including both East Luterra merchants',()=>{
 const expectedMorning=[[1,3],[1,2],[2,3],[1,2],[2],[1],[3]];
 for(let day=4;day<=10;day++){
  const now=at(`2026-10-${String(day).padStart(2,'0')}T12:00:00`);
  const sessions=merchantSessions(now).slice(4,8);
  assert.deepEqual(sessions[0].groups,expectedMorning[day-4]);
  assert.deepEqual(sessions[2].groups,sessions[0].groups);
  assert.deepEqual(sessions[3].groups,sessions[1].groups);
  for(const merchant of merchants){const s=merchantSchedule(merchant.id,now);assert.ok(s);assert.equal(s.today.length,2);assert.ok(s.next);}
 }
 assert.equal(merchantSchedule('merchant-4',at('2026-10-08T12:00:00'))?.group,2);
 assert.equal(merchantSchedule('merchant-5',at('2026-10-08T12:00:00'))?.group,3);
 assert.equal(merchantSchedule('merchant-22',at('2026-10-08T12:00:00'))?.group,1);
 assert.equal(merchantSchedule('unknown',Date.now()),null);
});
test('midnight retains yesterday weekday and ends exactly at 03:30',()=>{
 const before=merchantSchedule('merchant-3',at('2026-10-08T03:29:59'))!;
 assert.equal(before.current?.start,at('2026-10-07T22:00:00'));
 assert.equal(sessionTime(before.current!),'22:00–다음 날 03:30');
 assert.equal(merchantSchedule('merchant-1',at('2026-10-08T00:00:00'))?.current,undefined);
 const after=merchantSchedule('merchant-3',at('2026-10-08T03:30:00'))!;
 assert.equal(after.current,undefined);assert.equal(after.next?.start,at('2026-10-08T10:00:00'));
 assert.equal(merchantSchedule('merchant-2',at('2026-10-08T04:00:00'))?.current?.start,at('2026-10-08T04:00:00'));
});
test('every session is start-inclusive end-exclusive with a 30 minute global gap',()=>{
 const sessions=merchantSessions(at('2026-10-08T12:00:00')).slice(4,8);
 for(const s of sessions){
  assert.equal(s.end-s.start,330*60_000);
  const active=(now:number)=>merchantSessions(now).find(x=>x.start<=now&&now<x.end);
  assert.equal(active(s.start)?.start,s.start);assert.equal(active(s.end-1)?.start,s.start);
  assert.equal(active(s.end),undefined);assert.equal(active(s.end+29*60_000),undefined);
  assert.equal(active(s.end+30*60_000)?.start,s.end+30*60_000);
 }
});
test('year/week rollover and UTC inputs use Korean calendar, never the host timezone',()=>{
 const now=Date.parse('2026-10-07T15:00:00Z');
 assert.equal(relativeKoreanTime(at('2026-10-07T22:00:00'),now),'어제 22:00');
 const jan=at('2027-01-01T00:00:00');
 assert.equal(merchantSchedule('merchant-1',jan)?.current?.start,at('2026-12-31T22:00:00'));
 assert.equal(relativeKoreanTime(at('2027-01-01T04:00:00'),at('2026-12-31T23:50:00')),'내일 04:00');
 assert.equal(remainingTime(now+60_001,now),'2분');
 assert.equal(remainingTime(now+3_600_000,now),'1시간');
 assert.equal(merchantSchedule('merchant-1',NaN),null);
});
