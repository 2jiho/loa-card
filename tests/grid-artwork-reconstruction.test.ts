import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixedGridSlots,reconstructGridArtwork} from '../src/features/card-scanner/session/grid-artwork-reconstruction';
import type {GridCardSlot} from '../src/features/card-scanner/session/grid-artwork-reconstruction';

test('fixed grid keeps the row-major 10x4 calibration and rejects invalid layouts',()=>{
  const slots=fixedGridSlots({originX:138,originY:392,columns:10,rows:4,pitchX:157.5,pitchY:243,width:140,height:210});
  assert.equal(slots.length,40);
  assert.deepEqual(slots[0],{slot:0,x:138,y:392,width:140,height:210});
  assert.deepEqual(slots[9],{slot:9,x:Math.round(138+9*157.5),y:392,width:140,height:210});
  assert.deepEqual(slots[10],{slot:10,x:138,y:635,width:140,height:210});
  assert.deepEqual(slots[39],{slot:39,x:Math.round(138+9*157.5),y:Math.round(392+3*243),width:140,height:210});
  for(const bad of [
    {originX:-1},{originY:NaN},{columns:0},{rows:-1},{pitchX:0},{pitchY:Infinity},{width:0},{height:1.5},
  ]) assert.throws(()=>fixedGridSlots({originX:138,originY:392,columns:10,rows:4,pitchX:157.5,pitchY:243,width:140,height:210,...bad}),RangeError);
});

test('reconstruction matches every fixed slot and never turns missing input into an identity',()=>{
  const slots:GridCardSlot[]=[0,1,2].map(slot=>({slot,x:slot*100,y:0,width:140,height:210}));
  const calls:number[]=[];
  const result=reconstructGridArtwork({slots,
    grayFor:slot=>slot.slot===1?new Float32Array(768):slot.slot===2?new Float32Array(10):new Float32Array(768),
    match:(gray,slot)=>{calls.push(slot.slot);
      return slot.slot===0?{id:'3200000',name:'아만',correlation:.98,margin:.4}:null;}});
  assert.deepEqual(calls,[0,1]);
  assert.equal(result.length,3);
  assert.deepEqual(result[0].identity,{id:'3200000',name:'아만',correlation:.98,margin:.4});
  assert.equal(result[0].grayAvailable,true);
  assert.equal(result[1].identity,null);
  assert.equal(result[1].grayAvailable,true,'rejected match still had gray input');
  assert.equal(result[2].identity,null);
  assert.equal(result[2].grayAvailable,false,'short gray is unavailable, not a match');
});
