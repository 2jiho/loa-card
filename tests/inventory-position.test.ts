import test from 'node:test';
import assert from 'node:assert/strict';
import {InventoryPosition} from '../src/features/card-scanner/inventory-position';
const groups=(top:number):(number|undefined)[]=>Array.from({length:40},(_,i)=>i+top*10);
const geometry=(step:number)=>({position:step/51,pageSpan:4/51.6});
test('registered observation overlaps override a thumb rounding to the wrong row in both directions',()=>{
 const p=new InventoryPosition();assert.equal(p.offer(groups(0),geometry(0)),1);
 assert.equal(p.offer(groups(1),geometry(1.65)),2);
 assert.equal(p.offer(groups(4),geometry(4.7)),5);
 assert.equal(p.offer(groups(2),geometry(2.6)),3);
});
test('a complete forward and reverse pass retains exact relative rows with thumb jitter',()=>{
 const p=new InventoryPosition();p.offer(groups(0),geometry(0));
 for(let i=1;i<=51;i++)assert.equal(p.offer(groups(i),geometry(Math.min(51,i+.63))),i+1);
 for(let i=50;i>=0;i--)assert.equal(p.offer(groups(i),geometry(Math.max(0,i-.61))),i+1);
});
test('unseen middle and non-overlapping jumps do not invent positions',()=>{
 const p=new InventoryPosition();assert.equal(p.offer(groups(20),geometry(20)),undefined);
 p.offer(groups(0),geometry(0));assert.equal(p.offer(groups(8),geometry(8)),undefined);
 assert.equal(p.offer(groups(1),{position:1/35,pageSpan:4/35}),undefined,'a clearly different scroll range may be a filtered inventory');
 assert.equal(p.offer(groups(1),geometry(1)),2);
 p.reset();assert.equal(p.offer(groups(1),geometry(1)),undefined);
});

test('covered scrollbar retains pending observations and reconnects through six known columns',()=>{
 const p=new InventoryPosition();p.offer(groups(0),geometry(0));
 assert.equal(p.offer(groups(2),null),3);
 assert.equal(p.offer(groups(2),{position:2/51,pageSpan:63/839}),3,'one-pixel height uncertainty does not discard known overlap');
 assert.equal(p.offer(groups(9),null),undefined,'no overlap cannot guess a position');
 const late=groups(3).map(g=>g!+1000);p.capture(500,late,null);
 for(let i=0;i<60;i++)p.identify(i,'card-'+i);
 let resolved:{frame:number;top:number}[]=[];
 for(let i=0;i<40;i++)resolved.push(...p.identify(late[i]!,'card-'+(30+i)));
 assert.ok(resolved.some(r=>r.frame===500&&r.top===4));
 p.resetPositions();assert.equal(p.offer(groups(3),null),undefined);
});
test('occlusion and a conflicting alignment require agreement across six columns',()=>{
 const p=new InventoryPosition();p.offer(groups(0),geometry(0));
 const bad=groups(3);for(let i=0;i<5;i++)bad[i]=undefined;
 assert.equal(p.offer(bad,geometry(3)),undefined);
 bad[4]=34;assert.equal(p.offer(bad,geometry(3)),4);
 const shifted=groups(2).map((_,i)=>groups(2)[Math.floor(i/10)*10+(i+1)%10]);
 assert.equal(p.offer(shifted,geometry(2)),undefined);
 const conflict=groups(2);for(let i=0;i<3;i++)conflict[i]=i+10;
 assert.equal(p.offer(conflict,geometry(2)),undefined);
});
test('late verified card identities register a past screen without guessing from its count',()=>{
 const p=new InventoryPosition();p.capture(1,groups(0),geometry(0));
 for(let i=0;i<40;i++)p.identify(i,'card-'+i);
 const next=groups(2).map(id=>id!+1000);
 assert.deepEqual(p.capture(2,next,geometry(2.7)),[]);
 const registered=[];
 for(let i=0;i<20;i++)registered.push(...p.identify(next[i]!,'card-'+(20+i)));
 assert.deepEqual(registered,[{frame:2,top:3}]);
});

test('independent overlapping anchors calibrate non-overlapping jumps, not half steps',()=>{
 const p=new InventoryPosition();p.offer(groups(0),geometry(0));p.offer(groups(1),geometry(1.04));
 assert.equal(p.offer(groups(8),geometry(8.03)),9);
 assert.equal(p.offer(groups(15),geometry(15.5)),undefined);
 // Predicted rows cannot train a drifting calibration.
 assert.equal(p.offer(groups(22),geometry(22.3)),undefined);
});

test('inconsistent anchor offsets disable thumb-only registration',()=>{
 const p=new InventoryPosition();p.offer(groups(0),geometry(0));p.offer(groups(1),geometry(1.6));
 assert.equal(p.offer(groups(8),geometry(8)),undefined);
});

test('complete sorted identities reconnect disjoint views only with independent order witnesses',()=>{
 const p=new InventoryPosition();
 p.capture(1,groups(0),geometry(0));
 for(let i=0;i<40;i++)p.identify(i,'card-'+i);
 const later=groups(8);
 p.capture(2,later,geometry(8.6));
 for(const id of later)p.identify(id!,'card-'+id);
 const order=Array.from({length:120},(_,i)=>'card-'+i);
 assert.deepEqual(p.order([...order].reverse()),[]);
 assert.deepEqual(p.order(order),[{frame:2,top:9}]);
 assert.deepEqual(p.verifiedOrder(),order);
 p.reset();
 assert.deepEqual(p.verifiedOrder(),[]);
 assert.deepEqual(p.order(order),[]);
 assert.equal(p.offer(groups(8),geometry(8.6)),undefined);
});

test('sort reset reuses known identities but requires fresh position witnesses',()=>{
 const p=new InventoryPosition();p.capture(1,groups(0),geometry(0));
 for(let i=0;i<120;i++)p.identify(i,'card-'+i);
 p.capture(2,groups(8),geometry(8.6));
 p.resetPositions();
 assert.deepEqual(p.verifiedOrder(),[]);
 // New ordering: cards 80-119 are now at the top; the old pending frame is gone.
 assert.deepEqual(p.capture(3,groups(8),geometry(0)),[{frame:3,top:1}]);
 const order=Array.from({length:120},(_,i)=>'card-'+((i+80)%120));
 assert.deepEqual(p.order(order),[]);
 assert.deepEqual(p.verifiedOrder(),order);
 // A new scan, unlike a sort change, forgets both identities and positions.
 p.reset();p.capture(4,groups(8),geometry(0));p.order(order);
 assert.deepEqual(p.verifiedOrder(),[]);
});

test('endpoint thumb cannot override even partial contradictory card positions',()=>{
 for(const [anchor,conflict] of [[0,1],[51,50]]) {
  const p=new InventoryPosition();p.capture(1,groups(anchor),geometry(anchor));
  const partial=groups(conflict).map((g,i)=>i>=10&&i<15?g:undefined);
  assert.deepEqual(p.capture(2,partial,geometry(anchor)),[]);
  assert.deepEqual(p.capture(3,groups(conflict),geometry(conflict)),[{frame:3,top:conflict+1}]);
  assert.deepEqual(p.capture(4,groups(anchor),geometry(anchor)),[{frame:4,top:anchor+1}]);
 }
});

test('endpoint rejects shifted columns and distant known positions',()=>{
 const p=new InventoryPosition();p.capture(1,groups(0),geometry(0));
 const shifted=groups(0).map((_,i)=>i===0?1:undefined);
 assert.deepEqual(p.capture(2,shifted,geometry(0)),[]);
 assert.deepEqual(p.capture(3,groups(0),geometry(51)),[]);
 assert.deepEqual(p.capture(4,groups(1),geometry(1)),[{frame:4,top:2}]);
});

test('scrollbar viewport hint is immediate but cannot establish any card positions',()=>{
 const p=new InventoryPosition();
 assert.equal(p.estimateTop(geometry(20)),21);
 assert.equal(p.estimateTop(geometry(51)),52);
 assert.deepEqual(p.capture(1,groups(20),geometry(20)),[]);
 assert.equal(p.diagnostics().slots,0);
 assert.equal(p.estimateTop(null),undefined);
 assert.equal(p.estimateTop(geometry(NaN)),undefined);
 assert.equal(p.estimateTop({position:.5,pageSpan:4/35}),undefined);
 p.reset();p.capture(2,groups(0),geometry(.1));p.capture(3,groups(1),geometry(1.1));
 assert.equal(p.estimateTop(geometry(8.55)),9);
});
