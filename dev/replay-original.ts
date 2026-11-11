import {hashReplayOriginal} from './replay-original-hash';
import {MAX_REPLAY_ORIGINAL_BYTES} from './replay-original-hash-core';

/** Dev-only bounded download. The exact decoder separately checks frame hashes.
 * Blob pieces avoid retaining a second, full-size contiguous ArrayBuffer. */
export async function loadReplayOriginal(url:string,bytes:number,signal:AbortSignal,request:typeof fetch=fetch){
 if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>MAX_REPLAY_ORIGINAL_BYTES)throw Error('Invalid replay byte length');
 const bounded=AbortSignal.any([signal,AbortSignal.timeout(120_000)]);bounded.throwIfAborted();
 const response=await request(url,{signal:bounded,cache:'no-store'});
 if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});throw Error('Replay download failed');}
 const reader=response.body.getReader(),parts:Blob[]=[];let total=0,done=false;
 try{
  while(true){bounded.throwIfAborted();const next=await reader.read();bounded.throwIfAborted();
   if(next.done){done=true;break;}
   total+=next.value.byteLength;if(total>bytes)throw Error('Replay exceeds declared byte length');
   parts.push(new Blob([next.value]));
  }
  if(total!==bytes)throw Error('Replay byte length mismatch');
  return new Blob(parts,{type:'application/octet-stream'});
 }finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Verify the exact downloaded Blob against its selected corpus manifest before
 * parsing any metadata or sending pixels to the scanner. */
export async function loadVerifiedReplayOriginal(url:string,bytes:number,expectedSha256:unknown,signal:AbortSignal,
 options:{request?:typeof fetch;hash?:(blob:Blob,signal:AbortSignal,onProgress?:(bytes:number,total:number)=>void)=>Promise<string>;
  onProgress?:(bytes:number,total:number)=>void}={}){
 if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256))throw Error('Invalid replay SHA-256');
 signal.throwIfAborted();
 const blob=await loadReplayOriginal(url,bytes,signal,options.request);
 signal.throwIfAborted();
 const digest=await (options.hash??((input,s,onProgress)=>hashReplayOriginal(input,s,{onProgress})))(blob,signal,options.onProgress);
 signal.throwIfAborted();
 if(digest!==expectedSha256)throw Error('재현 파일의 SHA-256이 등록된 원본과 일치하지 않습니다.');
 return blob;
}
