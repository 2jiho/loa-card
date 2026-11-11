import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cutRescueArea,rescueAreaBounds} from '../src/features/card-scanner/acquisition/rescue-area';
import {areaGray} from '../src/features/card-scanner/acquisition/area-gray';

/** A frame whose every byte depends on its position, so a wrong offset cannot go unnoticed. */
function frame(width:number,height:number) {
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const at=(y*width+x)*4;
    data[at]=(x*7+y*3)%256;data[at+1]=(x*13+y*5)%256;data[at+2]=(x+y*11)%256;data[at+3]=255;
  }
  const read=(x:number,y:number,w:number,h:number)=>{
    const out=new Uint8ClampedArray(w*h*4);
    for(let row=0;row<h;row++)out.set(data.subarray(((y+row)*width+x)*4,((y+row)*width+x+w)*4),row*w*4);
    return out;
  };
  return {width,height,read};
}

test('a cell cut from the frame area has the bytes of a direct read of that cell, and so the same feature', () => {
  const source=frame(200,160);
  const cells=[{x:10.4,y:8.6,width:40.2,height:50.3},{x:120,y:90,width:48,height:64},{x:60,y:20,width:30,height:40}];
  const bounds=rescueAreaBounds(cells,source.width,source.height)!;
  assert.deepEqual(bounds,{x:10,y:9,width:158,height:145});
  const area={...bounds,data:source.read(bounds.x,bounds.y,bounds.width,bounds.height)};
  for(const cell of cells){
    const x=Math.round(cell.x),y=Math.round(cell.y),w=Math.round(cell.width),h=Math.round(cell.height);
    const cut=cutRescueArea(area,x,y,w,h)!,direct=source.read(x,y,w,h);
    assert.deepEqual(cut,direct);
    assert.deepEqual(areaGray(cut,w,h),areaGray(direct,w,h));
  }
});

test('the area is clipped to the frame and a box outside it is refused, never filled in', () => {
  const source=frame(100,80);
  const bounds=rescueAreaBounds([{x:-5,y:10,width:30,height:30},{x:80,y:60,width:40,height:40}],source.width,source.height)!;
  assert.deepEqual(bounds,{x:0,y:10,width:100,height:70});
  const area={...bounds,data:source.read(bounds.x,bounds.y,bounds.width,bounds.height)};
  assert.equal(cutRescueArea(area,0,0,20,20),null);          // starts above the area
  assert.equal(cutRescueArea(area,90,60,20,20),null);        // runs past the right edge
  assert.equal(cutRescueArea(area,10.5,20,20,20),null);      // not whole pixels
  assert.equal(cutRescueArea(area,10,20,0,20),null);
  assert.equal(cutRescueArea({...area,data:area.data.subarray(4)},10,20,20,20),null); // copy of the wrong size
  assert.deepEqual(cutRescueArea(area,80,60,20,20),source.read(80,60,20,20));
});

test('no cells, or cells entirely outside the frame, give no area', () => {
  assert.equal(rescueAreaBounds([],100,80),null);
  assert.equal(rescueAreaBounds([{x:200,y:10,width:30,height:30}],100,80),null);
  assert.equal(rescueAreaBounds([{x:Number.NaN,y:10,width:30,height:30}],100,80),null);
});
