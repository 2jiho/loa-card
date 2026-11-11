import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperimentalAcquisitionReceiptBridge} from '../src/features/card-scanner/acquisition/experimental-acquisition-receipts';
import type {Layout} from '../src/features/card-scanner/acquisition/detector';

const box=(y=10)=>({x:10,y,width:100,height:140});
const layout=(y=10)=>({area:{x:0,y:0,width:400,height:400},cells:[box(y)],scale:1} as Layout);
const geometry=(y=10)=>({box:box(y),bounds:{left:4,top:y-6,width:112,height:152},content:{x:12,y:y+2,width:96,height:136},
 area:{x:0,y:0,width:400,height:400},scale:1,frameWidth:400,frameHeight:400});
const edge=(frame=1,to=2,dy=0)=>({from:{generation:'worker-1',frameId:frame,slot:0},to:{generation:'worker-1',frameId:to,slot:0},dy,
 fromGeometry:geometry(),toGeometry:geometry(10+dy)});

test('diagnostic receipt requires both actual response frame IDs, slots, geometry and worker generation',()=>{
 const bridge=createExperimentalAcquisitionReceiptBridge();
 assert.deepEqual(bridge.accept(1,layout(),400,400,[0],[]),{edges:[],unavailable:0,unsupported:false});
 const original=edge(),accepted=bridge.accept(2,layout(),400,400,[0],[original]).edges;
 assert.deepEqual(accepted,[original]);assert.notEqual(accepted[0],original);
 original.from.frameId=99;assert.equal(accepted[0].from.frameId,1);
 assert.deepEqual(bridge.accept(3,layout(20),400,400,[0],[edge(1,3,10)]).edges,[edge(1,3,10)]);
 bridge.close();assert.throws(()=>bridge.accept(4,layout(),400,400,[0],[]),/order/);
});

test('receipt fails closed for missing prior, stale endpoint, wrong generation and changed geometry',()=>{
 for(const mutate of [
  (r:ReturnType<typeof edge>)=>{r.from.frameId=99;},
  (r:ReturnType<typeof edge>)=>{r.to.frameId=3;},
  (r:ReturnType<typeof edge>)=>{r.to.generation='other-worker';},
  (r:ReturnType<typeof edge>)=>{r.toGeometry.content.width--;},
  (r:ReturnType<typeof edge>)=>{r.toGeometry.box.x++;},
  (r:ReturnType<typeof edge>)=>{r.to.slot=1;},
 ]){
  const bridge=createExperimentalAcquisitionReceiptBridge();bridge.accept(1,layout(),400,400,[0],[]);
  const r=edge();mutate(r);assert.throws(()=>bridge.accept(2,layout(),400,400,[0],[r]),/receipt/);
  assert.throws(()=>bridge.accept(3,layout(),400,400,[0],[edge(1,3)]),/receipt/,'invalid message clears old source bindings');
 }
});

test('receipt cannot claim an unreturned slot or reuse a prior generation, even with matching pixels',()=>{
 const a=createExperimentalAcquisitionReceiptBridge();a.accept(1,layout(),400,400,[],[]);
 assert.throws(()=>a.accept(2,layout(),400,400,[0],[edge()]),/receipt/);
 const b=createExperimentalAcquisitionReceiptBridge();b.accept(1,layout(),400,400,[0],[]);b.accept(2,layout(),400,400,[0],[edge()]);
 const wrong=edge(1,3);wrong.from.generation=wrong.to.generation='worker-2';
 assert.throws(()=>b.accept(3,layout(),400,400,[0],[wrong]),/receipt/);
});

test('evicted origin is reported as unavailable without interrupting repeated acquisition',()=>{
 const bridge=createExperimentalAcquisitionReceiptBridge();
 bridge.accept(1,layout(),400,400,[0],[]);
 for(let id=2;id<=201;id++){
  const result=bridge.accept(id,layout(),400,400,[0],[edge(1,id)]);
  assert.equal(result.edges.length,id<=161?1:0);
  assert.equal(result.unavailable,id<=161?0:1);
 }
 const next=createExperimentalAcquisitionReceiptBridge();next.accept(1,layout(),400,400,[0],[]);
 assert.throws(()=>next.accept(2,layout(),400,400,[0],[edge(),edge()]),/receipt/);
});

test('normal fractional detector layout continues capture with explicit unsupported evidence',()=>{
 const bridge=createExperimentalAcquisitionReceiptBridge(),fractional=layout();fractional.cells[0].x+=0.5;
 assert.deepEqual(bridge.accept(1,fractional,400,400,[0],[]),{edges:[],unavailable:0,unsupported:true});
 assert.throws(()=>bridge.accept(2,fractional,400,400,[0],[edge()]),/receipt/);
});
