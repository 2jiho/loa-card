import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {emptySlotVector,isEmptySlotVector} from '../src/features/card-scanner/acquisition/empty-slot';

// Original per-bin sampler, preserved only as an equivalence oracle for the
// loop optimization. This does not establish whether a crop is really empty.
function original(rgba:ArrayLike<number>,width:number,height:number) {
  if(width<28||height<40||rgba.length!==width*height*4)return new Float32Array();
  const out=new Float32Array(560);
  for(let y=0;y<28;y++){
    const top=Math.round(height*(6+198*y/28)/210),bottom=Math.round(height*(6+198*(y+1)/28)/210);
    for(let x=0;x<20;x++){
      const left=Math.round(width*(6+128*x/20)/140),right=Math.round(width*(6+128*(x+1)/20)/140);
      let total=0,count=0;
      for(let yy=top;yy<bottom;yy++)for(let xx=left;xx<right;xx++){
        const p=(yy*width+xx)*4;total+=.299*rgba[p]+.587*rgba[p+1]+.114*rgba[p+2];count++;
      }
      out[y*20+x]=count?total/count:0;
    }
  }
  return out;
}
test('empty-slot bin optimization preserves every vector element on varied sizes and recorded regression crops',async()=>{
  const fixtures=JSON.parse(await readFile('tests/fixtures/border-integrity-samples.json','utf8')) as
    {name:string;width:number;height:number;rgba:string}[];
  const rows=fixtures.map(v=>({name:v.name,width:v.width,height:v.height,data:Uint8Array.from(Buffer.from(v.rgba,'base64'))}));
  let state=0x12345678;
  for(const [width,height] of [[28,40],[29,41],[67,100],[139,209],[140,210],[141,211],[152,222],[257,383]]){
    const data=new Uint8Array(width*height*4);
    for(let i=0;i<data.length;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;data[i]=state>>>24;}
    rows.push({name:`seed-${width}x${height}`,width,height,data});
  }
  for(const row of rows){
    const before=original(row.data,row.width,row.height),after=emptySlotVector(row.data,row.width,row.height);
    assert.deepEqual(after,before,row.name);
    assert.equal(isEmptySlotVector(after),isEmptySlotVector(before),row.name);
  }
  assert.deepEqual(emptySlotVector(new Uint8Array(0),140,210),original(new Uint8Array(0),140,210));
});
