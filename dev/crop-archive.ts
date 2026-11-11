import {cropJournalHash,replayRecognitionCropJournal,type CropBatchItem,type CropCheckpoint,type CropEvent,type CropJournalSeed,type CropJournalSink} from './recognition-crop-journal';

/** Recognition crops only. Never describes an original screen recording. */
const MAGIC=new TextEncoder().encode('LCROP02\n'),END=new TextEncoder().encode('ENDLC02\n');
const MAX_META=16*1024*1024,MAX_TOTAL=280*1024*1024,MAX_CROP=4*1024*1024;
type Pixel={key:string;width:number;height:number;sha256:string};
interface Manifest {version:1;kind:'loacard-recognition-crops';seed:CropJournalSeed;events:CropEvent[];checkpoint:CropCheckpoint|null;pixels:Pixel[]}
export interface SliceInput {size:number;slice(start:number,end:number):{arrayBuffer():Promise<ArrayBuffer>}}
export interface StreamSink {write(bytes:Uint8Array):Promise<void>;close():Promise<void>;abort(reason?:unknown):Promise<void>}
const encoder=new TextEncoder(),equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
const bytes=async(input:SliceInput,start:number,length:number)=>new Uint8Array(await input.slice(start,start+length).arrayBuffer());
const int32=(n:number)=>{const v=new Uint8Array(4);new DataView(v.buffer).setUint32(0,n,false);return v;};
const bounded=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
function index(events:readonly CropEvent[]):Pixel[]{
 const entries:Pixel[]=[],seen=new Set<string>();
 for(const event of events){if(event.kind!=='crop'||event.shared)continue;
  if(!bounded(event.width)||!bounded(event.height)||event.width*event.height*4>MAX_CROP||!/^[a-f0-9]{64}$/.test(event.sha256))throw Error('Invalid crop record');
  const key=`${event.width}x${event.height}:${event.sha256}`;if(seen.has(key))throw Error('Duplicate unique crop');
  seen.add(key);entries.push({key,width:event.width,height:event.height,sha256:event.sha256});
 }return entries;
}
function manifest(seed:CropJournalSeed,events:CropEvent[],checkpoint:CropCheckpoint|null):Manifest{
 if(!Array.isArray(events)||events.length>50000)throw Error('Invalid event count');
 return {version:1,kind:'loacard-recognition-crops',seed,events,checkpoint,pixels:index(events)};
}
export async function exportCropArchive(input:{seed:CropJournalSeed;events:CropEvent[];checkpoint:CropCheckpoint|null;read:(key:string)=>Promise<Uint8Array|undefined>},sink:StreamSink,signal:AbortSignal){
 try{
  const proof=await replayRecognitionCropJournal(input.seed,input.events,input.checkpoint,input.read,()=>{},signal);
  const data=manifest(input.seed,input.events,input.checkpoint),json=encoder.encode(JSON.stringify(data));
  if(json.length>MAX_META)throw Error('Archive metadata exceeds limit');
  const expected=MAGIC.length+4+json.length+32+END.length+data.pixels.reduce((n,p)=>n+p.width*p.height*4,0);
  if(expected>MAX_TOTAL)throw Error('Archive exceeds limit');
  const digest=Uint8Array.from((await cropJournalHash(json)).match(/../g)!.map(x=>parseInt(x,16)));
  for(const chunk of [MAGIC,int32(json.length),json,digest]){signal.throwIfAborted();await sink.write(chunk);}
  for(const p of data.pixels){signal.throwIfAborted();const pixels=await input.read(p.key);
   if(!(pixels instanceof Uint8Array)||pixels.byteLength!==p.width*p.height*4||await cropJournalHash(pixels)!==p.sha256)throw Error('Crop pixel missing or corrupt');
   await sink.write(pixels);
  }
  await sink.write(END);await sink.close();return {bytes:expected,complete:proof.complete,crops:proof.crops,unique:proof.unique,shared:proof.shared,metadataSha256:await cropJournalHash(json)};
 }catch(error){await sink.abort(error).catch(()=>{});throw error;}
}
export async function openCropArchive(input:SliceInput,signal:AbortSignal){
 if(!Number.isSafeInteger(input.size)||input.size<52||input.size>MAX_TOTAL)throw Error('Invalid archive size');
 if(!equal(await bytes(input,0,8),MAGIC))throw Error('Invalid archive magic');
 const header=await bytes(input,8,4);if(header.length!==4)throw Error('Truncated archive header');
 const len=new DataView(header.buffer,header.byteOffset,header.byteLength).getUint32(0,false);
 if(!len||len>MAX_META||12+len+32+END.length>input.size)throw Error('Invalid metadata length');
 const json=await bytes(input,12,len),hash=await bytes(input,12+len,32);
 const actual=Uint8Array.from((await cropJournalHash(json)).match(/../g)!.map(x=>parseInt(x,16)));
 if(json.length!==len||!equal(hash,actual))throw Error('Archive metadata hash mismatch');
 const parsed:Manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json));
 if(!parsed||parsed.version!==1||parsed.kind!=='loacard-recognition-crops'||!Array.isArray(parsed.pixels))throw Error('Invalid archive metadata');
 const expected=index(parsed.events);if(JSON.stringify(expected)!==JSON.stringify(parsed.pixels))throw Error('Archive pixel index mismatch');
 let offset=12+len+32;const offsets=new Map<string,{start:number;length:number}>();
 for(const p of expected){const length=p.width*p.height*4;offsets.set(p.key,{start:offset,length});offset+=length;}
 if(offset+END.length!==input.size||!equal(await bytes(input,offset,END.length),END))throw Error('Archive truncated or trailing bytes');
 const read=async(key:string)=>{signal.throwIfAborted();const p=offsets.get(key);if(!p)return;return bytes(input,p.start,p.length);};
 const proof=await replayRecognitionCropJournal(parsed.seed,parsed.events,parsed.checkpoint,read,()=>{},signal);
 return {...parsed,read,proof,metadataSha256:await cropJournalHash(json),close:()=>{}};
}

/** The verified archive is copied to a NEW sink, never replacing an old run.
 * A failed copy leaves its incomplete prefix intact for inspection. */
export async function restoreCropArchive(archive:Awaited<ReturnType<typeof openCropArchive>>,sink:CropJournalSink,signal:AbortSignal){
 if(!sink.appendBatch)throw Error('Atomic batch sink unavailable');
 await sink.begin(archive.seed);let pending:CropBatchItem[]=[],original:CropEvent[]=[],pendingBytes=0,written=0;
 const flush=async()=>{if(!pending.length)return;signal.throwIfAborted();const emitted=await sink.appendBatch!(pending);
  if(emitted.length!==original.length||emitted.some((event,i)=>JSON.stringify(event)!==JSON.stringify(original[i])))throw Error('Restored crop event bytes differ');
  written+=emitted.length;pending=[];original=[];pendingBytes=0;};
 for(const event of archive.events){
  signal.throwIfAborted();const length=event.kind==='crop'?event.width*event.height*4:0;
  if(pending.length>=32||pendingBytes+length>MAX_CROP)await flush();
  if(event.kind==='crop'){
   const pixels=await archive.read(`${event.width}x${event.height}:${event.sha256}`);
   if(!(pixels instanceof Uint8Array)||pixels.byteLength!==length||await cropJournalHash(pixels)!==event.sha256)throw Error('Archive pixel changed during import');
   pending.push({kind:'pixels',seq:event.seq,readId:event.readId,width:event.width,height:event.height,sha256:event.sha256,pixels,originalEvent:event});
  }else pending.push({kind:'event',event});
  original.push(event);pendingBytes+=length;
 }
 await flush();if(archive.checkpoint)await sink.seal(archive.checkpoint);
 return {complete:archive.proof.complete,events:written,crops:archive.proof.crops,unsealed:archive.checkpoint===null};
}
