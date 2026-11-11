import {test} from 'node:test';
import assert from 'node:assert/strict';
import {obstructionProbeEvidence} from '../scripts/obstruction-probe-evidence';

const box={x:80,y:5,width:140,height:210};
function image(width:number,height:number,value:number){const rgba=new Uint8Array(width*height*4);
 for(let i=0;i<rgba.length;i+=4){rgba[i]=rgba[i+1]=rgba[i+2]=value;rgba[i+3]=255;}return rgba;}
test('unsupported, invalid, and no candidate preserve reasons and do not run edge checks',()=>{
 const frame=image(300,220,20),pixels=image(140,210,20);
 const unsupported=obstructionProbeEvidence(frame,300,220,box,pixels,[1,1,1,1]);
 assert.equal(unsupported.lower.status,'unsupported');assert.equal(unsupported.lower.reason,'border-pattern');assert.equal(unsupported.edges,null);
 const invalid=obstructionProbeEvidence(frame,300,220,box,pixels,[1,1,1]);
 assert.equal(invalid.lower.status,'invalid');assert.equal(invalid.edges,null);
 const none=obstructionProbeEvidence(frame,300,220,box,pixels,[1,1,1,0]);
 assert.equal(none.lower.status,'none');assert.equal(none.edges,null);assert.equal(none.lower.canConcludeAbsence,false);
});
test('real candidate is passed to each edge check, preserving status and scope',()=>{
 const frame=image(300,220,20),pixels=image(140,210,20);
 for(let y=124;y<130;y++)for(let x=0;x<140;x++){
  const i=(y*140+x)*4,p=(x%2)*180;pixels[i]=pixels[i+1]=pixels[i+2]=p;
 }
 const result=obstructionProbeEvidence(frame,300,220,box,pixels,[1,1,1,0]);
 assert.equal(result.lower.status,'candidate');assert.ok(result.lower.candidate);
 assert.equal(result.edges?.left.status,'crosses');assert.equal(result.edges?.right.status,'crosses');
 assert.equal(result.edges?.left.scope,'same-color-card-edge-only');assert.equal(result.edges?.left.canConcludeAbsence,false);
});
