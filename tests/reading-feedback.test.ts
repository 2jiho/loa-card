import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadingFeedback,createFeedbackPublisher} from '../src/features/card-scanner/reading-feedback';
import {createCoalescedPublisher} from '../src/features/card-scanner/coalesced-publisher';
import {createScanMonitorStore} from '../src/features/card-scanner/scan-monitor-store';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

const card:ScannedCard={id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,
  confidence:1,review:[],image:'',time:1,observations:1,captureOrder:20};

test('feedback publishes a quiet last read ahead of the inventory lane and refreshes placement status',t=>{
  t.mock.timers.enable({apis:['setTimeout']});let now=0,fullCount=0;
  const signal=new AbortController(),grid=new ScanGrid(),store=createScanMonitorStore(),projection=new ReadingFeedback();
  const source=new Map([['a',card]]),latest=new Map([['a',20]]),confirmed=new Map<string,number>();
  grid.begin(true);grid.group(0,1,1,true,1);grid.record(1);grid.identify(1,'a');
  const positions=[{id:'a',slot:0}];grid.placeLive(positions,new Map([['a','waiting']]));
  const feedback=createFeedbackPublisher(signal.signal,()=>{
    const {completed,statuses}=projection.snapshot(source,{latest,confirmed});
    grid.placeLive(positions,statuses);
    store.publish({grid:grid.snapshot(),currentRunRead:completed,expected:1,capacity:450});
  },()=>now);
  const full=createCoalescedPublisher(()=>fullCount++,100,()=>now);
  full.request();feedback.request();
  now=7;t.mock.timers.tick(7);confirmed.set('a',20);grid.finish(1,'read');full.request();feedback.request();
  now=33;t.mock.timers.tick(26);
  assert.equal(store.getSnapshot()!.currentRunRead,1);
  assert.equal(store.getSnapshot()!.grid!.inventory![0].status,'read','old overlay must not hide new read');
  assert.equal(store.getSnapshot()!.grid!.recent!.read,1);
  assert.equal(fullCount,1,'full inventory publication still waits until 100ms');
  // New evidence invalidates old green even without a replacement consensus.
  latest.set('a',21);feedback.request();now=66;t.mock.timers.tick(33);
  assert.equal(store.getSnapshot()!.currentRunRead,0);
  assert.equal(store.getSnapshot()!.grid!.inventory![0].status,'review');
  feedback.dispose();full.dispose();
});

test('feedback reuses validated names only for the same consensus and always rechecks field evidence',()=>{
  const original={...card,review:['이름 확인']},source=new Map([['a',original]]),projection=new ReadingFeedback();
  const latest=new Map([['a',20]]),confirmed=new Map([['a',20]]);
  assert.equal(projection.snapshot(source,{latest,confirmed}).completed,0);
  projection.remember(source,[{...original,nameConfirmedBy:'sort',review:[]}]);
  assert.equal(projection.snapshot(source,{latest,confirmed}).completed,1);
  latest.set('a',21);
  assert.equal(projection.snapshot(source,{latest,confirmed}).completed,0);
  source.set('a',{...original});confirmed.set('a',21);
  assert.equal(projection.snapshot(source,{latest,confirmed}).completed,0,'new name evidence cannot borrow an old validation');
  assert.deepEqual(original.review,['이름 확인']);
});

test('feedback excludes restored seeds and invalid fields instead of inferring completion from totals',()=>{
  const projection=new ReadingFeedback(),source=new Map([['a',card]]);
  assert.equal(projection.snapshot(source,{latest:new Map(),confirmed:new Map()}).completed,0);
  const evidence={latest:new Map([['a',20]]),confirmed:new Map([['a',20]])};
  for(const changed of [{awakening:null},{extraCopies:null},{countReliable:false},{awakening:4,extraCopies:10}]) {
    source.set('a',{...card,...changed});assert.equal(projection.snapshot(source,evidence).completed,0);
  }
});

test('abort and disposal fence pending feedback without waiting for a source frame',t=>{
  t.mock.timers.enable({apis:['setTimeout']});let now=0,calls=0;
  const controller=new AbortController();
  const publisher=createFeedbackPublisher(controller.signal,()=>calls++,()=>now);
  publisher.request();publisher.request();controller.abort();now=100;t.mock.timers.tick(100);
  publisher.request(true);assert.equal(calls,1);publisher.dispose();
  const next=createFeedbackPublisher(new AbortController().signal,()=>calls++,()=>now);
  next.request();next.request();next.dispose();now=200;t.mock.timers.tick(100);next.request(true);
  assert.equal(calls,2);
});

test('waiting, reading and completed work publish on the feedback lane before inventory refresh',t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0,active=0,queued=1;
 const grid=new ScanGrid(),store=createScanMonitorStore();
 grid.begin(true);grid.group(0,1,1,true,1);grid.record(1);
 const publisher=createFeedbackPublisher(new AbortController().signal,()=>store.publish({
  grid:grid.snapshot(),queued,activeReadings:active,currentRunRead:0,expected:1,capacity:450,
 }),()=>now);
 publisher.request();assert.equal(store.getSnapshot()!.grid!.inventory![0].status,'waiting');
 queued=0;active=1;const attempt=grid.start(1);publisher.request();now=33;t.mock.timers.tick(33);
 assert.equal(store.getSnapshot()!.activeReadings,1);
 assert.equal(store.getSnapshot()!.grid!.inventory![0].status,'reading');
 active=0;grid.finish(1,'read',attempt);publisher.request();now=66;t.mock.timers.tick(33);
 assert.equal(store.getSnapshot()!.activeReadings,0);
 assert.equal(store.getSnapshot()!.grid!.inventory![0].status,'read');
 publisher.dispose();
});
