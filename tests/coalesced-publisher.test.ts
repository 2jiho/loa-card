import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoalescedPublisher} from '../src/features/card-scanner/coalesced-publisher';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';
import {createScanMonitorStore} from '../src/features/card-scanner/scan-monitor-store';

test('a final read reaches the monitor without another frame or OCR result',t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0;
 const grid=new ScanGrid(),store=createScanMonitorStore();
 grid.begin(true);grid.group(0,1,1,true,1);grid.record(1);
 const publisher=createCoalescedPublisher(()=>store.publish({grid:grid.snapshot()}),100,()=>now);
 publisher.request();assert.equal(store.getSnapshot()!.grid!.recent!.waiting,1);
 now=7;t.mock.timers.tick(7);grid.finish(1,'read');publisher.request();
 now=100;t.mock.timers.tick(93);
 assert.equal(store.getSnapshot()!.grid!.inventory![0].status,'read');
 assert.equal(store.getSnapshot()!.grid!.recent!.read,1);
 publisher.dispose();
});

test('bursts publish the latest state once per interval and force flush cancels a pending duplicate',t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0,value=0;const seen:number[]=[];
 const publisher=createCoalescedPublisher(()=>seen.push(value),100,()=>now);
 publisher.request();
 for(let i=1;i<=99;i++){now=i;t.mock.timers.tick(1);value=i;publisher.request();}
 now=100;t.mock.timers.tick(1);assert.deepEqual(seen,[0,99]);
 value=100;publisher.request();value=101;publisher.request(true);
 now=300;t.mock.timers.tick(200);assert.deepEqual(seen,[0,99,101]);publisher.dispose();
});

test('disposed publication cannot leak a late update into the next scan',t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0,calls=0;
 const publisher=createCoalescedPublisher(()=>calls++,100,()=>now);
 publisher.request();publisher.request();publisher.dispose();
 now=100;t.mock.timers.tick(100);publisher.request(true);assert.equal(calls,1);
});
