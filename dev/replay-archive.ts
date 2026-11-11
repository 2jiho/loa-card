import {createHash,randomUUID} from 'node:crypto';
import {openAsBlob} from 'node:fs';
import {lstat,mkdir,open,rmdir,unlink} from 'node:fs/promises';
import type {IncomingMessage} from 'node:http';
import {basename,dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tsImport} from 'tsx/esm/api';
import {addCorpusCase} from '../scripts/scan-corpus-core.mjs';
import {recordedCoverage} from '../src/features/card-scanner/reproduction/reproduction-coverage.ts';
import type {CoverageMetadata} from '../src/features/card-scanner/reproduction/reproduction-coverage.ts';

export type ReplayReader=(blob:Blob,signal:AbortSignal)=>Promise<{metadata:CoverageMetadata}>;
/** Load the same browser parser through the existing development TS loader;
 * its module graph uses Vite's extensionless imports, which native Node alone
 * cannot resolve. This path is only used by the local development server. */
export function replayReaderFromSource(sourceRoot:string):ReplayReader {
 const moduleUrl=pathToFileURL(resolve(sourceRoot,'src/features/card-scanner/reproduction/scan-reproduction.ts')).href;
 return async(blob,signal)=>{
  let module:{openReproduction?:ReplayReader};
  try{module=await tsImport(moduleUrl,import.meta.url) as {openReproduction?:ReplayReader};}
  catch{throw new ReplayArchiveError(503,'Replay parser is unavailable.');}
  if(typeof module.openReproduction!=='function')throw new ReplayArchiveError(503,'Replay parser is unavailable.');
  return module.openReproduction(blob,signal);
 };
}

/** Raw sessions are not replay files. Their parser independently verifies all
 * chunk lengths and hashes before the server archives the envelope. */
export function rawSessionReaderFromSource(sourceRoot:string):ReplayReader {
 const moduleUrl=pathToFileURL(resolve(sourceRoot,'src/features/card-scanner/reproduction/raw-session-archive.ts')).href;
 return async(blob,signal)=>{
  let module:{openRawSessionArchive?:(input:Blob,signal:AbortSignal)=>Promise<unknown>};
  try{module=await tsImport(moduleUrl,import.meta.url) as typeof module;}
  catch{throw new ReplayArchiveError(503,'Raw session parser is unavailable.');}
  if(typeof module.openRawSessionArchive!=='function')throw new ReplayArchiveError(503,'Raw session parser is unavailable.');
  await module.openRawSessionArchive(blob,signal);
  return {metadata:{recordState:'partial'}};
 };
}

// Payloads are streamed to disk; this cap covers a 512 MiB session plus
// bounded metadata and framing. No client paths or filenames are accepted.
export const MAX_REPLAY_ARCHIVE_BYTES=528*1024*1024+64;
export const MAX_RAW_ARCHIVE_BYTES=544*1024*1024+12;
const active=new Set<string>();
const RECEIVE_TIMEOUT_MS=5*60*1000;
export class ReplayArchiveError extends Error {
 readonly status:number;
 constructor(status:number,message:string){super(message);this.status=status;}
}

async function checkedDirectories(path:string,createMissing=false){
 const absolute=resolve(path),root=parse(absolute).root;
 let current=root;
 const parts=relative(root,absolute).split(sep).filter(Boolean);
 for(const part of parts){
  current=join(current,part);
  let info;
  try{info=await lstat(current);}catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT'||!createMissing)throw error;
   try{await mkdir(current,{mode:0o700});}catch(createError){if((createError as NodeJS.ErrnoException).code!=='EEXIST')throw createError;}
   info=await lstat(current);
  }
  if(info.isSymbolicLink()||!info.isDirectory())throw new ReplayArchiveError(500,'Replay staging directory is unavailable.');
 }
}

function safeChild(parent:string,child:string){
 const remainder=relative(parent,child);
 return !!remainder&&!isAbsolute(remainder)&&remainder!=='..'&&!remainder.startsWith(`..${sep}`);
}

/** Owns only a server-generated temporary directory outside the corpus.
 * No persisted pixels are decoded here; openReproduction checks only the
 * container metadata and section lengths. */
export async function archiveReplayRequest(request:IncomingMessage,root:string,readReplay:ReplayReader,externalSignal?:AbortSignal,
 options:{kind?:'replay'|'raw-session'}={}){
 const kind=options.kind??'replay',maximum=kind==='raw-session'?MAX_RAW_ARCHIVE_BYTES:MAX_REPLAY_ARCHIVE_BYTES;
 const corpus=resolve(root),parent=dirname(corpus),incoming=join(parent,'.loacard-replay-incoming');
 if(corpus===incoming||!safeChild(parent,incoming)||basename(corpus)==='.loacard-replay-incoming')throw new ReplayArchiveError(500,'Invalid replay staging location.');
 const declared=request.headers['content-length'];
 if(declared!==undefined&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))))throw new ReplayArchiveError(400,'Invalid replay length.');
 if(declared!==undefined&&Number(declared)>maximum)throw new ReplayArchiveError(413,'Replay exceeds the archive limit.');
 if(request.aborted||request.destroyed)throw new ReplayArchiveError(400,'Replay upload was interrupted.');
 if(active.has(corpus))throw new ReplayArchiveError(409,'Replay archive is busy.');
 active.add(corpus);
 let stage='',file='',stageCreated=false,fileCreated=false,timedOut=false;
 const timeoutController=new AbortController();
 const signal=externalSignal?AbortSignal.any([externalSignal,timeoutController.signal]):timeoutController.signal;
 const timer=setTimeout(()=>{timedOut=true;timeoutController.abort();if(!request.complete)request.destroy(new Error('Replay upload timed out.'));},RECEIVE_TIMEOUT_MS);
 try{
  signal.throwIfAborted();
  await checkedDirectories(parent,true);
  await checkedDirectories(incoming,true);
  stage=join(incoming,randomUUID());
  if(!safeChild(incoming,stage))throw new ReplayArchiveError(500,'Invalid replay staging location.');
  await mkdir(stage,{mode:0o700});stageCreated=true;
  file=join(stage,kind==='raw-session'?'input.loaraw':'input.loareplay');
  if(!safeChild(stage,file))throw new ReplayArchiveError(500,'Invalid replay staging location.');
  const handle=await open(file,'wx',0o600);fileCreated=true;
  const hash=createHash('sha256');let bytes=0;
  try{
   for await(const part of request){
    signal.throwIfAborted();
    const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
    if(bytes+chunk.length>maximum)throw new ReplayArchiveError(413,'Replay exceeds the archive limit.');
    bytes+=chunk.length;hash.update(chunk);
    let offset=0;
    while(offset<chunk.length){signal.throwIfAborted();const written=await handle.write(chunk,offset,chunk.length-offset);if(!written.bytesWritten)throw Error('Replay write made no progress.');offset+=written.bytesWritten;}
   }
   if(!request.complete||request.aborted||declared!==undefined&&bytes!==Number(declared))throw new ReplayArchiveError(400,'Replay upload was interrupted.');
   signal.throwIfAborted();
   await handle.sync();
   signal.throwIfAborted();
  }finally{await handle.close();}
  const digest=hash.digest('hex');
  let coverage:ReturnType<typeof recordedCoverage>;
  try{const replay=await readReplay(await openAsBlob(file),signal);signal.throwIfAborted();coverage=kind==='raw-session'?'partial':recordedCoverage(replay.metadata);}
  catch(error){if(signal.aborted||error instanceof ReplayArchiveError)throw error;throw new ReplayArchiveError(400,'Invalid replay container.');}
  const {created,manifest}=await addCorpusCase([file],{root:corpus,kind,name:kind==='raw-session'?'화면 공유 원시 부분 기록':'화면 공유 재현 기록',signal,
   expectedInputs:[{sha256:digest,bytes}]});
  if(manifest.inputs.length!==1||manifest.inputs[0].sha256!==digest||manifest.inputs[0].bytes!==bytes)
   throw new ReplayArchiveError(500,'Archived replay checksum mismatch.');
  return {created,caseId:manifest.id,input:{sha256:digest,bytes},recordedCoverage:coverage};
 }catch(error){
  if(timedOut)throw new ReplayArchiveError(408,'Replay upload timed out.');
  throw error;
 }finally{
  clearTimeout(timer);
  try{
   if(fileCreated&&safeChild(stage,file))await unlink(file);
   if(stageCreated&&safeChild(incoming,stage))await rmdir(stage);
  }finally{active.delete(corpus);}
 }
}
