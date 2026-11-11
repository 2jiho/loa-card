import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveObstructionHint,isLiveObstructionHintVisible,subscribeToLiveObstructionHintExpiry,LIVE_OBSTRUCTION_MESSAGE,type LiveObstructionHint} from '../src/features/card-scanner/session/live-obstruction-hint';
import {createScanMonitorStore} from '../src/features/card-scanner/ui/scan-monitor-store';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';
import {hasScanInputLoss,scanReadDetail} from '../src/features/card-scanner/ui/scan-read-detail';
import {createLiveCapturePipeline} from '../src/features/card-scanner/capture/live-capture-pipeline';

test('only fresh positive same-session frames publish; repeats are coalesced and expiry is display only',()=>{
  let now=1000;const hints:LiveObstructionHint[]=[];
  const guide=createLiveObstructionHint('session',()=>now,hint=>hints.push(hint));
  const frame=(inputId:number,at=now)=>({inputId,frameId:inputId,captureTime:inputId/10,capturedAtMs:at});
  guide.begin(1);assert.equal(guide.notice(frame(1),true),true);assert.equal(hints.length,1);
  assert.equal(guide.notice(frame(1),true),false,'multiple cells in one frame publish once');
  guide.begin(2);now+=100;assert.equal(guide.notice(frame(2),true),false,'rapid positive frames are throttled');
  guide.begin(3);now+=200;assert.equal(guide.notice(frame(3),true),true);assert.equal(hints.length,2);
  guide.begin(5);assert.equal(guide.notice(frame(4),true),false,'out of order acquisition is stale');
  assert.equal(guide.notice(frame(5,now-1001),true),false,'late result cannot create a current warning');
  guide.begin(6);assert.equal(guide.notice(frame(6),false),false,'sharing stopped or aborted');
  guide.begin(7);assert.equal(guide.notice(frame(7,now+1),true),false,'backwards clock is unknown');
  const last=hints[1];assert.equal(isLiveObstructionHintVisible(last,true,last.expiresAtMs-1),true);
  assert.equal(isLiveObstructionHintVisible(last,true,last.expiresAtMs),false);
  assert.equal(isLiveObstructionHintVisible(last,false,last.expiresAtMs-1),false);
  assert.equal(isLiveObstructionHintVisible(last,true,NaN),false);
});

test('display store preserves positive hint across grid feedback but not scan reset or older sessions',()=>{
  const store=createScanMonitorStore(),grid=new ScanGrid();let changed=0;store.subscribe(()=>changed++);
  store.publish({grid:grid.snapshot(),currentRunRead:0,expected:null,capacity:null,interrupted:undefined});
  const hint:LiveObstructionHint={sessionId:'one',inputId:2,frameId:2,captureTime:1,expiresAtMs:3000};
  store.publishLiveObstructionHint(hint);assert.equal(store.getSnapshot()?.liveObstructionHint,hint);
  const published=changed;store.publishLiveObstructionHint({...hint,inputId:1});
  store.publishLiveObstructionHint({...hint,sessionId:'other',inputId:3});assert.equal(changed,published);
  store.publish({grid:grid.snapshot(),currentRunRead:1,expected:null,capacity:null,interrupted:undefined});
  assert.equal(store.getSnapshot()?.liveObstructionHint,hint,'ordinary feedback must not erase the advisory');
  store.clear();store.publish({grid:grid.snapshot(),currentRunRead:0,expected:null,capacity:null,interrupted:undefined});
  assert.equal(store.getSnapshot()?.liveObstructionHint,undefined);
  store.publishLiveObstructionHint({...hint,sessionId:'other',inputId:1});
  assert.equal(store.getSnapshot()?.liveObstructionHint?.sessionId,'other');
});

test('display expiry uses capture time and cancels on replacement',()=>{
  let now=1000,notified=0,cancelled=false;let scheduled:(()=>void)|undefined,delay=-1;
  const hint:LiveObstructionHint={sessionId:'one',inputId:1,frameId:1,captureTime:0,expiresAtMs:1800};
  const schedule=(callback:()=>void,ms:number)=>{scheduled=callback;delay=ms;return ()=>{cancelled=true;};};
  const unsubscribe=subscribeToLiveObstructionHintExpiry(hint,true,()=>now,schedule,()=>notified++);
  assert.equal(delay,800);assert.equal(isLiveObstructionHintVisible(hint,true,now),true);
  unsubscribe();assert.equal(cancelled,true,'replacement or unmount cancels the old timer');
  now=1800;assert.equal(isLiveObstructionHintVisible(hint,true,now),false);
  scheduled=undefined;subscribeToLiveObstructionHintExpiry(hint,true,()=>now,schedule,()=>notified++);
  assert.equal(scheduled,undefined,'already expired snapshots do not schedule a timer');
  now=1000;subscribeToLiveObstructionHintExpiry(hint,false,()=>now,schedule,()=>notified++);
  assert.equal(scheduled,undefined,'inactive scan does not schedule a timer');
  subscribeToLiveObstructionHintExpiry(hint,true,()=>now,schedule,()=>notified++);
  now=1800;scheduled?.();assert.equal(notified,1);assert.equal(isLiveObstructionHintVisible(hint,true,now),false);
});

test('new frozen representative suppresses a delayed older acquisition result',async()=>{
  const hints:LiveObstructionHint[]=[];let releaseWorker!:()=>void,workerStarted!:()=>void;
  const worker=new Promise<void>(resolve=>{releaseWorker=resolve;});
  const started=new Promise<void>(resolve=>{workerStarted=resolve;});
  const guide=createLiveObstructionHint('session',()=>1000,hint=>hints.push(hint));
  const pipeline=createLiveCapturePipeline<number>({yieldTask:()=>Promise.resolve(),
    consume:async input=>{
      if(input===1){workerStarted();await worker;}
      guide.notice({inputId:input,frameId:input,captureTime:input,capturedAtMs:900},true);
    },release:()=>{},onError:assert.fail});
  const offerFrozen=(id:number)=>{guide.begin(id);pipeline.offer(id,id);};
  offerFrozen(1);await started;
  offerFrozen(2);releaseWorker();await pipeline.flush();
  assert.deepEqual(hints.map(hint=>hint.inputId),[2]);
});

test('occlusion guidance is advisory, limited to sharing, and yields to input-loss notice',()=>{
  const base={phase:'capture' as const,remaining:12,estimate:null,liveObstruction:true};
  assert.equal(scanReadDetail(base),LIVE_OBSTRUCTION_MESSAGE);
  assert.equal(scanReadDetail({...base,gate:'input-dropped'}),'');
  assert.equal(scanReadDetail({...base,droppedFrames:1}),'');
  assert.equal(hasScanInputLoss('input-dropped',0),true);
  assert.equal(hasScanInputLoss('inventory',1),true);
  assert.equal(hasScanInputLoss('inventory',0),false);
  assert.notEqual(scanReadDetail({...base,phase:'reading'}),LIVE_OBSTRUCTION_MESSAGE);
  assert.notEqual(scanReadDetail({...base,phase:'recovery',recoveryPercent:40}),LIVE_OBSTRUCTION_MESSAGE);
});
