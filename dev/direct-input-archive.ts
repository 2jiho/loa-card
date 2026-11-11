import {createHash,randomUUID} from 'node:crypto';
import {openAsBlob} from 'node:fs';
import {lstat,mkdir,open,rmdir,unlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import type {IncomingMessage} from 'node:http';
import {basename,dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {addCorpusCase,validateCorpusInputSelection,type CorpusInputSelection} from '../scripts/scan-corpus-core.mjs';
import {ReplayArchiveError,type ReplayReader} from './replay-archive.ts';

export const MAX_DIRECT_HEADER_BYTES=256*1024;
export const MAX_DIRECT_INPUT_BYTES=1024*1024*1024;
export const MAX_DIRECT_TOTAL_BYTES=2*1024*1024*1024;
const MAGIC=Buffer.from('LOAINP1\0','ascii');
const video=new Set(['.mp4','.webm','.mov','.m4v','.mkv']);
const images=new Set(['.png','.jpg','.jpeg','.webp','.bmp','.gif']);
const active=new Set<string>();
const timeoutMs=10*60*1000;
type DirectInput={index:number;extension:string;bytes:number;sha256:string};
type Header={version:1;kind:'video'|'images'|'replay';inputs:DirectInput[]}|{version:2;kind:'video'|'images'|'replay';inputs:DirectInput[];selection:CorpusInputSelection};
export class DirectArchiveError extends Error {readonly status:number;constructor(status:number,message:string){super(message);this.status=status;}}
const invalid=()=>new DirectArchiveError(400,'Invalid direct input envelope.');
const own=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
function parseHeader(bytes:Buffer):Header {
 let text:string,value:unknown;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(text);}catch{throw invalid();}
 // Only the sender's canonical JSON is accepted; duplicate keys cannot be hidden.
 if(JSON.stringify(value)!==text||!own(value)||(value.version!==1&&value.version!==2)||
  Object.keys(value).sort().join(',')!==(value.version===1?'inputs,kind,version':'inputs,kind,selection,version')||
  (value.kind!=='video'&&value.kind!=='images'&&value.kind!=='replay')||!Array.isArray(value.inputs)||
  value.inputs.length<1||value.inputs.length>1000||value.kind!=='images'&&value.inputs.length!==1)throw invalid();
 let total=0;
 const inputs=value.inputs.map((input:unknown,index:number):DirectInput=>{
  if(!own(input)||Object.keys(input).sort().join(',')!=='bytes,extension,index,sha256'||input.index!==index||
   typeof input.extension!=='string'||!(value.kind==='video'?video:value.kind==='images'?images:new Set(['.loareplay'])).has(input.extension)||
   !Number.isSafeInteger(input.bytes)||(input.bytes as number)<1||
   typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256))throw invalid();
  if((input.bytes as number)>MAX_DIRECT_INPUT_BYTES)throw new DirectArchiveError(413,'Direct input exceeds the per-file limit.');
  total+=input.bytes as number;if(!Number.isSafeInteger(total)||total>MAX_DIRECT_TOTAL_BYTES)throw new DirectArchiveError(413,'Direct input exceeds the archive limit.');
  return {index,extension:input.extension,bytes:input.bytes as number,sha256:input.sha256};
 });
 if(value.version===2){
  try{return {version:2,kind:value.kind,inputs,selection:validateCorpusInputSelection(value.selection,inputs.length)};}
  catch{throw invalid();}
 }
 return {version:1,kind:value.kind,inputs};
}
function safeChild(parent:string,child:string){const path=relative(parent,child);return !!path&&!isAbsolute(path)&&path!=='..'&&!path.startsWith(`..${sep}`);}
async function checkedDirectories(path:string){
 const absolute=resolve(path),root=parse(absolute).root;let current=root;
 for(const part of relative(root,absolute).split(sep).filter(Boolean)){
  current=join(current,part);let info;
  try{info=await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
   try{await mkdir(current,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}info=await lstat(current);}
  if(info.isSymbolicLink()||!info.isDirectory())throw new DirectArchiveError(500,'Direct input staging unavailable.');
 }
}

/** Receives immutable bytes in bounded network chunks; no client-supplied path
 * reaches the filesystem. A case is committed only after all ordered files
 * match their declared hashes and the complete request has ended. */
export async function archiveDirectInput(request:IncomingMessage,root:string,readReplay:ReplayReader,externalSignal?:AbortSignal){
 const corpus=resolve(root),parent=dirname(corpus),incoming=join(parent,'.loacard-direct-incoming');
 if(!safeChild(parent,incoming)||basename(corpus)==='.loacard-direct-incoming')throw new DirectArchiveError(500,'Invalid staging location.');
 const declared=request.headers['content-length'];
 if(declared!==undefined&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))))throw invalid();
 if(declared!==undefined&&Number(declared)>MAX_DIRECT_TOTAL_BYTES+MAX_DIRECT_HEADER_BYTES+12)throw new DirectArchiveError(413,'Direct input exceeds the archive limit.');
 if(request.aborted||request.destroyed)throw invalid();
 if(active.has(corpus))throw new DirectArchiveError(409,'Direct input archive is busy.');
 active.add(corpus);
 let stage='',stageCreated=false,handle:FileHandle|undefined,timedOut=false;
 const files:string[]=[],prefix=Buffer.alloc(12);let prefixBytes=0,headerBuffer:Buffer|undefined,headerBytes=0,header:Header|undefined;
 let currentIndex=0,currentBytes=0,received=0,currentHash= createHash('sha256');
 const timeout=new AbortController(),signal=externalSignal?AbortSignal.any([externalSignal,timeout.signal]):timeout.signal;
 const timer=setTimeout(()=>{timedOut=true;timeout.abort();if(!request.complete)request.destroy(new Error('Direct input timed out.'));},timeoutMs);
 const openCurrent=async()=>{
  if(!header||currentIndex>=header.inputs.length)return;
  const name=`${String(currentIndex+1).padStart(4,'0')}${header.inputs[currentIndex].extension}`;
  const file=join(stage,name);if(!safeChild(stage,file))throw invalid();
  handle=await open(file,'wx',0o600);files.push(file);currentBytes=0;currentHash=createHash('sha256');
 };
 try {
  signal.throwIfAborted();await checkedDirectories(parent);await checkedDirectories(incoming);
  stage=join(incoming,randomUUID());if(!safeChild(incoming,stage))throw invalid();await mkdir(stage,{mode:0o700});stageCreated=true;
  // On validation failure the HTTP handler decides whether to drain a small
  // body or close the response. Do not destroy the socket by leaving the
  // iterator early, otherwise callers may never receive the rejection.
  for await(const data of request.iterator({destroyOnReturn:false})){
   signal.throwIfAborted();const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);received+=chunk.length;
   if(received>MAX_DIRECT_TOTAL_BYTES+MAX_DIRECT_HEADER_BYTES+12)throw new DirectArchiveError(413,'Direct input exceeds the archive limit.');
   let at=0;
   while(at<chunk.length){
    signal.throwIfAborted();
    if(prefixBytes<12){const n=Math.min(12-prefixBytes,chunk.length-at);chunk.copy(prefix,prefixBytes,at,at+n);prefixBytes+=n;at+=n;
     if(prefixBytes===12){if(!prefix.subarray(0,8).equals(MAGIC))throw invalid();const n=prefix.readUInt32LE(8);
      if(n<1||n>MAX_DIRECT_HEADER_BYTES)throw invalid();headerBuffer=Buffer.alloc(n);}continue;}
    if(!header){const n=Math.min(headerBuffer!.length-headerBytes,chunk.length-at);chunk.copy(headerBuffer!,headerBytes,at,at+n);headerBytes+=n;at+=n;
     if(headerBytes===headerBuffer!.length){header=parseHeader(headerBuffer!);const total=header.inputs.reduce((sum,item)=>sum+item.bytes,12+headerBytes);
      if(declared!==undefined&&Number(declared)!==total)throw invalid();await openCurrent();}continue;}
    if(currentIndex>=header.inputs.length||!handle)throw invalid();
    const item=header.inputs[currentIndex],n=Math.min(item.bytes-currentBytes,chunk.length-at),piece=chunk.subarray(at,at+n);
    currentHash.update(piece);let written=0;while(written<n){signal.throwIfAborted();const result=await handle.write(piece,written,n-written);if(!result.bytesWritten)throw Error('Direct input write made no progress.');written+=result.bytesWritten;}
    currentBytes+=n;at+=n;
    if(currentBytes===item.bytes){if(currentHash.digest('hex')!==item.sha256)throw invalid();await handle.sync();await handle.close();handle=undefined;currentIndex++;await openCurrent();}
   }
  }
  signal.throwIfAborted();
  if(!request.complete||request.aborted||!header||currentIndex!==header.inputs.length||handle||declared!==undefined&&received!==Number(declared))throw invalid();
  if(header.kind==='replay'){
   try{await readReplay(await openAsBlob(files[0]),signal);signal.throwIfAborted();}
   catch(error){if(signal.aborted)throw error;if(error instanceof ReplayArchiveError&&error.status===503)throw new DirectArchiveError(503,'Replay parser unavailable.');throw invalid();}
  }
  const result=await addCorpusCase(files,{root:corpus,kind:header.kind,name:header.kind==='video'?'직접 선택한 영상':header.kind==='images'?'직접 선택한 이미지':'직접 선택한 재현 기록',signal,
   expectedInputs:header.inputs.map(({sha256,bytes})=>({sha256,bytes})),...(header.version===2?{selection:header.selection}:{})});
  // Case identity uses kind and ordered content hashes, not filenames or
  // extensions. If an existing case is reused, its stored extension is the
  // actual one the input endpoint will serve and must be reported as such.
  return {created:result.created,caseId:result.manifest.id,kind:result.manifest.kind,
   inputs:result.manifest.inputs.map(({index,extension,bytes,sha256})=>({index,extension,bytes,sha256})),
   ...(result.selection?{selection:result.selection}:{})};
 }catch(error){if(timedOut)throw new DirectArchiveError(408,'Direct input timed out.');throw error;}
 finally{
  clearTimeout(timer);
  try{await handle?.close();for(const file of files)if(safeChild(stage,file))await unlink(file);if(stageCreated&&safeChild(incoming,stage))await rmdir(stage);}
  finally{active.delete(corpus);}
 }
}
