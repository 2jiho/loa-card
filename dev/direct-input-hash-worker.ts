import {sha256} from '@noble/hashes/sha256';

const MAX_FILE_BYTES=1024*1024*1024;
const CHUNK_BYTES=1024*1024;
let running=false;

// The client terminates this dedicated worker on cancellation. Each message
// retains one immutable Blob and materializes at most one 1 MiB slice.
self.onmessage=async(event:MessageEvent<unknown>)=>{
  const value=event.data;
  if(running||!value||typeof value!=='object'||Array.isArray(value)){
    self.postMessage({kind:'error'});return;
  }
  const item=value as {index?:unknown;blob?:unknown};
  if(!Number.isSafeInteger(item.index)||(item.index as number)<0||!(item.blob instanceof Blob)||
    !Number.isSafeInteger(item.blob.size)||item.blob.size<1||item.blob.size>MAX_FILE_BYTES){
    self.postMessage({kind:'error'});return;
  }
  running=true;const index=item.index as number,blob=item.blob,hash=sha256.create();let lastProgress=0;
  try{
    for(let offset=0;offset<blob.size;offset+=CHUNK_BYTES){
      const end=Math.min(blob.size,offset+CHUNK_BYTES);
      const bytes=new Uint8Array(await blob.slice(offset,end).arrayBuffer());
      if(bytes.length!==end-offset)throw Error('입력 파일을 완전히 읽지 못했습니다.');
      hash.update(bytes);
      if(end===blob.size||end-lastProgress>=8*CHUNK_BYTES){
        lastProgress=end;self.postMessage({kind:'progress',index,bytes:end});
      }
    }
    const digest=Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');
    self.postMessage({kind:'done',index,bytes:blob.size,sha256:digest});
  }catch{self.postMessage({kind:'error'});}
  finally{hash.destroy();running=false;}
};
