import test from 'node:test';
import assert from 'node:assert/strict';
import {exactEntries,exactPixels,pixelHash,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import {createReproductionBundle,openReproduction} from '../src/features/card-scanner/scan-reproduction';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY} from '../src/features/card-scanner/rgba-window-policy';

async function harness(run:(h:any)=>Promise<void>){
  const keys=['self','navigator','OffscreenCanvas','Worker'],old=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  let file=new Uint8Array(1_048_576),size=0,removed=0,rasterCalls=0,sourceReading=false,maxSourceRead=0;
  const messages:any[]=[],sourceMessages:any[]=[],chunks:Blob[]=[];
  const view=(value:BufferSource)=>ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
  const sync={write(value:BufferSource,{at}:{at:number}){const data=view(value);if(at+data.length>file.length){const next=new Uint8Array((at+data.length)*2);next.set(file);file=next;}
      file.set(data,at);size=Math.max(size,at+data.length);return data.length;},
    read(value:BufferSource,{at}:{at:number}){const target=view(value);if(sourceReading)maxSourceRead=Math.max(maxSourceRead,target.length);target.set(file.subarray(at,at+target.length));return target.length;},flush(){},close(){}};
  const directory={async *keys(){},async removeEntry(){removed++;},async getFileHandle(){return{async createSyncAccessHandle(){return sync;},async getFile(){return new Blob([file.slice(0,size)]);}};}};
  const scope={onmessage:null as any,postMessage(value:any,options?:{transfer?:Transferable[]}){
    // Exercise actual outbound ownership transfer; detaching the writer's
    // predecessor by mistake must break the following frame's roundtrip.
    const received=structuredClone(value,options?.transfer?{transfer:options.transfer}:undefined);messages.push(received);
    if(received.kind==='read-frame'||received.kind==='read-error')sourceReading=false;
    if(received.kind==='journal-chunk'){
      chunks.push(received.blob);assert.equal(received.sequence,chunks.length-1);
      queueMicrotask(()=>void scope.onmessage({data:{kind:'journal-credit',sequence:received.sequence,bytes:received.blob.size}}));
    }
  }};
  const port={onmessage:null as any,start(){},postMessage(value:any){sourceMessages.push(structuredClone(value));}};
  class Canvas{
    private rgba=new Uint8ClampedArray();constructor(public width:number,public height:number){}
    getContext(){return{drawImage:(bitmap:any)=>{rasterCalls++;this.rgba=new Uint8ClampedArray(bitmap.rgba);},getImageData:()=>({data:this.rgba.slice()})};}
  }
  Object.defineProperty(globalThis,'self',{configurable:true,value:scope});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{async getDirectory(){return{async getDirectoryHandle(){return directory;}};}}}});
  Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:Canvas});
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:class{constructor(){throw Error('inline raster fixture');}}});
  const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+10000;while(!predicate()){if(Date.now()>deadline)throw Error('window worker fixture deadline');await new Promise<void>(resolve=>setImmediate(resolve));}};
  try{
    const module=new URL('../src/features/card-scanner/exact-recording-worker.ts',import.meta.url);module.searchParams.set('window-test',crypto.randomUUID());await import(module.href);
    await scope.onmessage({data:{kind:'init',port,codecPolicy:RGBA_WINDOW_POLICY}});
    assert.equal(messages[0].kind,'ready');assert.equal(messages[0].codecPolicy,RGBA_WINDOW_POLICY);assert.equal(messages[0].codec,RGBA_WINDOW_CODEC);
    await run({source:(message:any)=>port.onmessage({data:message}),send:(message:any)=>{if(message.kind==='read-frame')sourceReading=true;return scope.onmessage({data:message});},
      messages,sourceMessages,chunks,until,rasterCalls:()=>rasterCalls,maxSourceRead:()=>maxSourceRead,removed:()=>removed});
  }finally{
    if(!messages.some(message=>message.kind==='disposed'))await scope.onmessage?.({data:{kind:'dispose'}});
    for(const [key,descriptor]of old)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);
  }
}
function frame(id:number,width=32,height=16){
  const pixels=new Uint8Array(width*height*4).fill(55);pixels[id%pixels.length]=id;
  const bitmap={width,height,rgba:pixels,closed:0,close(){this.closed++;}};
  return{pixels,bitmap,message:{kind:'frame',canonical:true,role:'input',id,time:20-id,width,height,phase:id%2?'input':'recovery',bitmap}};
}

test('window writer, OPFS range read, journal, export/import and exact pixels share one tagged input',async()=>{
  await harness(async(h:any)=>{
    const expected=new Map<number,string>();
    for(let id=1;id<=10;id++){
      const input=frame(id);expected.set(id,await pixelHash(input.pixels));h.source(input.message);
      await h.until(()=>h.sourceMessages.filter((message:any)=>message.kind==='stored').length===id);
    }
    await h.send({kind:'read-frame',requestId:1,id:8});await h.until(()=>h.messages.some((message:any)=>message.kind==='read-frame'||message.kind==='read-error'));
    const reply=h.messages.find((message:any)=>message.kind==='read-frame'||message.kind==='read-error');assert.equal(reply.kind,'read-frame',reply.error);
    const read=reply.raw;
    assert.equal(read.id,8);assert.equal(read.hash,expected.get(8));assert.equal(await pixelHash(new Uint8Array(read.pixels.buffer)),expected.get(8));
    assert.ok(h.maxSourceRead()<=32768,'window OPFS payload reads must remain bounded');
    // Mutating a returned caller-owned copy must not damage the XOR predecessor.
    read.pixels.fill(199);const last=frame(11);expected.set(11,await pixelHash(last.pixels));h.source(last.message);
    await h.until(()=>h.sourceMessages.filter((message:any)=>message.kind==='stored').length===11);
    await h.send({kind:'journal-start'});h.source({kind:'end'});await h.send({kind:'finish',noSource:false});
    await h.until(()=>h.messages.some((message:any)=>message.kind==='done')&&h.messages.some((message:any)=>message.kind==='journal-done'));
    const done=h.messages.find((message:any)=>message.kind==='done'),journal=new Blob(h.chunks);
    assert.equal(done.stats.complete,true);assert.equal(done.stats.codec,RGBA_WINDOW_CODEC);assert.equal(done.stats.policy,RGBA_WINDOW_POLICY);
    assert.equal(journal.size,done.blob.size);assert.deepEqual(new Uint8Array(await journal.arrayBuffer()),new Uint8Array(await done.blob.arrayBuffer()));
    const headers=[];for await(const {header}of exactEntries(journal,new AbortController().signal))if(header.kind==='frame')headers.push(header);
    assert.deepEqual(headers.filter(header=>header.key).map(header=>header.id),[1,9]);
    assert.ok(headers.every(header=>header.codec===RGBA_WINDOW_CODEC&&header.policy===RGBA_WINDOW_POLICY));
    const metadata={version:6 as const,createdAt:new Date().toISOString(),browser:'test',catalog:'test',build:'test',completed:true,warnings:[],
      exact:done.stats,duration:11,type:'',bytes:0,seed:[],result:null};
    const opened=await openReproduction(createReproductionBundle({video:new Blob(),exact:journal,metadata}),new AbortController().signal);
    const decoded=[];for await(const output of exactPixels(opened.exact!,new AbortController().signal,0,RGBA_WINDOW_POLICY)){
      assert.equal(await pixelHash(output.pixels),expected.get(output.id));decoded.push([output.id,output.time,output.phase]);
    }
    assert.deepEqual(decoded,Array.from({length:11},(_,i)=>[i+1,19-i,(i+1)%2?'input':'recovery']));
    assert.equal((await executionSummary(opened.exact!,new AbortController().signal,opened.metadata.exact)).recordingComplete,true);
  });
});

test('window writer admits a third large delta where the legacy cumulative work rule needs a new key',async()=>{
  await harness(async(h:any)=>{
    for(let id=1;id<=3;id++){
      const input=frame(id,2560,1440);h.source(input.message);
      await h.until(()=>h.sourceMessages.filter((message:any)=>message.kind==='stored').length===id);
    }
    h.source({kind:'end'});await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((message:any)=>message.kind==='done'));
    const done=h.messages.find((message:any)=>message.kind==='done');assert.equal(done.stats.complete,true);
    const keys=[];for await(const {header}of exactEntries(done.blob,new AbortController().signal))if(header.kind==='frame')keys.push(header.key);
    assert.deepEqual(keys,[true,false,false]);
  });
});

test('unsupported window geometry is rejected before raster allocation and leaves an explicit partial prefix',async()=>{
  await harness(async(h:any)=>{
    const bitmap={width:3840,height:2160,rgba:new Uint8Array(4),close(){}};
    h.source({kind:'frame',canonical:true,role:'input',id:1,time:0,width:3840,height:2160,bitmap});
    await h.until(()=>h.sourceMessages.some((message:any)=>message.kind==='source-error'));assert.equal(h.rasterCalls(),0);
    h.source({kind:'end'});await h.send({kind:'finish',noSource:false});await h.until(()=>h.messages.some((message:any)=>message.kind==='done'));
    const done=h.messages.find((message:any)=>message.kind==='done');assert.equal(done.stats.complete,false);assert.equal(done.stats.frames,0);assert.match(done.stats.error,/크기|RGBA/);
  });
});
