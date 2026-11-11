import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {alignCardBorders} from '../src/features/card-scanner/acquisition/card-borders';
import {lowerPanelCandidate,panelCrossesCardEdge} from '../src/features/card-scanner/acquisition/overlay-quality';

type Sample={name:string;intact:boolean;width:number;height:number;rgba:string;box:{x:number;y:number;width:number;height:number}};
const samples:Sample[]=JSON.parse(readFileSync(new URL('./fixtures/border-integrity-samples.json',import.meta.url),'utf8'));
function sample(sample:Sample){
 const source=Uint8Array.from(Buffer.from(sample.rgba,'base64'));
 const aligned=alignCardBorders(source,sample.width,sample.height,sample.box),box=aligned.content;
 const crop=new Uint8Array(140*210*4);
 for(let y=0;y<210;y++)for(let x=0;x<140;x++){
  const at=((box.y+y)*sample.width+box.x+x)*4;crop.set(source.subarray(at,at+4),(y*140+x)*4);
 }
 return {source,aligned,box,crop};
}
test('the actual lower tooltip crop produces a diagnostic candidate and same-source edge support',()=>{
 const original=samples.find(item=>!item.intact)!,{source,aligned,box,crop}=sample(original);
 const evidence=lowerPanelCandidate(crop,140,210,aligned.borderSides).candidate;
 assert.ok(evidence);assert.ok(evidence.startY>=170&&evidence.endY<=200);
 assert.equal(aligned.intact,false);
 assert.equal(panelCrossesCardEdge(source,original.width,original.height,box,evidence,'left').status,'crosses');
 assert.equal(panelCrossesCardEdge(source,original.width,original.height,box,evidence,'right').status,'crosses');
 const removed=source.slice();for(let y=box.y+evidence.startY;y<box.y+evidence.endY;y++)
  for(let x=box.x-5;x<box.x;x++)removed.set([255,255,255,255],(y*original.width+x)*4);
 assert.equal(panelCrossesCardEdge(removed,original.width,original.height,box,evidence,'left').status,'none');
});

test('five actual intact card crops, blank and movement-like sides do not produce candidates',()=>{
 for(const original of samples.filter(item=>item.intact)){
  const {crop,aligned}=sample(original);assert.equal(lowerPanelCandidate(crop,140,210,aligned.borderSides).status,'unsupported',original.name);
 }
 const blank=new Uint8Array(140*210*4).fill(32);
 for(let i=3;i<blank.length;i+=4)blank[i]=255;
 assert.equal(lowerPanelCandidate(blank,140,210,[0,0,0,0]).status,'unsupported');
 assert.equal(lowerPanelCandidate(blank,140,210,[1,1,0,0]).status,'unsupported');
 assert.equal(lowerPanelCandidate(blank,140,210,[1,1,1,0]).status,'none','a uniform full background lacks a textured-to-flat boundary');
});

test('sample scope and work limits are explicit even with no candidate',()=>{
 const pixels=new Uint8Array(1025*105*4).fill(255);
 const oversized=lowerPanelCandidate(pixels,1025,105,[1,1,1,0]);
 assert.equal(oversized.status,'unsupported');assert.equal(oversized.reason,'crop-size');
 assert.equal(oversized.canConcludeAbsence,false);
 const blank=new Uint8Array(140*210*4).fill(32);for(let i=3;i<blank.length;i+=4)blank[i]=255;
 const none=lowerPanelCandidate(blank,140,210,[1,1,1,0]);
 assert.equal(none.status,'none');assert.equal(none.canConcludeAbsence,false);
 const frame=new Uint8Array(1200*220*4).fill(255);
 const edge=panelCrossesCardEdge(frame,1200,220,{x:10,y:5,width:1025,height:105},{startY:50,endY:70,color:[20,20,20]},'left');
 assert.equal(edge.status,'unsupported');assert.equal(edge.reason,'image-or-card-size');assert.equal(edge.canConcludeAbsence,false);
});

test('textured dark lower artwork is not sufficient, but a flat artwork-like region can be ambiguous',()=>{
 const original=samples.find(item=>item.intact)!,base=sample(original).crop;
 const dark=base.slice();for(let y=174;y<210;y++)for(let x=12;x<128;x++){
  const v=20+(x*7+y*11)%35;dark.set([v,v,v,255],(y*140+x)*4);
 }
 assert.equal(lowerPanelCandidate(dark,140,210,[.9,.9,1,0]).status,'none','dark noisy art is not a flat panel');
 const flat=base.slice();for(let y=174;y<210;y++)for(let x=12;x<128;x++)flat.set([37,39,45,255],(y*140+x)*4);
 assert.equal(lowerPanelCandidate(flat,140,210,[.9,.9,1,0]).status,'candidate','flat artwork can mimic the candidate; do not treat it as proof');
});

test('invalid sizes, missing edges and out-of-source support never produce a positive result',()=>{
 const original=samples.find(item=>!item.intact)!,{source,aligned,box,crop}=sample(original);
 const evidence=lowerPanelCandidate(crop,140,210,aligned.borderSides).candidate!;
 assert.equal(lowerPanelCandidate(crop,140,210,[1,1,1,1]).status,'unsupported');
 assert.equal(lowerPanelCandidate(crop,140,210,[1,1,1]).status,'invalid');
 assert.equal(lowerPanelCandidate(crop.subarray(0,10),140,210,[1,1,1,0]).status,'invalid');
 assert.equal(panelCrossesCardEdge(source,original.width,original.height,{...box,x:0},evidence,'left').status,'unsupported');
 assert.equal(panelCrossesCardEdge(source,original.width,original.height,{...box,y:-1},evidence,'right').status,'invalid');
 const transparentCrop=new Uint8Array(crop);for(let i=3;i<transparentCrop.length;i+=4)transparentCrop[i]=0;
 assert.equal(lowerPanelCandidate(transparentCrop,140,210,aligned.borderSides).status,'invalid');
 const transparentSource=new Uint8Array(source);for(let i=3;i<transparentSource.length;i+=4)transparentSource[i]=0;
 assert.equal(panelCrossesCardEdge(transparentSource,original.width,original.height,box,evidence,'right').status,'invalid');
 assert.equal(lowerPanelCandidate({length:crop.length} as ArrayLike<number>,140,210,aligned.borderSides).status,'invalid');
});
