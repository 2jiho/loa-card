import {test} from 'node:test';
import assert from 'node:assert/strict';
import {visualGradeConflict,visualGradeEvidence} from '../src/features/card-scanner/recognition/visual-grade-evidence';

const WIDTH=140,HEIGHT=210;
const green=[50,220,10] as const,blue=[10,140,220] as const;
function blank(){const pixels=new Uint8ClampedArray(WIDTH*HEIGHT*4);for(let i=3;i<pixels.length;i+=4)pixels[i]=255;return pixels;}
function set(p:Uint8ClampedArray,x:number,y:number,color:readonly number[]){const i=(y*WIDTH+x)*4;p[i]=color[0];p[i+1]=color[1];p[i+2]=color[2];}
function glyph(p:Uint8ClampedArray,color:readonly number[],count=36,xOffset=0){
  // A connected 4x9 label component. Both axes are inside the accepted text band.
  for(let i=0;i<count;i++)set(p,6+10+xOffset+i%4,14+1+Math.floor(i/4),color);
}
function edges(p:Uint8ClampedArray,color:readonly number[],count=50,offset=0){
  for(let i=offset;i<offset+count;i++){
    const side=i%2===0?0:134,position=Math.floor(i/2);
    set(p,side+position%6,52+Math.floor(position/6),color);
  }
}
function sample(color:readonly number[],count=36,edgeCount=50){const p=blank();glyph(p,color,count);edges(p,color,edgeCount);return p;}

test('confident name and border color can veto a mismatched rarity but never select an identity',()=>{
  const g=visualGradeEvidence(sample(green)),b=visualGradeEvidence(sample(blue));
  assert.equal(g.grade,1);assert.equal(b.grade,2);
  assert.equal(visualGradeConflict(g,2),true);assert.equal(visualGradeConflict(g,1),false);
  assert.equal(visualGradeConflict(b,1),true);assert.equal(visualGradeConflict(b,2),false);
  for(const invalid of [null,undefined,-1,5,1.5,'2',NaN])assert.equal(visualGradeConflict(b,invalid),false);
});
test('evidence thresholds require at least 35 glyph pixels and 50 edge pixels',()=>{
  assert.equal(visualGradeEvidence(sample(green,35,50)).grade,1);
  assert.equal(visualGradeEvidence(sample(green,34,50)).grade,null);
  assert.equal(visualGradeEvidence(sample(green,35,49)).grade,null);
});
test('contradictory ink, contradictory edges and flat images remain unknown',()=>{
  assert.equal(visualGradeEvidence(blank()).grade,null);
  const mixedName=sample(green);glyph(mixedName,blue,36,30);
  assert.equal(visualGradeEvidence(mixedName).grade,null);
  const mixedBorder=sample(green);edges(mixedBorder,blue,50,50);
  assert.equal(visualGradeEvidence(mixedBorder).grade,null);
  const hugePatch=blank();for(let y=15;y<31;y++)for(let x=7;x<133;x++)set(hugePatch,x,y,green);edges(hugePatch,green);
  assert.equal(visualGradeEvidence(hugePatch).grade,null,'artwork-colored solid block is not a glyph');
});
test('invalid size and transparent pixels in either evidence region are unavailable',()=>{
  assert.equal(visualGradeEvidence(new Uint8Array(5)).grade,null);
  for(const [x,y] of [[6,14],[133,31],[0,52],[139,159]]){
    const p=sample(green);p[(y*WIDTH+x)*4+3]=254;
    assert.equal(visualGradeEvidence(p).grade,null,`alpha ${x},${y}`);
  }
  const unrelated=sample(green);unrelated[(180*WIDTH+60)*4+3]=0;
  assert.equal(visualGradeEvidence(unrelated).grade,1,'irrelevant image pixels do not enter this signal');
});
