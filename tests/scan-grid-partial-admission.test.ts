import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';
import {InventoryPosition} from '../src/features/card-scanner/session/inventory-position';
import {FrameAdmissionScope} from '../src/features/card-scanner/orchestration/scanner';
import {CandidateQueue} from '../src/features/card-scanner/acquisition/candidate-queue';
import {yieldForCapture} from '../src/features/card-scanner/capture/input-source';
import {applyScanGridCommand,recordScanGrid,scanGridReplaySnapshot} from '../src/features/card-scanner/session/scan-grid-command';
import type {ScanGridCommand} from '../src/features/card-scanner/session/scan-grid-command';

test('repeated intermediate records preserve exact work and replay without fabricating other slots',()=>{
 const commands:ScanGridCommand[]=[],grid=recordScanGrid(new ScanGrid(),command=>commands.push(command));
 grid.enableSourceWorkProjection();grid.begin(true);
 grid.group(0,1,1,true);grid.cell(1,'empty');grid.record(10);
 const first=grid.snapshot();assert.equal(first.recentFrame?.cells[0].status,'waiting');
 assert.equal(first.recentFrame?.cells[1].status,'empty');assert.equal(first.recentFrame?.cells[2].status,'unknown');
 const lease=grid.start(1);grid.group(2,2,2,true);grid.record(10);
 const second=grid.snapshot();assert.equal(second.recentFrame?.cells[0].status,'reading');
 assert.equal(second.recentFrame?.cells[2].status,'waiting');assert.equal(second.recentFrame?.cells[3].status,'unknown');
 assert.equal(first.recentFrame?.cells[0].status,'waiting','previous snapshot is immutable');
 grid.finish(1,'read',lease);grid.record(10);
 const replay=new ScanGrid();for(const command of commands)applyScanGridCommand(replay,JSON.parse(JSON.stringify(command)));
 assert.deepEqual(scanGridReplaySnapshot(replay),scanGridReplaySnapshot(grid));
 assert.equal(replay.snapshot().inventory?.length,0,'recording partial work cannot invent absolute locations');
});

test('late previous-frame identity placement never paints the partially admitted current frame',()=>{
 const grid=new ScanGrid(),positions=new InventoryPosition();grid.enableSourceWorkProjection();
 const anchor=Array.from({length:40},(_,i)=>i<10?i+1:undefined);
 grid.begin(true);for(let i=0;i<10;i++)grid.group(i,i+1,i+1,true);grid.record(1);
 for(const x of positions.capture(1,anchor,{position:0,pageSpan:4/51},true))grid.register(x.frame,x.top);
 for(let i=0;i<10;i++){grid.identify(i+1,`card-${i}`);positions.identify(i+1,`card-${i}`);}
 const old=Array.from({length:40},(_,i)=>i<10?i+11:undefined);
 grid.begin(true);for(let i=0;i<10;i++)grid.group(i,i+11,i+11,true);grid.record(2);
 assert.deepEqual(positions.capture(2,old,null),[]);
 grid.begin(true);grid.group(0,31,31,true);grid.record(3);
 for(let i=0;i<6;i++)for(const x of positions.identify(i+11,`card-${i}`))grid.register(x.frame,x.top);
 const partial=grid.snapshot();assert.equal(partial.recentFrame?.frame,3);
 assert.equal(partial.recentFrame?.cells[0].status,'waiting');
 assert.equal(partial.recentFrame?.cells[1].status,'unknown');
 assert.equal(partial.cells[1].status,'unknown','late registration must not overwrite current staging slots');
 grid.group(1,32,32,true);grid.record(3);
 assert.equal(grid.snapshot().recentFrame?.cells[1].status,'waiting');
});

test('abort at every partial admission boundary releases only untransferred queue resources',async()=>{
 for(let admitted=0;admitted<=40;admitted++){
  const crops=Array.from({length:40},()=>({width:140})),previews=Array.from({length:40},()=>({width:80}));
  const scope=new FrameAdmissionScope<{width:number}>(),queue=new CandidateQueue<{group:number;image:{width:number};preview:{width:number}}>(40,
   item=>{item.image.width=0;item.preview.width=0;});
  scope.begin([...crops,...previews]);let committed=false;scope.commit(()=>{committed=true;});
  for(let i=0;i<admitted;i++){
   assert.equal(queue.pushDetailed({group:i,image:crops[i],preview:previews[i]}),'queued');
   scope.transfer(crops[i],previews[i]);
  }
  assert.equal(committed,false,'a pending sort cannot apply while the frame is admitted');
  const abort=new AbortController();const suspended=yieldForCapture(abort.signal);abort.abort();
  try{await assert.rejects(suspended,{name:'AbortError'});}finally{scope.finish();}
  assert.equal(committed,true,'the deferred sort/position commit is applied after staging ends');
  for(let i=0;i<40;i++){
   assert.equal(crops[i].width,i<admitted?140:0,`crop ${i} after ${admitted}`);
   assert.equal(previews[i].width,i<admitted?80:0,`preview ${i} after ${admitted}`);
  }
  queue.clear();assert.ok(crops.every(value=>value.width===0));assert.ok(previews.every(value=>value.width===0));
  scope.finish();
 }
});

test('queue replacement retains new owner and commits new sort with position reset together',()=>{
 const grid=new ScanGrid(),scope=new FrameAdmissionScope<{width:number}>();grid.enableSourceWorkProjection();
 grid.begin(true);grid.group(0,1,1,true,1);grid.record(1);grid.register(1,1);
 const old={width:140},oldPreview={width:80},next={width:140},nextPreview={width:80};
 const queue=new CandidateQueue<{group:number;image:{width:number};preview:{width:number}}>(2,
  item=>{item.image.width=0;item.preview.width=0;});
 let sort='name';scope.begin([old,oldPreview,next,nextPreview]);
 assert.equal(queue.pushDetailed({group:1,image:old,preview:oldPreview}),'queued');scope.transfer(old,oldPreview);
 scope.commit(()=>{grid.resetPositions();sort='grade';});
 assert.equal(queue.pushDetailed({group:1,image:next,preview:nextPreview}),'replaced');scope.transfer(next,nextPreview);
 assert.equal(old.width,0);assert.equal(sort,'name');assert.ok(grid.snapshot().inventory?.length);
 scope.finish();assert.equal(sort,'grade');assert.equal(grid.snapshot().inventory?.length,0);
 assert.equal(next.width,140,'queued replacement remains usable');queue.clear();assert.equal(next.width,0);
});
