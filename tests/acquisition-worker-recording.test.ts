import test from 'node:test';
import assert from 'node:assert/strict';

test('acquisition forwards its immutable source after draw without recorder readback, keeping crop canvas and ownership separate',async()=>{
 const descriptors=Object.fromEntries(['self','OffscreenCanvas'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const replies:any[]=[],recorded:{message:any;transfers:any}[]=[],draws:any[]=[];
 let portClosed=0,throwTransfer=false;
 class Canvas {
  constructor(public width:number,public height:number){}
  getContext(){return {drawImage:(bitmap:any)=>{draws.push(bitmap);},getImageData:()=>{throw Error('recording must not perform acquisition-worker readback');}};}
 }
 const scope=Object.assign(Object.create(globalThis),{onmessage:null as any,postMessage(value:any){replies.push(value);}});
 const port={onmessage:null as any,start(){},close(){portClosed++;},postMessage(message:any,transfers:any){
  if(throwTransfer&&message.kind==='frame')throw Error('transfer failed');recorded.push({message,transfers});
 }};
 const input=(width=2,height=2)=>({width,height,closed:0,close(){this.closed++;}});
 const layout={cells:[],header:{},growthPoints:{},sort:{},area:{},scrollbar:{},scale:1};
 Object.defineProperty(globalThis,'self',{configurable:true,value:scope});Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:Canvas});
 try{
  await import('../src/features/card-scanner/acquisition-worker');
  await scope.onmessage({data:{kind:'record',port}});
  const first=input();await scope.onmessage({data:{id:1,bitmap:first,layout,time:1.25,phase:'input'}});
  assert.equal(first.closed,0,'forwarded input is no longer owned by acquisition');assert.equal(draws[0],first);
  assert.equal(recorded[0].message.bitmap,first);assert.deepEqual(recorded[0].transfers,[first]);
  assert.equal(recorded[0].message.pixels,undefined);assert.equal(recorded[0].message.id,1);assert.equal(recorded[0].message.time,1.25);assert.equal(recorded[0].message.phase,'input');
  assert.equal(replies.at(-1).id,1);assert.deepEqual(replies.at(-1).cells,[]);
  const only=input();await scope.onmessage({data:{id:2,bitmap:only,recordOnly:true,time:2}});
  assert.equal(only.closed,0);assert.equal(recorded.at(-1)!.message.phase,'recovery');assert.equal(draws.length,1,'record-only input needs no detector canvas copy');
  const third=input();await scope.onmessage({data:{id:3,bitmap:third,layout,time:3}});
  const dropped=input();await scope.onmessage({data:{id:4,bitmap:dropped,layout,time:4}});
  assert.equal(dropped.closed,1);assert.equal(recorded.at(-1)!.message.kind,'gap','existing three-frame credit cap remains');
  port.onmessage({data:{kind:'credit',bytes:16}});
  throwTransfer=true;const failed=input();await scope.onmessage({data:{id:5,bitmap:failed,layout,time:5}});
  assert.equal(failed.closed,1);assert.equal(recorded.at(-1)!.message.kind,'gap');assert.equal(replies.at(-1).id,5,'recorder failure must not block crop delivery');
  throwTransfer=false;const large=input(4000,3000);await scope.onmessage({data:{id:6,bitmap:large,recordOnly:true,time:6}});
  assert.equal(large.closed,1);assert.equal(recorded.at(-1)!.message.kind,'gap');
  await scope.onmessage({data:{kind:'record-end'}});assert.equal(portClosed,1);
  const normal=input();await scope.onmessage({data:{id:7,bitmap:normal,layout,time:7}});assert.equal(normal.closed,1,'unrecorded inputs retain old release behavior');
 }finally{for(const [key,descriptor] of Object.entries(descriptors))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
});
