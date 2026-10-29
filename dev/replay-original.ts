/** Dev-only bounded download. Byte length is checked here; whole-file SHA must
 * be checked by corpus verify. The exact decoder separately checks frame hashes.
 * Blob pieces avoid retaining a second, full-size contiguous ArrayBuffer. */
export async function loadReplayOriginal(url:string,bytes:number,signal:AbortSignal,request:typeof fetch=fetch){
 if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>1296*1024*1024)throw Error('Invalid replay byte length');
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
