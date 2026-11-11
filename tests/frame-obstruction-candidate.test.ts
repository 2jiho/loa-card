import test from 'node:test';
import assert from 'node:assert/strict';
import {frameObstructionCandidates,type ObstructionCell} from '../src/features/card-scanner/acquisition/frame-obstruction-candidate';

const width=350,height=235;
const cells:ObstructionCell[]=Array.from({length:8},(_,n)=>({x:10+(n%4)*80,y:5+Math.floor(n/4)*115,width:70,height:105,intact:true}));
function raster(){const out=new Uint8Array(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=(y*width+x)*4;out[i]=(x*13+y*7)%190+60;out[i+1]=(x*7+y*17)%190+60;out[i+2]=(x*3+y*5)%190+60;out[i+3]=255;
}return out;}
function fill(out:Uint8Array,x0:number,y0:number,x1:number,y1:number){for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
  const i=(y*width+x)*4;out[i]=20;out[i+1]=24;out[i+2]=27;
}}
test('wide dark region over two incomplete cells is diagnostic evidence, not a tooltip assertion',()=>{
  const pixels=raster();fill(pixels,85,130,250,180);
  const observed=cells.map((cell,n)=>({...cell,intact:n!==5&&n!==6}));
  const result=frameObstructionCandidates(pixels,width,height,observed);
  assert.ok(result&&result.candidates.some(c=>c.cells.includes(5)&&c.cells.includes(6)));
  assert.equal(result.canConcludeAbsence,false);
});
test('an intact grid and a partially covered single cell do not claim multi-cell evidence',()=>{
  const pixels=raster();fill(pixels,85,130,250,180);
  assert.equal(frameObstructionCandidates(pixels,width,height,cells)?.candidates.length,0);
  const one=cells.map((cell,n)=>({...cell,intact:n!==5}));
  assert.equal(frameObstructionCandidates(pixels,width,height,one)?.candidates.length,0);
});
test('uniform dark content with incomplete borders is ambiguous even without a tooltip',()=>{
  const pixels=raster();fill(pixels,0,0,width,height);
  const uncertain=cells.map((cell,n)=>({...cell,intact:n!==5&&n!==6}));
  assert.ok(frameObstructionCandidates(pixels,width,height,uncertain)?.candidates.length);
});
test('invalid sizes, frame bounds and overlapping cells are unverified',()=>{
  const pixels=raster();
  assert.equal(frameObstructionCandidates(pixels.subarray(1),width,height,cells),null);
  assert.equal(frameObstructionCandidates(pixels,4000,3000,cells),null);
  assert.equal(frameObstructionCandidates(pixels,width,height,[cells[0],cells[0]]),null);
  assert.equal(frameObstructionCandidates(pixels,width,height,[cells[0],{...cells[1],x:-1}]),null);
});
test('search window cap marks incomplete coverage',()=>{
  const w=2000,h=1000,pixels=new Uint8Array(w*h*4);
  pixels.fill(255);
  const far=[{x:0,y:0,width:70,height:105,intact:false},{x:80,y:0,width:70,height:105,intact:false},{x:1930,y:895,width:70,height:105,intact:false}];
  const result=frameObstructionCandidates(pixels,w,h,far);
  assert.equal(result?.truncated,true);
  assert.equal(result?.truncationReason,'window-limit');
  assert.equal(result?.canConcludeAbsence,false);
  assert.equal(result?.candidates.length,0);
});
test('vertical-only or too distant pairs are explicitly unsupported',()=>{
  const pixels=raster(),a={...cells[0],intact:false};
  for(const b of [{...cells[4],intact:false},{...cells[3],intact:false}]){
    const result=frameObstructionCandidates(pixels,width,height,[a,b]);
    assert.equal(result?.supported,false);
    assert.equal(result?.unsupportedReason,'no-searchable-horizontal-pair');
    assert.equal(result?.canConcludeAbsence,false);
  }
});
test('transparent sampled pixels and non-byte array-like data are invalid',()=>{
  const pixels=raster();fill(pixels,0,0,width,height);
  const incomplete=cells.map(c=>({...c,intact:false}));
  for(let i=3;i<pixels.length;i+=4)pixels[i]=0;
  assert.equal(frameObstructionCandidates(pixels,width,height,incomplete),null);
  assert.equal(frameObstructionCandidates({length:width*height*4} as ArrayLike<number>,width,height,incomplete),null);
});
test('overlapping windows exhausting the result limit disclose partial search',()=>{
  const pixels=raster();fill(pixels,0,0,width,height);
  const result=frameObstructionCandidates(pixels,width,height,cells.map(c=>({...c,intact:false})));
  assert.equal(result?.truncated,true);
  assert.equal(result?.truncationReason,'result-limit');
  assert.equal(result?.canConcludeAbsence,false);
});
test('overlap suppression retains separate neighboring regions and does not claim their full bounds',()=>{
  const pixels=raster();fill(pixels,10,12,160,64);fill(pixels,170,12,320,64);
  const observed=cells.map((c,n)=>({...c,intact:n>3}));
  const result=frameObstructionCandidates(pixels,width,height,observed);
  assert.ok(result);assert.equal(result.representation,'overlap-suppressed-samples');
  assert.ok(result.suppressedMatches>0);
  assert.ok(result.candidates.some(c=>c.cells.includes(0)&&c.cells.includes(1)));
  assert.ok(result.candidates.some(c=>c.cells.includes(2)&&c.cells.includes(3)));
  assert.ok(result.candidates.every(c=>c.width===140&&c.height===18),'evidence windows are not unioned into a panel boundary');
  assert.equal(result.canConcludeAbsence,false);
});
