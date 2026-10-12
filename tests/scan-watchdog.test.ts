import {test} from 'node:test';
import assert from 'node:assert/strict';
import {guardScan,ScanProgressClock,ScanStalledError,scanLimits} from '../src/features/card-scanner/scan-watchdog.ts';
import type {ScannerState} from '../src/features/card-scanner/scanner';

const snapshot=(extra:Partial<ScannerState>={}):ScannerState=>({status:'처리 중',percent:0,sampled:0,stable:0,
  expected:null,capacity:null,cards:[],located:true,unreadable:0,queued:0,droppedFrames:0,unidentified:[],workPhase:'recovery',...extra});
const never=()=>new Promise<void>(()=>{});
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

test('status/queue changes do not reset a stalled scan; actual processed frames do',()=>{
  const clock=new ScanProgressClock(0);clock.observe(snapshot(),0);clock.ready(0);
  clock.observe(snapshot({status:'다른 문구',queued:20}),40_000);
  assert.equal(clock.check(45_000,true,false),'stalled');
  clock.observe(snapshot({sampled:1}),45_001);
  assert.equal(clock.check(80_000,true,false),null);
});
test('long processing with progress continues and stationary live sharing is not a stall',()=>{
  const clock=new ScanProgressClock(0);clock.ready(0);
  for(let i=1;i<=60;i++){clock.observe(snapshot({sampled:i}),i*30_000);assert.equal(clock.check(i*30_000,true,false),null);}
  assert.equal(clock.check(10_000_000,true,true),null);
});
test('ready resets the processing clock; cleanup has an absolute deadline despite progress',()=>{
  const clock=new ScanProgressClock(0);clock.ready(170_000);
  assert.equal(clock.check(170_001,true,false),null);
  clock.observe(snapshot({workPhase:'cleanup'}),170_002);
  clock.observe(snapshot({workPhase:'cleanup',sampled:99}),184_000);
  assert.equal(clock.check(185_002,true,false),'cleanup');
  assert.equal(new ScanProgressClock(0).check(180_000,false,false),'initialization');
});
test('watchdog returns from a hung decoder, preserves results, and fences late success', {timeout:2000},async()=>{
  const states:ScannerState[]=[];let publish!:(state:ScannerState)=>void,cancelled=0;
  const card={id:'test',name:'카드',review:[],awakening:2,extraCopies:null} as ScannerState['cards'][number];
  await assert.rejects(guardScan({signal:new AbortController().signal,update:s=>states.push(s),sharing:()=>false,
    cancelResources:()=>{cancelled++;},intervalMs:2,limits:{...scanLimits,stall:20},
    run:async(_signal,next,ready)=>{publish=next;ready();next(snapshot({cards:[card]}));await never();},
  }),ScanStalledError);
  assert.equal(cancelled,1);assert.equal(states.at(-1)?.interrupted,'stalled');
  assert.equal(states.at(-1)?.cards[0].id,'test');
  assert.equal(states.at(-1)?.cards[0].extraCopies,null);
  const count=states.length;publish(snapshot({status:'완료',autoStopped:true}));await delay(5);assert.equal(states.length,count);
});
test('manual cancellation returns even if resource cleanup never settles', {timeout:2000},async()=>{
  const abort=new AbortController();let final:ScannerState|undefined,inner:AbortSignal|undefined;
  const job=guardScan({signal:abort.signal,update:s=>{final=s},sharing:()=>false,cancelResources:()=>{},
    run:async(signal,publish,ready)=>{inner=signal;ready();publish(snapshot());await never();}});
  await delay(0);abort.abort();await assert.rejects(job,{name:'AbortError'});
  assert.equal(inner?.aborted,true);assert.equal(final?.interrupted,'cancelled');assert.equal(final?.status,'스캔 중지');
});
test('cleanup deadline is enforced and an already cancelled scan never starts', {timeout:2000},async()=>{
  await assert.rejects(guardScan({signal:new AbortController().signal,update:()=>{},sharing:()=>false,cancelResources:()=>{},
    intervalMs:2,limits:{...scanLimits,cleanup:20},run:async(_s,p,r)=>{r();p(snapshot({workPhase:'cleanup'}));await never();}}),/정리가 지연/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(guardScan({signal:abort.signal,update:()=>{},sharing:()=>false,cancelResources:()=>{},run:async()=>assert.fail('started')}),{name:'AbortError'});
});
test('normal success does not cancel resources or mark results incomplete',async()=>{
  let cancelled=false,last:ScannerState|undefined;
  await guardScan({signal:new AbortController().signal,update:s=>{last=s},sharing:()=>false,cancelResources:()=>{cancelled=true;},
    run:async(_s,p,r)=>{r();p(snapshot({status:'완료'}));}});
  assert.equal(cancelled,false);assert.equal(last?.status,'완료');assert.equal(last?.interrupted,undefined);
});
