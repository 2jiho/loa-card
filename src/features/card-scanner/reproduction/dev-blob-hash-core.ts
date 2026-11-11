import {sha256} from '@noble/hashes/sha256';
import {DEV_HASH_CHUNK_BYTES,MAX_DEV_HASH_CHUNK_BYTES,MAX_DEV_REPLAY_BYTES,MAX_DEV_HASH_BLOBS,MAX_DEV_HASH_LIST_BYTES} from './dev-blob-hash-limits';

/** Validate before starting a worker or reading any chunk. */
export function validateHashBlobList(input:unknown):asserts input is readonly Blob[] {
  if(!Array.isArray(input)||input.length>MAX_DEV_HASH_BLOBS)throw Error('해시 청크 목록이 올바르지 않습니다.');
  let total=0;
  for(const blob of input){
    if(!(blob instanceof Blob)||!Number.isSafeInteger(blob.size)||blob.size<1||blob.size>MAX_DEV_HASH_CHUNK_BYTES)
      throw Error('해시 청크 크기가 올바르지 않습니다.');
    total+=blob.size;
    if(!Number.isSafeInteger(total)||total>MAX_DEV_HASH_LIST_BYTES)throw Error('해시 청크 합계가 한도를 초과했습니다.');
  }
}

/** Called inside a dedicated worker; neither the full session nor more than
 * one 1 MiB input slice is materialized during sequential hashing. */
export async function hashBlobListChunks(blobs:readonly Blob[],signal:AbortSignal):Promise<readonly string[]> {
  validateHashBlobList(blobs);signal.throwIfAborted();
  const digests:string[]=[];
  for(const blob of blobs){signal.throwIfAborted();digests.push(await hashBlobChunks(blob,signal));}
  signal.throwIfAborted();return digests;
}

/** Reads at most one bounded Blob slice at a time. Intended to run inside a
 * dedicated Worker; this is a logical buffer bound, not a browser RSS bound. */
export async function hashBlobChunks(blob:Blob,signal:AbortSignal,chunkBytes=DEV_HASH_CHUNK_BYTES):Promise<string> {
  if(!(blob instanceof Blob)||!Number.isSafeInteger(blob.size)||blob.size>MAX_DEV_REPLAY_BYTES)
    throw Error('해시 입력 크기가 올바르지 않습니다.');
  if(!Number.isSafeInteger(chunkBytes)||chunkBytes<1||chunkBytes>MAX_DEV_HASH_CHUNK_BYTES)
    throw Error('해시 청크 크기가 올바르지 않습니다.');
  signal.throwIfAborted();
  const hash=sha256.create();
  try {
    for(let offset=0;offset<blob.size;offset+=chunkBytes){
      signal.throwIfAborted();
      const bytes=new Uint8Array(await blob.slice(offset,Math.min(blob.size,offset+chunkBytes)).arrayBuffer());
      signal.throwIfAborted();
      hash.update(bytes);
    }
    signal.throwIfAborted();
    return Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');
  }finally{hash.destroy();}
}
