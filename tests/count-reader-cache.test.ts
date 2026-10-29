import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNameReader} from '../src/features/card-scanner/name-reader';

test('count OCR reuses only identical raw pixels, dimensions and maximum, not just a white mask',async()=>{
  const oldWorker=globalThis.Worker,oldDocument=globalThis.document;
  let calls=0,shade=200,answer='+15';
  class FakeWorker {
    onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;
    postMessage(message:{id:number;type:string}){
      if(message.type==='recognize')calls++;
      queueMicrotask(()=>this.onmessage?.({data:{id:message.id,result:{text:answer,confidence:.98}}}));
    }
    terminate(){}
  }
  class FakeCanvas {
    width=40;height=20;
    getContext(){return {
      drawImage(){},putImageData(){},
      createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)}),
      getImageData:(_x:number,_y:number,w:number,h:number)=>{
        const data=new Uint8ClampedArray(w*h*4);
        for(let i=0;i<data.length;i+=4){data[i]=data[i+1]=data[i+2]=shade;data[i+3]=255;}
        return {data};
      },
    };}
  }
  globalThis.Worker=FakeWorker as unknown as typeof Worker;
  globalThis.document={createElement:()=>new FakeCanvas()} as unknown as Document;
  const reader=createNameReader([]),source=new FakeCanvas() as unknown as HTMLCanvasElement;
  try{
    assert.equal(await reader.count(source,15),15);assert.equal(calls,2);
    assert.equal(await reader.count(source,15),15);assert.equal(calls,2);
    shade=201;answer='+14';
    assert.equal(await reader.count(source,15),14);assert.equal(calls,4,'same binary mask, different raw bytes');
    assert.equal(await reader.count(source,14),14);assert.equal(calls,6,'maximum participates in parsing');
    source.width=50;source.height=16;
    assert.equal(await reader.count(source,14),14);assert.equal(calls,8,'same byte length, different shape');
  }finally{await reader.dispose();globalThis.Worker=oldWorker;globalThis.document=oldDocument;}
});
