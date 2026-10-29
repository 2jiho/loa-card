import test from 'node:test';
import assert from 'node:assert/strict';

async function runWorker(run:(h:any)=>Promise<void>){
 const previous=['self','OffscreenCanvas'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const),messages:any[]=[],draws:any[]=[];
 let current:Uint8ClampedArray<ArrayBuffer>=new Uint8ClampedArray(),lastBitmap:any,failPost=false;
 // A WorkerGlobalScope includes standard constructors. A plain object for
 // `self` can break tsx's cold module loader before the worker module loads.
 const scope=Object.assign(Object.create(globalThis),{onmessage:null as any,postMessage(data:any,transfer:any){
  if(data.kind==='raster'){
   assert.equal(lastBitmap?.closed??1,1,'native source closes before its RGBA buffer is posted');
   if(failPost){failPost=false;throw Error('output transfer failed');}
  }
  messages.push({data,transfer});
 }});
 const context={globalCompositeOperation:'source-over',drawImage(bitmap:any){lastBitmap=bitmap;draws.push({bitmap,operation:this.globalCompositeOperation});
  if(this.globalCompositeOperation==='copy')current=bitmap.rgba.slice();
  else current=new Uint8ClampedArray(current.length).fill(99);
 },getImageData(){return {data:current.slice()};}};
 class Canvas {constructor(public width:number,public height:number){}getContext(){return context;}}
 Object.defineProperty(globalThis,'self',{configurable:true,value:scope});Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:Canvas});
 try{
  const address=new URL('../src/features/card-scanner/recording-raster-worker.ts',import.meta.url);address.searchParams.set('test',crypto.randomUUID());await import(address.href);
  await run({messages,draws,send:(data:any)=>scope.onmessage({data}),failNextPost:()=>{failPost=true;}});
 }finally{for(const [key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
}
function bitmap(rgba=[1,2,3,255],width=1,height=1){return {width,height,rgba:Uint8ClampedArray.from(rgba),closed:0,close(){this.closed++;}};}
const request=(id:number,source:ReturnType<typeof bitmap>,extra={})=>({kind:'raster',id,width:source.width,height:source.height,bitmap:source,sentAt:performance.timeOrigin+performance.now(),...extra});

test('actual raster Worker preserves native RGBA, closes payload before response, and transfers one owned buffer',async()=>{
 await runWorker(async(h:any)=>{
  h.send({kind:'init'});assert.equal(h.messages[0].data.kind,'ready');
  const source=bitmap([12,23,34,128,35,46,57,255],2,1);h.send(request(7,source));
  const result=h.messages[1];assert.equal(result.data.kind,'raster');assert.equal(result.data.id,7);
  assert.deepEqual([...new Uint8Array(result.data.pixels)],[...source.rgba]);assert.deepEqual(result.transfer,{transfer:[result.data.pixels]});
  assert.equal(source.closed,1);assert.equal(h.draws[0].operation,'copy');
  assert.ok(Number.isFinite(result.data.readbackMs)&&result.data.readbackMs>=0);assert.ok(Number.isFinite(result.data.queueMs)&&result.data.queueMs>=0);
  h.send({kind:'dispose'});assert.equal(h.messages.at(-1).data.kind,'disposed');
 });
});

test('transparent inputs replace reused canvas pixels instead of blending with a previous source',async()=>{
 await runWorker(async(h:any)=>{
  h.send({kind:'init'});
  const first=bitmap([255,0,0,128]),second=bitmap([0,0,255,128]),empty=bitmap([0,0,0,0]);
  for(const [index,source]of [first,second,empty].entries())h.send(request(index+1,source));
  const outputs=h.messages.filter((value:any)=>value.data.kind==='raster');
  assert.deepEqual(outputs.map((value:any)=>[...new Uint8Array(value.data.pixels)]),[[255,0,0,128],[0,0,255,128],[0,0,0,0]]);
  assert.deepEqual([first.closed,second.closed,empty.closed],[1,1,1]);
 });
});

test('invalid, unprepared and disposed requests still close the child-owned native source',async()=>{
 await runWorker(async(h:any)=>{
  const unprepared=bitmap();h.send(request(1,unprepared));assert.equal(h.messages.at(-1).data.kind,'raster-error');assert.equal(unprepared.closed,1);
  h.send({kind:'init'});
  for(const extra of [{id:0},{sentAt:NaN},{width:2},{width:100000,height:100000}]){
   const source=bitmap();h.send(request(2,source,extra));assert.equal(h.messages.at(-1).data.kind,'raster-error');assert.equal(source.closed,1);
  }
  h.send({kind:'dispose'});const late=bitmap();h.send(request(8,late));assert.equal(h.messages.at(-1).data.kind,'raster-error');assert.equal(late.closed,1);
 });
});

test('a failed output transfer closes native ownership once and emits an error rather than pixels',async()=>{
 await runWorker(async(h:any)=>{
  h.send({kind:'init'});h.failNextPost();const source=bitmap();h.send(request(1,source));
  assert.equal(source.closed,1);assert.equal(h.messages.at(-1).data.kind,'raster-error');assert.match(h.messages.at(-1).data.error,/output transfer failed/);
 });
});
