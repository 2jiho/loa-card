import {sha256} from '@noble/hashes/sha256';

export const MAX_REPLAY_ORIGINAL_BYTES=1296*1024*1024;
export const REPLAY_HASH_CHUNK_BYTES=1024*1024;

/** Runs in a dedicated worker. Only one 1 MiB slice is materialized at once. */
export async function hashReplayOriginalChunks(blob:Blob,signal:AbortSignal,onProgress?:(bytes:number)=>void):Promise<string>{
 if(!(blob instanceof Blob)||!Number.isSafeInteger(blob.size)||blob.size<=0||blob.size>MAX_REPLAY_ORIGINAL_BYTES)
  throw Error('Invalid replay byte length');
 const hash=sha256.create();
 try{
  for(let offset=0;offset<blob.size;offset+=REPLAY_HASH_CHUNK_BYTES){
   signal.throwIfAborted();
   const end=Math.min(offset+REPLAY_HASH_CHUNK_BYTES,blob.size);
   const chunk=new Uint8Array(await blob.slice(offset,end).arrayBuffer());
   signal.throwIfAborted();
   if(chunk.byteLength!==end-offset)throw Error('Replay hash read incomplete');
   hash.update(chunk);
   if(end===blob.size||end%(8*REPLAY_HASH_CHUNK_BYTES)===0)onProgress?.(end);
  }
  signal.throwIfAborted();
  return Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');
 }finally{hash.destroy();}
}
