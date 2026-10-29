import {MAX_FRAME_BYTES,pixelHash} from './exact-recording-codec';

export const MAX_ENCODED_PIXEL_RESIDUAL_EDITS=4096;
export interface EncodedPixelEdit {readonly offset:number;readonly value:number}
export interface EncodedPixelResidual {
 readonly version:1;
 readonly bytes:number;
 readonly baseSha256:string;
 readonly resultSha256:string;
 readonly edits:readonly EncodedPixelEdit[];
}

const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function rgbaBytes(pixels:Uint8Array<ArrayBuffer>) {
 if(!(pixels instanceof Uint8Array)||!(pixels.buffer instanceof ArrayBuffer)||
  !pixels.byteLength||pixels.byteLength%4||pixels.byteLength>MAX_FRAME_BYTES)throw Error('잔차 RGBA 크기 오류');
 return pixels.byteLength;
}
function immutableResidual(bytes:number,baseSha256:string,resultSha256:string,edits:EncodedPixelEdit[]):EncodedPixelResidual {
 return Object.freeze({version:1 as const,bytes,baseSha256,resultSha256,
  edits:Object.freeze(edits.map(edit=>Object.freeze({...edit})))});
}

/** Both RGBA views are borrowed and must remain unchanged until this resolves.
 * A null result requests raw storage: it is not an empty/equal pixel result.
 * Only bounded byte edits are retained; no full pixel buffer is cloned. */
export async function createEncodedPixelResidual(baseline:Uint8Array<ArrayBuffer>,actual:Uint8Array<ArrayBuffer>,maxChanges=MAX_ENCODED_PIXEL_RESIDUAL_EDITS):Promise<EncodedPixelResidual|null> {
 const bytes=rgbaBytes(baseline);
 if(rgbaBytes(actual)!==bytes)throw Error('잔차 RGBA 크기 불일치');
 if(!integer(maxChanges)||maxChanges<0||maxChanges>MAX_ENCODED_PIXEL_RESIDUAL_EDITS)throw Error('잔차 변경 상한 오류');
 const edits:EncodedPixelEdit[]=[];
 for(let offset=0;offset<bytes;offset++){
  if(baseline[offset]===actual[offset])continue;
  if(edits.length===maxChanges)return null;
  edits.push({offset,value:actual[offset]});
 }
 const baseSha256=await pixelHash(baseline),resultSha256=edits.length?await pixelHash(actual):baseSha256;
 return immutableResidual(bytes,baseSha256,resultSha256,edits);
}

/** Snapshot and validate the complete small patch before awaiting or writing.
 * Hashes are declarations here; restoreEncodedPixels verifies their bytes. */
function parseResidual(value:unknown,bytes:number):EncodedPixelResidual {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('잔차 형식 오류');
 const patch=value as Record<string,unknown>;
 const {version,bytes:patchBytes,baseSha256,resultSha256,edits:values}=patch;
 const count=Array.isArray(values)?values.length:NaN;
 if(version!==1||!integer(patchBytes)||patchBytes!==bytes||!sha(baseSha256)||!sha(resultSha256)||
  !Array.isArray(values)||!integer(count)||count<0||count>MAX_ENCODED_PIXEL_RESIDUAL_EDITS)throw Error('잔차 형식 오류');
 if(!count&&baseSha256!==resultSha256)throw Error('빈 잔차 해시 불일치');
 const edits:EncodedPixelEdit[]=[];let last=-1;
 // Indexed reads honor the checked cardinality, not an overridable iterator.
 for(let index=0;index<count;index++){
  const value=values[index];
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('잔차 변경 형식 오류');
  const {offset,value:replacement}=value as Record<string,unknown>;
  if(!integer(offset)||offset<=last||offset>=bytes||!integer(replacement)||replacement<0||replacement>255)throw Error('잔차 변경 위치 또는 값 오류');
  last=offset;edits.push({offset,value:replacement});
 }
 return immutableResidual(bytes,baseSha256,resultSha256,edits);
}

/** Takes exclusive ownership of baseline while pending and returns the same
 * view only after both full SHA-256 checks succeed. The caller must not expose
 * it while pending or reuse it after failure: a result-hash failure can leave
 * this owned buffer patched. Invalid metadata/base SHA never mutates pixels. */
export async function restoreEncodedPixels(ownedBaseline:Uint8Array<ArrayBuffer>,residual:unknown):Promise<Uint8Array<ArrayBuffer>> {
 const bytes=rgbaBytes(ownedBaseline),patch=parseResidual(residual,bytes);
 if(await pixelHash(ownedBaseline)!==patch.baseSha256)throw Error('잔차 기준 픽셀 SHA 불일치');
 // Validate every edit against the verified baseline before applying any.
 for(const edit of patch.edits)if(ownedBaseline[edit.offset]===edit.value)throw Error('잔차에 변경 없는 바이트가 있습니다.');
 for(const edit of patch.edits)ownedBaseline[edit.offset]=edit.value;
 if(patch.edits.length&&await pixelHash(ownedBaseline)!==patch.resultSha256)throw Error('잔차 결과 픽셀 SHA 불일치');
 return ownedBaseline;
}
