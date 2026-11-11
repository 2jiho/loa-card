import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrameAdmissionScope} from '../src/features/card-scanner/orchestration/scanner';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';
import {InventoryPosition,StationaryInventoryView} from '../src/features/card-scanner/session/inventory-position';
import {ObservedInventoryLayout} from '../src/features/card-scanner/session/observed-inventory-layout';
import {ScrollCoverage} from '../src/features/card-scanner/session/scroll-coverage';
import {resetPositionsForSort} from '../src/features/card-scanner/session/sort-position-reset';

const geometry={position:0,pageSpan:4/51.6};
const groups=Array.from({length:40},(_,i)=>i);

test('a conflicting rebound during admission clears all projections atomically without erasing its ambiguity',()=>{
 const grid=new ScanGrid(),inventory=new InventoryPosition(),stationary=new StationaryInventoryView();
 const layout=new ObservedInventoryLayout(),coverage=new ScrollCoverage(),scope=new FrameAdmissionScope<{width:number}>();
 let transient={positions:[0],key:'old',clears:0};
 const targets={grid,inventory,stationary,layout,coverage,clearTransient:()=>{
  transient={positions:[],key:'',clears:transient.clears+1};
 }};
 grid.enableSourceWorkProjection();grid.geometry(55);grid.begin(true);
 for(let i=0;i<6;i++){grid.group(i,i,i+1,true);grid.identify(i,`A${i}`);}
 grid.record(1);grid.register(1,1);inventory.capture(1,groups,geometry,true);layout.capture(groups);
 for(let i=0;i<6;i++){inventory.identify(i,`A${i}`);layout.identify(i,`A${i}`);}
 assert.equal(inventory.verifiedPositions().length,6);
 assert.ok(grid.snapshot().inventory?.length);
 // A new source reuses the group, while the old admission still owns its
 // staged frame. Identity/position callbacks run only when that frame ends.
 grid.begin(true);
 for(let i=0;i<6;i++){grid.invalidateGroupIdentity(i,100+i);grid.group(i,i,100+i,true);}
 grid.record(2);scope.begin([]);
 for(let i=0;i<6;i++)scope.commit(()=>{
  if(!grid.isCurrentObservation(i,100+i))return;
  layout.identify(i,`B${i}`);grid.identify(i,`B${i}`);
  const before=inventory.revision,located=inventory.identify(i,`B${i}`);
  if(inventory.revision!==before)resetPositionsForSort(null,{growthPoints:null,sort:null},targets,true);
  else for(const location of located)grid.register(location.frame,location.top);
 });
 assert.equal(inventory.verifiedPositions().length,6,'the in-flight frame does not partially apply the new identities');
 assert.equal(transient.clears,0);
 scope.finish();
 assert.deepEqual(inventory.verifiedPositions(),[]);
 assert.equal(grid.snapshot().inventory?.length,0);
 assert.deepEqual(transient.positions,[]);assert.equal(transient.key,'');assert.ok(transient.clears>0);
 assert.deepEqual(layout.resolve(Array.from({length:6},(_,i)=>`B${i}`),[],false),[]);
 // Ordinary sort resets do not allow an ambiguous group to become an anchor.
 resetPositionsForSort(null,{growthPoints:null,sort:null},targets,true);
 assert.deepEqual(inventory.capture(3,groups,geometry,true),[]);
 inventory.identify(0,'B0');assert.deepEqual(inventory.verifiedPositions(),[]);
});

test('a delayed position callback cannot attach a superseded group to the current frame',()=>{
 const grid=new ScanGrid(),scope=new FrameAdmissionScope<{width:number}>();grid.enableSourceWorkProjection();
 grid.begin(true);grid.group(0,1,1,true);grid.record(1);
 let applied=false;scope.begin([]);
 scope.commit(()=>{if(!grid.isCurrentObservation(1,1))return;grid.identify(1,'old');applied=true;});
 grid.invalidateGroupIdentity(1,2);grid.group(0,1,2,true);grid.record(2);
 scope.finish();assert.equal(applied,false);
 assert.equal(grid.snapshot().recentFrame?.cells[0].status,'waiting');
});
