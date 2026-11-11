import {test} from 'node:test';
import assert from 'node:assert/strict';
import {occlusionBoundaryProbe,type ProbeCell} from '../dev/occlusion-boundary-probe';

function fixture(offsetX=0,offsetY=0){
 const width=800,height=480,pixels=new Uint8Array(width*height*4),cells:ProbeCell[]=[];
 for(let i=0;i<width*height;i++){pixels[i*4]=pixels[i*4+1]=pixels[i*4+2]=95;pixels[i*4+3]=255;}
 for(let row=0;row<4;row++)for(let column=0;column<10;column++)cells.push({x:10+offsetX+column*76,y:10+offsetY+row*112,width:70,height:105});
 return {pixels,width,height,cells};
}
function paint(pixels:Uint8Array,width:number,x:number,y:number,w:number,h:number,value:number){
 for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){const i=(yy*width+xx)*4;pixels[i]=pixels[i+1]=pixels[i+2]=value;}
}
test('parallel rails across multiple grid rows form only an unconfirmed candidate',()=>{
 const {pixels,width,height,cells}=fixture(3,4);paint(pixels,width,190,75,18,170,20);paint(pixels,width,320,75,18,170,20);
 const result=occlusionBoundaryProbe(pixels,width,height,cells);assert.ok(result);assert.equal(result.canConcludeAbsence,false);
 assert.ok(result.candidates.some(item=>item.x<=200&&item.x+item.width>=330&&item.cells.length>=4));
 assert.equal(result.scope,'parallel-dark-rails');
});
test('a single dark rail is not a paired candidate and cannot establish absence',()=>{
 const {pixels,width,height,cells}=fixture();paint(pixels,width,190,75,18,170,20);
 const result=occlusionBoundaryProbe(pixels,width,height,cells);assert.ok(result);assert.equal(result.candidates.length,0);assert.equal(result.canConcludeAbsence,false);
});
test('repeated dark card gutters do not count as cross-card rails',()=>{
 const {pixels,width,height,cells}=fixture();
 for(let column=0;column<9;column++)paint(pixels,width,80+column*76,10,6,440,20);
 const result=occlusionBoundaryProbe(pixels,width,height,cells);assert.ok(result);assert.equal(result.candidates.length,0);
});
test('invalid pixel and grid inputs are unsupported rather than classified clear',()=>{
 const {pixels,width,height,cells}=fixture();pixels[(10*width+10)*4+3]=0;
 assert.equal(occlusionBoundaryProbe(pixels,width,height,cells),null);
 assert.equal(occlusionBoundaryProbe(pixels,width,height,[cells[0],cells[0],...cells.slice(1,3)]),null);
});
