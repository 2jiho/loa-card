import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planRejectedRasterTransport} from '../src/features/card-scanner/acquisition/rejected-raster-plan';

function cell(slot:number,usable:boolean,reason:string){
 return {slot,quality:{usable,reason},raster:{width:140,height:210},metadata:{content:{x:slot*140,y:0},feature:new Uint8Array([slot])}};
}
test('one frame preserves every usable image and first image of each rejected reason',()=>{
 const input=[cell(0,false,'blank'),cell(1,false,'blank'),cell(2,false,'tooltip'),cell(3,true,'candidate'),cell(4,false,'tooltip')];
 const output=planRejectedRasterTransport(input,{preserveAll:false});
 assert.deepEqual(output.map(value=>value.kind),['transfer','omitted-rejected','transfer','transfer','omitted-rejected']);
 for(const [index,value] of output.entries()){
  assert.equal(value.slot,input[index].slot);assert.equal(value.quality,input[index].quality);assert.equal(value.metadata,input[index].metadata);
  if(value.kind==='transfer')assert.equal(value.raster,input[index].raster);
  else {assert.equal(value.width,140);assert.equal(value.height,210);assert.equal('raster' in value,false);}
 }
 // The plan has no session cache: a new frame retains its own first example.
 assert.equal(planRejectedRasterTransport([cell(0,false,'blank')],{preserveAll:false})[0].kind,'transfer');
});
test('recording, inspection or uncertain consumer contracts can retain all input rasters',()=>{
 const input=[cell(0,false,'blank'),cell(1,false,'blank'),cell(2,true,'candidate')];
 const output=planRejectedRasterTransport(input,{preserveAll:true});
 assert.ok(output.every(value=>value.kind==='transfer'));
 assert.deepEqual(output.map(value=>value.kind==='transfer'&&value.raster),input.map(value=>value.raster));
});
test('invalid or shared ownership is rejected before any release or transport',()=>{
 const first=cell(0,false,'blank'),second=cell(1,false,'blank');
 assert.throws(()=>planRejectedRasterTransport([first,{...second,raster:first.raster}],{preserveAll:false}),/ownership/);
 assert.throws(()=>planRejectedRasterTransport([first,{...second,slot:0}],{preserveAll:false}),/ownership/);
 assert.throws(()=>planRejectedRasterTransport([first,{...second,quality:{usable:false,reason:''}}],{preserveAll:false}),/ownership/);
 assert.throws(()=>planRejectedRasterTransport([first],{} as {preserveAll:boolean}),/plan/);
 assert.equal(first.raster.width,140);assert.equal(second.raster.width,140,'planning never consumes the original');
});
