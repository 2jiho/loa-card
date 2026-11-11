import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MetadataOrder} from '../src/features/card-scanner/session/metadata-order';
import type {CardSort} from '../src/features/card-scanner/recognition/capture-metadata';
import {ScanGrid} from '../src/features/card-scanner/session/scan-grid';
import {InventoryPosition,StationaryInventoryView} from '../src/features/card-scanner/session/inventory-position';
import {ObservedInventoryLayout} from '../src/features/card-scanner/session/observed-inventory-layout';
import {ScrollCoverage} from '../src/features/card-scanner/session/scroll-coverage';
import {resetPositionsForSort} from '../src/features/card-scanner/session/sort-position-reset';

const groups=Array.from({length:40},(_,index)=>index);
const geometry={position:0,pageSpan:4/51.6};
const asc:CardSort={kind:'name',direction:'asc'};
const unknown:CardSort={kind:'name',direction:'unknown'};

function populated(){
 const grid=new ScanGrid(),inventory=new InventoryPosition(),stationary=new StationaryInventoryView();
 const layout=new ObservedInventoryLayout(),coverage=new ScrollCoverage();
 grid.geometry(55);grid.begin(true);grid.group(0,7,1,true);grid.identify(7,'card-7');
 grid.record(1);grid.register(1,1);grid.finish(1,'read');
 assert.equal(grid.snapshot().inventory?.[0].status,'read');
 assert.equal(inventory.offer(groups,geometry,1,true),1);
 for(const group of groups)inventory.identify(group,`card-${group}`);
 assert.equal(stationary.observe(groups,geometry),false);
 assert.equal(stationary.observe(groups,geometry),true);
 layout.capture(groups);for(const group of groups.slice(0,6))layout.identify(group,`card-${group}`);
 assert.equal(layout.resolve(groups.slice(0,6).map(group=>`card-${group}`),[]).length,6);
 coverage.offer(0,4/51.6,Array(40).fill(true));
 assert.ok(coverage.snapshot().columns.some(column=>column.length));
 let transient={livePositions:[7],lastLayoutKey:'old',previousVectors:[1],previous:[1],gaps:[1]};
 const targets={grid,inventory,stationary,layout,coverage,clearTransient:()=>{
  transient={livePositions:[],lastLayoutKey:'',previousVectors:[],previous:[],gaps:[]};
 }};
 return {targets,transient:()=>transient};
}

function assertReset(value:ReturnType<typeof populated>){
 const {grid,inventory,stationary,layout,coverage}=value.targets;
 assert.equal(grid.snapshot().inventory?.length,0,'old grid placements removed');
 assert.equal(inventory.diagnostics().slots,0,'old inventory slots removed');
 assert.equal(inventory.diagnostics().identities,40,'recognized group identities retained');
 assert.equal(inventory.offer(groups,null,2),undefined,'old location cannot place a new view');
 assert.equal(stationary.observe(groups,geometry),false,'old stationary view cannot verify a new frame');
 assert.equal(layout.resolve(groups.slice(0,6).map(group=>`card-${group}`),[]).length,0,'old relative layout removed');
 assert.ok(coverage.snapshot().columns.every(column=>column.length===0),'old scroll coverage removed');
 assert.deepEqual(value.transient(),{livePositions:[],lastLayoutKey:'',previousVectors:[],previous:[],gaps:[]});
 // The reset does not make a new observation or drop already read work.
 // A fresh view may explicitly associate the same group with a new slot.
 grid.begin(true);grid.group(0,7,3,false);grid.record(3);grid.register(3,20);
 assert.equal(grid.snapshot().inventory?.[190].status,'read');
}

test('unknown direction resets every position channel but retains prior read work',()=>{
 const metadata=new MetadataOrder();metadata.accept(0,{growthPoints:null,sort:asc},1);
 const value=populated(),next=metadata.accept(0,{growthPoints:null,sort:unknown},2);
 assert.equal(resetPositionsForSort(asc,next,value.targets),true);
 assertReset(value);
});

test('newer failed sort resets position state; a late older result does not recreate it',()=>{
 const metadata=new MetadataOrder();metadata.accept(1,{growthPoints:null,sort:asc},1);
 const value=populated(),next=metadata.accept(2,{growthPoints:null,sort:null},2);
 assert.equal(next.sortInvalidated,true);
 assert.equal(resetPositionsForSort(asc,next,value.targets),true);
 assertReset(value);
 const late=metadata.accept(1,{growthPoints:null,sort:asc},1);
 assert.equal(late.sort,null);
 assert.equal(resetPositionsForSort(null,late,value.targets),false);
});

test('the first known sort resets earlier unknown placements; unchanged sort does not',()=>{
 const metadata=new MetadataOrder(),value=populated();
 const first=metadata.accept(1,{growthPoints:null,sort:asc},1);
 assert.equal(resetPositionsForSort(null,first,value.targets),true);
 assertReset(value);
 const unchanged=metadata.accept(2,{growthPoints:null,sort:asc},2);
 assert.equal(resetPositionsForSort(asc,unchanged,value.targets),false);
});

test('losing the growth view clears positions even when sort is already unknown and fences late metadata',()=>{
 const metadata=new MetadataOrder(),value=populated();
 const pending={growthPoints:{current:20,maximum:999999999},sort:asc};
 // A newer unlocated acquisition has no sort reading. Its input order fences
 // the unfinished earlier metadata without discarding valid growth fallback.
 const lost=metadata.invalidateUnlocatedSort(0,2);
 assert.equal(resetPositionsForSort(null,lost,value.targets,true),true);
 assertReset(value);
 const late=metadata.accept(0,pending,1);
 assert.equal(late.sort,null);
 assert.deepEqual(late.growthPoints,pending.growthPoints);
 assert.equal(resetPositionsForSort(null,late,value.targets),false);
});
