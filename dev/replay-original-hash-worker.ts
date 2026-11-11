import {hashReplayOriginalChunks} from './replay-original-hash-core';

// One worker is created for one immutable Blob. Cancellation terminates it.
self.onmessage=async(event:MessageEvent<unknown>)=>{
 try{
  const blob=event.data;
  if(!(blob instanceof Blob))throw Error('Invalid replay');
  const digest=await hashReplayOriginalChunks(blob,new AbortController().signal,
   bytes=>self.postMessage({kind:'progress',bytes}));
  self.postMessage({kind:'done',bytes:blob.size,sha256:digest});
 }catch{self.postMessage({kind:'error'});}
};
