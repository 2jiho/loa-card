import test from 'node:test';
import assert from 'node:assert/strict';
import {createScanMonitorStore} from '../src/features/card-scanner/ui/scan-monitor-store';

const input=(read:number)=>({currentRunRead:read,expected:398,capacity:450,cards:[]}) as unknown as Parameters<ReturnType<typeof createScanMonitorStore>['publish']>[0];

test('a change after a quiet spell is told at once, quick changes at most once per interval with the latest', t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const store=createScanMonitorStore({notifyIntervalMs:50,now:()=>Date.now()});
  const seen:number[]=[];store.subscribe(()=>seen.push(store.getSnapshot()?.currentRunRead??-1));
  store.publish(input(1));
  assert.deepEqual(seen,[1],'the first change is told without waiting');
  store.publish(input(2));store.publish(input(3));
  assert.deepEqual(seen,[1],'changes right after are held');
  t.mock.timers.tick(50);
  assert.deepEqual(seen,[1,3],'then the latest one');
  t.mock.timers.tick(500);
  store.publish(input(4));
  assert.deepEqual(seen,[1,3,4],'after a quiet spell, at once again');
});
