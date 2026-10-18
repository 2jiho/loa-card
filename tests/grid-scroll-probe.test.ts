import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pixelRegion} from '../src/features/card-scanner/pixel-region';
import {createGridScrollProbe} from '../src/features/card-scanner/grid-scroll-probe';
import type {Layout} from '../src/features/card-scanner/detector';
const layout={area:{x:0,y:0,width:100,height:40},scale:1,cells:Array.from({length:40},(_,i)=>({x:i%10*10,y:Math.floor(i/10)*10,width:10,height:10}))} as Layout;
function grid(offset=0){
 const data=new Uint8ClampedArray(100*40*4);
 for(let y=0;y<40;y++)for(let x=0;x<100;x++){
 const id=(Math.floor(y/10)+offset)*10+Math.floor(x/10),i=(y*100+x)*4;
 data[i]=(id*73+37)%251;data[i+1]=(id*103+13)%251;data[i+2]=(id*31+91)%251;data[i+3]=255;
 }return {data,width:100,height:40};
}
test('pixel subregions preserve every byte and own their storage',()=>{
 const source=grid(),region=pixelRegion(source,7,8,11,13)!;
 for(let y=0;y<13;y++)for(let x=0;x<11;x++)for(let c=0;c<4;c++)assert.equal(region.data[(y*11+x)*4+c],source.data[((y+8)*100+x+7)*4+c]);
 const before=source.data[(8*100+7)*4];region.data[0]^=255;assert.equal(source.data[(8*100+7)*4],before);
 assert.equal(pixelRegion(source,-1,0,1,1),undefined);assert.equal(pixelRegion(source,90,0,11,1),undefined);assert.equal(pixelRegion(source,0,.5,1,1),undefined);
});
test('pre-crop probe tracks one and three rows without horizontal matches',()=>{
 const probe=createGridScrollProbe(),origin={x:0,y:0};
 assert.equal(probe(grid(),origin,layout,100,40),null);
 assert.equal(probe(grid(1),origin,layout,100,40),1);
 assert.equal(probe(grid(4),origin,layout,100,40),3);
 assert.equal(probe(grid(1),origin,layout,100,40),-3);
 assert.equal(probe(grid(5),origin,layout,100,40),null,'four new rows have no overlap to track');
 const shifted={...layout,cells:layout.cells.map(b=>({...b,x:b.x+1}))};
 assert.equal(probe(grid(1),origin,shifted,100,40),null,'window movement invalidates row continuity');
 assert.equal(probe(grid(1),origin,{...shifted,scale:1.25},100,40),null,'scale change invalidates continuity');
});
test('blank grids and changed columns cannot propose a cache remap',()=>{
 const origin={x:0,y:0},probe=createGridScrollProbe(),blank={data:new Uint8ClampedArray(100*40*4),width:100,height:40};
 probe(blank,origin,layout,100,40);assert.equal(probe(blank,origin,layout,100,40),null);
 probe(grid(),origin,layout,100,40);const swapped=grid(1),original=grid(1);
 for(let y=0;y<40;y++)for(let x=0;x<100;x++){
 const from=(y*100+(x+10)%100)*4;swapped.data.set(original.data.subarray(from,from+4),(y*100+x)*4);
 }
 assert.equal(probe(swapped,origin,layout,100,40),null);
});
