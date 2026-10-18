import {packPixels,pixelHash,fastCompress,entryParts,MAX_FRAME_BYTES} from './exact-recording-codec';
import type {ExactEvent} from './exact-recording-codec';
let sync:{write(data:BufferSource,options:{at:number}):number;flush():void;close():void}|undefined;
let port:MessagePort, writer:FileSystemWritableFileStream, directory:FileSystemDirectoryHandle, name='';
let chain=Promise.resolve(),previous:Uint8Array<ArrayBuffer>|undefined,width=0,height=0,bytes=0,frames=0,events=0,dropped=0;
let queuedBytes=0,peakQueuedBytes=0,peakWorkingBytes=0,readbackMs=0,encodeMs=0,failed='',requested=false,ended=false,closing=false;
const LIMIT=1024*1024*1024;
async function append(parts:BlobPart[]){
 const blobSize=parts.reduce<number>((n,part)=>n+(ArrayBuffer.isView(part)?part.byteLength:part instanceof ArrayBuffer?part.byteLength:part instanceof Blob?part.size:new TextEncoder().encode(part).length),0);
 if(bytes+blobSize>LIMIT)throw Error('무손실 기록 1GB 한도');
 if(parts.length>3){const joined=new Uint8Array(blobSize);let offset=0;for(const part of parts){const data=ArrayBuffer.isView(part)?new Uint8Array(part.buffer,part.byteOffset,part.byteLength):new Uint8Array(part instanceof ArrayBuffer?part:await new Blob([part]).arrayBuffer());joined.set(data,offset);offset+=data.length;}return append([joined]);}
 if(sync){for(const part of parts){const data=ArrayBuffer.isView(part)||part instanceof ArrayBuffer?part:part instanceof Blob?await part.arrayBuffer():new TextEncoder().encode(part);const written=sync.write(data,{at:bytes});if(written!==data.byteLength)throw Error('기록 파일 일부 쓰기 실패');bytes+=written;}}
 else {await writer.write(new Blob(parts));bytes+=blobSize;}
}
function enqueue(work:()=>Promise<void>){chain=chain.then(async()=>{if(!failed)await work();}).catch(error=>{failed=String(error);});}
function finish(){
 if(!requested||!ended||closing)return;closing=true;
 void chain.then(async()=>{
  if(sync){sync.flush();sync.close();sync=undefined;}else await writer.close();const blob=await(await directory.getFileHandle(name)).getFile();
  self.postMessage({kind:'done',blob,stats:{frames,events,dropped,bytes,peakQueuedBytes,peakWorkingBytes,readbackMs,encodeMs,complete:!failed&&!dropped&&frames>0,error:failed}});
 }).catch(error=>self.postMessage({kind:'error',error:String(error)}));
}
self.onmessage=async(event:MessageEvent)=>{
 const data=event.data;
 if(data.kind==='init'){
  try{
   directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('loacard-exact',{create:true});
   const entries=directory as FileSystemDirectoryHandle&{keys():AsyncIterable<string>};
   for await(const entry of entries.keys()){const stamp=/^(\d+)-[\da-f-]+\.bin$/.exec(entry);if(stamp&&Date.now()-Number(stamp[1])>86400000)await directory.removeEntry(entry).catch(()=>{});}
   name=`${Date.now()}-${crypto.randomUUID()}.bin`;const handle=await directory.getFileHandle(name,{create:true});
   if('createSyncAccessHandle' in handle)sync=await (handle as FileSystemFileHandle&{createSyncAccessHandle():Promise<NonNullable<typeof sync>>}).createSyncAccessHandle();
   else writer=await handle.createWritable();
   port=data.port;port.onmessage=e=>{
    const m=e.data;
    if(m.kind==='end'){peakQueuedBytes=Math.max(peakQueuedBytes,m.peakInFlightBytes??0);ended=true;finish();return;}
    if(m.kind==='gap'){dropped++;return;}
    if(m.kind!=='frame')return;
    const pixels=new Uint8Array(m.pixels);queuedBytes+=pixels.length;peakQueuedBytes=Math.max(peakQueuedBytes,queuedBytes);
    enqueue(async()=>{
     const start=performance.now();
     if(!Number.isInteger(m.width)||!Number.isInteger(m.height)||pixels.length!==m.width*m.height*4||pixels.length>MAX_FRAME_BYTES)throw Error('입력 크기 초과');
     const key=!previous||width!==m.width||height!==m.height;
     const delta=packPixels(pixels,key?undefined:previous,true);
     peakWorkingBytes=Math.max(peakWorkingBytes,queuedBytes+(previous?.length??0)+delta.length);
     const hash=await pixelHash(pixels),compressed=fastCompress(delta);
     peakWorkingBytes=Math.max(peakWorkingBytes,queuedBytes+(previous?.length??0)+delta.length*2+compressed.length+262144);
     await append(entryParts({kind:'frame',id:m.id,time:m.time,width:m.width,height:m.height,phase:m.phase,key,hash,codec:'lz4',xor:true},compressed));
     previous=pixels;width=m.width;height=m.height;frames++;readbackMs+=m.readbackMs;encodeMs+=performance.now()-start;
    });
    chain=chain.finally(()=>{queuedBytes-=pixels.length;port.postMessage({kind:'credit',bytes:pixels.length});});
   };port.start();self.postMessage({kind:'ready'});
  }catch(error){self.postMessage({kind:'error',error:String(error)});}
 }else if(data.kind==='events'){
  enqueue(async()=>{const batch=data.events as ExactEvent[];await append(batch.flatMap(entry=>entryParts(entry)));events+=batch.length;});
  chain=chain.finally(()=>self.postMessage({kind:'events-written'}));
 }else if(data.kind==='finish'){requested=true;if(data.noSource)ended=true;finish();}
 else if(data.kind==='dispose'){
  await chain;if(sync){sync.close();sync=undefined;}else await writer?.abort().catch(()=>{});if(name)await directory?.removeEntry(name).catch(()=>{});self.postMessage({kind:'disposed'});
 }
};
