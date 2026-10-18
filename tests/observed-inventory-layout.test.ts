import test from 'node:test';
import assert from 'node:assert/strict';
import {ObservedInventoryLayout} from '../src/features/card-scanner/observed-inventory-layout';
import {ScanGrid} from '../src/features/card-scanner/scan-grid';
const ids=(n:number)=>Array.from({length:n},(_,i)=>'card-'+i);

test('live map fills overlapping partial inventory before total coverage without shifting it to the top',()=>{
 const layout=new ObservedInventoryLayout();frame(layout,20,1,300);frame(layout,22,2,300);
 const partial=ids(60).map((_,i)=>'card-'+(200+i));
 assert.deepEqual(layout.resolve(partial,[],false),[],'a partial connected set has no inferred origin');
 const anchors=ids(6).map((_,i)=>({id:'card-'+(200+i),slot:200+i}));
 const positions=layout.resolve(partial,anchors,false).sort((a,b)=>a.slot-b.slot);
 assert.deepEqual(positions,partial.map((id,i)=>({id,slot:200+i})));
 const grid=new ScanGrid();grid.placeLive(positions,new Map(partial.map(id=>[id,'read' as const])));
 assert.equal(grid.snapshot().inventory?.filter(c=>c.status==='read').length,60);
 assert.equal(grid.snapshot().inventory?.[199].status,'unknown');
 assert.equal(grid.snapshot().inventory?.[259].status,'read');
});

test('live layout never packs a disconnected tail or infers a count-based origin',()=>{
 const layout=new ObservedInventoryLayout();frame(layout,0,1,80);frame(layout,4,2,80);
 const anchors=ids(6).map((id,slot)=>({id,slot}));
 assert.equal(layout.resolve(ids(80),anchors,false).length,40);
 assert.equal(layout.resolve(ids(80),anchors).length,80);
 assert.deepEqual(layout.resolve(ids(80),anchors.slice(0,5),false),[]);
});
function frame(layout:ObservedInventoryLayout,top:number,serial:number,total=83) {
 const groups=Array.from({length:40},(_,i)=>top*10+i<total?serial*100+i:undefined);
 layout.capture(groups);
 groups.forEach((g,i)=>{if(g!==undefined)layout.identify(g,'card-'+(top*10+i));});
 return groups;
}

test('late IDs join overlapping screens in arbitrary order without scrollbar or name sorting',()=>{
 const layout=new ObservedInventoryLayout(),expected=ids(83);
 frame(layout,5,1);frame(layout,0,2);frame(layout,2,3);
 const positions=layout.resolve(expected,[]).sort((a,b)=>a.slot-b.slot);
 assert.deepEqual(positions,expected.map((id,slot)=>({id,slot})));
 const grid=new ScanGrid();grid.confirm(expected);grid.restorePositions(positions);
 assert.equal(grid.snapshot().inventory?.filter(c=>c.status==='read').length,83);
 assert.equal(grid.snapshot().inventory?.[83],undefined);
});

test('disconnected observed screens need independent anchors, never just the total',()=>{
 const layout=new ObservedInventoryLayout();frame(layout,0,1,100);frame(layout,6,2,100);
 assert.deepEqual(layout.resolve(ids(100),[]),[]);
 const anchors=ids(6).map((_,i)=>({id:'card-'+(60+i),slot:60+i}));
 const positions=layout.resolve(ids(100),anchors);
 assert.equal(positions.length,40);assert.equal(Math.min(...positions.map(p=>p.slot)),60);
 assert.deepEqual(layout.resolve(ids(100),anchors.slice(0,5)),[]);
});

test('conflicting relative positions, columns or absolute anchors cannot restore a map',()=>{
 const layout=new ObservedInventoryLayout();frame(layout,0,1,40);
 assert.deepEqual(layout.resolve(ids(40),[{id:'card-0',slot:10}]),[]);
 const shifted=Array.from({length:40},(_,i)=>200+i);layout.capture(shifted);
 shifted.forEach((g,i)=>layout.identify(g,'card-'+((i+1)%40)));
 assert.deepEqual(layout.resolve(ids(40),[]),[]);
 const hole=new ObservedInventoryLayout();frame(hole,0,1,40);
 assert.deepEqual(hole.resolve(ids(41),[]),[]);
});

test('repeated screens do not evict rare receipts while names arrive late',()=>{
 const layout=new ObservedInventoryLayout();
 const first=Array.from({length:40},(_,i)=>i);layout.capture(first);
 const second=Array.from({length:40},(_,i)=>100+i);
 for(let i=0;i<2000;i++)layout.capture(second);
 first.forEach((g,i)=>layout.identify(g,'card-'+i));
 second.forEach((g,i)=>layout.identify(g,'card-'+(20+i)));
 assert.equal(layout.resolve(ids(60),[]).length,60);
 layout.resetPositions();assert.deepEqual(layout.resolve(ids(60),[]),[]);
 layout.capture(second);assert.equal(layout.resolve(ids(60),[]).length,0);
 layout.capture(first);assert.equal(layout.resolve(ids(60),[]).length,60);
});

test('partial low-quality rows and duplicate confirmed identities cannot manufacture coverage',()=>{
 const layout=new ObservedInventoryLayout();
 const sparse=Array.from({length:40},(_,i)=>i%10<5?i:undefined);layout.capture(sparse);
 sparse.forEach(g=>{if(g!==undefined)layout.identify(g,'card-'+g);});
 assert.deepEqual(layout.resolve(ids(40),[]),[]);
 frame(layout,0,2,40);
 assert.deepEqual(layout.resolve([...ids(40),'card-0'],[]),[]);
});

test('colliding anchored components are rejected as a whole',()=>{
 const layout=new ObservedInventoryLayout();frame(layout,0,1,100);frame(layout,6,2,100);
 const anchors=[...ids(6).map((id,slot)=>({id,slot})),...ids(6).map((_,i)=>({id:'card-'+(60+i),slot:30+i}))];
 assert.deepEqual(layout.resolve(ids(100),anchors),[]);
});

test('restoring actual identities moves old markers and rejects conflicting or unconfirmed receipts',()=>{
 const grid=new ScanGrid();grid.begin(true);grid.group(0,1,1,true,3);grid.identify(1,'a');grid.finish(1,'read');grid.confirm(['a','b']);
 grid.restorePositions([{id:'a',slot:0},{id:'b',slot:0}]);
 assert.equal(grid.snapshot().inventory?.[20].status,'read');
 grid.restorePositions([{id:'unknown',slot:0}]);assert.equal(grid.snapshot().inventory?.[0].status,'unknown');
 grid.restorePositions([{id:'a',slot:0},{id:'b',slot:1}]);
 assert.deepEqual(grid.snapshot().inventory?.map(c=>c.status),['read','read']);
});

test('a disconnected observed 23-card tail has a unique placement after 370 anchored cards',()=>{
 const layout=new ObservedInventoryLayout();
 for(let top=0;top<=33;top+=3)frame(layout,top,top+1,393);
 frame(layout,37,50,393);
 const anchors=ids(10).map((id,slot)=>({id,slot}));
 const positions=layout.resolve(ids(393),anchors).sort((a,b)=>a.slot-b.slot);
 assert.deepEqual(positions,ids(393).map((id,slot)=>({id,slot})));
 assert.equal(layout.resolve(ids(394),anchors).length,370,'an unobserved card prevents gap inference');
 assert.equal(layout.resolve(ids(393),[...anchors,{id:'card-370',slot:360}]).length,370,'partial contradictory anchors are preserved');
});

test('two interchangeable disconnected components remain unknown even with every ID read',()=>{
 const layout=new ObservedInventoryLayout();frame(layout,0,1,120);frame(layout,4,2,120);frame(layout,8,3,120);
 const positions=layout.resolve(ids(120),ids(10).map((id,slot)=>({id,slot})));
 assert.equal(positions.length,40);
});
