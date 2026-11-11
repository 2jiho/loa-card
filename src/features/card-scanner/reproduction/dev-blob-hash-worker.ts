import {hashBlobChunks,hashBlobListChunks} from './dev-blob-hash-core';

// One dedicated Worker per request; the client terminates it on abort.
self.onmessage=async(event:MessageEvent<unknown>)=>{
  try {
    const blob=event.data;
    if(blob&&typeof blob==='object'&&'kind' in blob&&blob.kind==='list'&&'blobs' in blob){
      const list=blob.blobs as readonly Blob[];
      const hashes=await hashBlobListChunks(list,new AbortController().signal);
      self.postMessage({ok:true,kind:'list',hashes,bytes:list.map(part=>part.size)});
      return;
    }
    if(!(blob instanceof Blob))throw Error('해시할 기록이 올바르지 않습니다.');
    const sha256=await hashBlobChunks(blob,new AbortController().signal);
    self.postMessage({ok:true,sha256,bytes:blob.size});
  }catch(error){self.postMessage({ok:false,error:String(error).slice(0,500)});}
};
