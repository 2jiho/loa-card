export const MAX_COMPARISON_SOURCE_BYTES=256*1024*1024;
export interface ComparisonOriginal {bytes:number;type:string;sha256?:string}
const digest=(bytes:ArrayBuffer)=>crypto.subtle.digest('SHA-256',bytes)
 .then(hash=>Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join(''));

/** Source integrity check, outside scanner timing. A bounded Blob survives; the
 * digest's ArrayBuffer is temporary, not a physical process-memory guarantee. */
export async function loadComparisonOriginal(url:string,description:ComparisonOriginal,signal:AbortSignal,request:typeof fetch=fetch){
 if(!Number.isSafeInteger(description.bytes)||description.bytes<=0||description.bytes>MAX_COMPARISON_SOURCE_BYTES||
  typeof description.type!=='string'||description.type.length>128||!description.type.startsWith('video/')||
  description.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(description.sha256))throw Error('입력 비교 원본 메타데이터 오류 또는 256 MiB 한도 초과');
 const bounded=AbortSignal.any([signal,AbortSignal.timeout(60_000)]);bounded.throwIfAborted();
 const response=await request(url,{signal:bounded,cache:'no-store'});
 if(bounded.aborted){await response.body?.cancel().catch(()=>{});bounded.throwIfAborted();}
 if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});throw Error('입력 비교 영상을 읽지 못했습니다.');}
 const reader=response.body.getReader(),chunks:Uint8Array<ArrayBuffer>[]=[];let bytes=0,ended=false;
 try{while(true){bounded.throwIfAborted();const next=await reader.read();bounded.throwIfAborted();if(next.done){ended=true;break;}
  bytes+=next.value.byteLength;if(bytes>description.bytes)throw Error('입력 비교 영상 길이 초과');chunks.push(next.value);}
 }finally{if(!ended)await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(bytes!==description.bytes)throw Error('입력 비교 영상 길이 불일치');
 const blob=new Blob(chunks,{type:description.type}),buffer=await blob.arrayBuffer();bounded.throwIfAborted();
 const sha256=await digest(buffer);bounded.throwIfAborted();
 if(description.sha256&&description.sha256!==sha256)throw Error('입력 비교 원본 SHA-256 불일치');
 return {blob,verified:{sha256,bytes}};
}
