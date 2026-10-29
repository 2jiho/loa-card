import {fastCompress} from './exact-recording-codec';

export type RecordingCompressionEngine='wasm-lz4'|'js-lz4';
export interface RecordingCompression {
 readonly engine:RecordingCompressionEngine;
 compress(data:Uint8Array<ArrayBuffer>):Uint8Array<ArrayBuffer>;
}
interface WasmCompressionModule {compress(data:Uint8Array):Uint8Array}
type CompressionLoader=()=>Promise<WasmCompressionModule>;

/** Rust's size-prepended LZ4 block uses the existing recording wire format after
 * replacing its four-byte prefix with our compression flag and size prefix.
 * Initial load failure may fall back; a running encoder failure must propagate
 * so the archive is marked partial rather than silently accepting bad bytes. */
function adapt(compress:WasmCompressionModule['compress']):RecordingCompression['compress'] {
 return data=>{
  const encoded=compress(data);
  if(!(encoded instanceof Uint8Array)||encoded.length<5||
    new DataView(encoded.buffer,encoded.byteOffset,encoded.byteLength).getUint32(0,true)!==data.length)
   throw Error('WASM LZ4 출력 길이 오류');
  const compressed=encoded.length-4<data.length,result=new Uint8Array(5+(compressed?encoded.length-4:data.length));
  result[0]=compressed?1:0;new DataView(result.buffer).setUint32(1,data.length,true);
  result.set(compressed?encoded.subarray(4):data,5);return result;
 };
}

/** Called once during the recording Worker's initialization, before ready. */
export async function createRecordingCompression(load:CompressionLoader=()=>import('lz4-wasm')):Promise<RecordingCompression> {
 try{
  const module=await load();
  if(typeof module?.compress!=='function')throw Error('WASM LZ4 압축기를 사용할 수 없습니다.');
  const compress=adapt(module.compress);
  // The empty block checks instantiation and prefix handling without retaining
  // a full-size warmup raster or delaying the first screen capture.
  compress(new Uint8Array());
  return {engine:'wasm-lz4',compress};
 }catch{return {engine:'js-lz4',compress:fastCompress};}
}
