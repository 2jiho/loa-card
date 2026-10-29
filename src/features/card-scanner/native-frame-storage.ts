import {MAX_FRAME_BYTES,pixelHash} from './recording-frame-integrity';
import {convertNativeYuvToRgba,nativeYuvDescriptorJson,planNativeYuvFrame,
  type NativeYuvFrameMetadata} from './native-yuv-recipe';

export interface RgbaStorage {readonly version:1;readonly kind:'rgba8';readonly byteLength:number}
export interface NativeStorage {
  readonly version:1;readonly kind:'native-yuv420';readonly descriptor:NativeYuvFrameMetadata;
  readonly recipeId:string;readonly recipeSha256:string;readonly descriptorSha256:string;
  readonly nativeSha256:string;readonly byteLength:number;
}
export type FrameStorage=RgbaStorage|NativeStorage;

function fail(detail:string):never {throw new Error(`Invalid frame storage: ${detail}`);}
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('plain object required');
  const parsed=value as Record<string,unknown>;
  if(Object.keys(parsed).length!==keys.length||keys.some(key=>!Object.hasOwn(parsed,key)))fail('unexpected or missing property');
  return parsed;
}
function rgbaBytes(width:number,height:number):number {
  const bytes=width*height*4;
  if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||
    !Number.isSafeInteger(bytes)||bytes>MAX_FRAME_BYTES)fail('frame dimensions/byte limit');
  return bytes;
}
function hash(value:unknown):string {
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('SHA-256');
  return value;
}
function owned(value:Uint8Array<ArrayBuffer>,bytes:number):void {
  if(!(value instanceof Uint8Array)||!(value.buffer instanceof ArrayBuffer)||value.byteOffset!==0||
    value.byteLength!==bytes||value.buffer.byteLength!==bytes||
    (value.buffer as ArrayBuffer&{resizable?:boolean}).resizable===true)fail('exclusive whole ArrayBuffer required');
  try{new Uint8Array(value.buffer,0,bytes);}catch{fail('detached ArrayBuffer');}
}
async function textHash(value:string):Promise<string> {return pixelHash(new TextEncoder().encode(value));}

/** Detach and validate exact metadata before retaining a transferred payload.
 * The supported full rectangle implies the one fixed packed plane layout. */
export function parseNativeYuvMetadata(value:unknown):NativeYuvFrameMetadata {
  const data=object(value,['format','codedWidth','codedHeight','displayWidth','displayHeight','visibleRect','rotation','flip','colorSpace']);
  const rect=object(data.visibleRect,['x','y','width','height']);
  const color=object(data.colorSpace,['primaries','transfer','matrix','fullRange']);
  const metadata:NativeYuvFrameMetadata={format:data.format as string|null,codedWidth:data.codedWidth as number,
    codedHeight:data.codedHeight as number,displayWidth:data.displayWidth as number,displayHeight:data.displayHeight as number,
    visibleRect:Object.freeze({x:rect.x as number,y:rect.y as number,width:rect.width as number,height:rect.height as number}),
    rotation:data.rotation as number,flip:data.flip as boolean,
    colorSpace:Object.freeze({primaries:color.primaries as string|null,transfer:color.transfer as string|null,
      matrix:color.matrix as string|null,fullRange:color.fullRange as boolean|null})};
  planNativeYuvFrame(metadata);return Object.freeze(metadata);
}

export function rgbaFrameStorage(width:number,height:number):RgbaStorage {
  return Object.freeze({version:1,kind:'rgba8',byteLength:rgbaBytes(width,height)});
}

/** Schema/profile checks are synchronous. Content, descriptor and recipe hashes
 * are checked against bytes/manifests by restoreFrameStorage before use. */
export function parseFrameStorage(value:unknown,width:number,height:number):FrameStorage {
  const bytes=rgbaBytes(width,height);
  if(!value||typeof value!=='object'||Array.isArray(value))fail('storage descriptor');
  if((value as {kind?:unknown}).kind==='rgba8') {
    const data=object(value,['version','kind','byteLength']);
    if(data.version!==1||data.kind!=='rgba8'||data.byteLength!==bytes)fail('RGBA descriptor');
    return rgbaFrameStorage(width,height);
  }
  const data=object(value,['version','kind','descriptor','recipeId','recipeSha256','descriptorSha256','nativeSha256','byteLength']);
  if(data.version!==1||data.kind!=='native-yuv420')fail('storage version/kind');
  const descriptor=parseNativeYuvMetadata(data.descriptor),plan=planNativeYuvFrame(descriptor);
  if(plan.width!==width||plan.height!==height||data.byteLength!==plan.nativeByteLength||data.recipeId!==plan.recipe.id)
    fail('native dimensions/packing/recipe');
  return Object.freeze({version:1,kind:'native-yuv420',descriptor,recipeId:plan.recipe.id,
    recipeSha256:hash(data.recipeSha256),descriptorSha256:hash(data.descriptorSha256),
    nativeSha256:hash(data.nativeSha256),byteLength:plan.nativeByteLength});
}

export function frameStoredBytes(storage:FrameStorage|undefined,width:number,height:number):number {
  return storage===undefined?rgbaBytes(width,height):parseFrameStorage(storage,width,height).byteLength;
}

/** Work bound counts reconstructed native and generated RGBA simultaneously.
 * Codec scratch, predecessor chains and compression allocations are separate. */
export function frameDecodeWorkBytes(storage:FrameStorage|undefined,width:number,height:number):number {
  const bytes=rgbaBytes(width,height),parsed=storage===undefined?undefined:parseFrameStorage(storage,width,height);
  return parsed?.kind==='native-yuv420'?parsed.byteLength+bytes:bytes;
}

/** Delta dependencies change on representation/profile/layout/recipe, never just
 * because per-frame native content changed. Legacy RGBA is a separate domain. */
export function frameStorageSignature(storage:FrameStorage|undefined,width:number,height:number):string {
  rgbaBytes(width,height);
  if(storage===undefined)return JSON.stringify(['legacy-rgba8',width,height]);
  const parsed=parseFrameStorage(storage,width,height);
  if(parsed.kind==='rgba8')return JSON.stringify(['rgba8-v1',width,height]);
  const plan=planNativeYuvFrame(parsed.descriptor);
  return JSON.stringify(['native-yuv420-v1',nativeYuvDescriptorJson(parsed.descriptor,plan.layout)]);
}

/** Caller transfers exclusive ownership before this call and must not mutate or
 * transfer native until the returned promise and its writer handoff settle.
 * The helper retains no buffer; generated pixels have an independent owner. */
export async function prepareNativeStorage(metadata:NativeYuvFrameMetadata,native:Uint8Array<ArrayBuffer>):
Promise<{storage:NativeStorage;pixels:Uint8Array<ArrayBuffer>;rgbaHash:string}> {
  const descriptor=parseNativeYuvMetadata(metadata),plan=planNativeYuvFrame(descriptor);
  owned(native,plan.nativeByteLength);
  const descriptorHash=textHash(nativeYuvDescriptorJson(descriptor,plan.layout)),recipeHash=textHash(JSON.stringify(plan.recipe));
  // Digest snapshots and conversion start before any await; no scratch is reused.
  const nativeHash=pixelHash(native),pixels=convertNativeYuvToRgba(descriptor,native,plan.layout).rgba;
  const rgbaHashPromise=pixelHash(pixels);
  const [descriptorSha256,recipeSha256,nativeSha256,rgbaHash]=await Promise.all([descriptorHash,recipeHash,nativeHash,rgbaHashPromise]);
  const storage:NativeStorage=Object.freeze({version:1,kind:'native-yuv420',descriptor,recipeId:plan.recipe.id,
    recipeSha256,descriptorSha256,nativeSha256,byteLength:plan.nativeByteLength});
  return {storage,pixels,rgbaHash};
}

/** Restore one owned payload to the exact fixed-recipe RGBA authority. Unknown
 * profiles/hash mismatches throw; fallback must be explicit at capture time. */
export async function restoreFrameStorage(storage:FrameStorage|undefined,width:number,height:number,
  stored:Uint8Array<ArrayBuffer>,expectedRgbaHash:string):Promise<Uint8Array<ArrayBuffer>> {
  const bytes=rgbaBytes(width,height),expected=hash(expectedRgbaHash);
  const parsed=storage===undefined?undefined:parseFrameStorage(storage,width,height);
  owned(stored,parsed?.byteLength??bytes);
  if(!parsed||parsed.kind==='rgba8') {
    if(await pixelHash(stored)!==expected)fail('RGBA hash mismatch');return stored;
  }
  const plan=planNativeYuvFrame(parsed.descriptor);
  const [descriptorSha,recipeSha,nativeSha]=await Promise.all([
    textHash(nativeYuvDescriptorJson(parsed.descriptor,plan.layout)),textHash(JSON.stringify(plan.recipe)),pixelHash(stored)]);
  if(descriptorSha!==parsed.descriptorSha256||recipeSha!==parsed.recipeSha256||nativeSha!==parsed.nativeSha256)
    fail('native/descriptor/recipe hash mismatch');
  const pixels=convertNativeYuvToRgba(parsed.descriptor,stored,plan.layout).rgba;
  if(await pixelHash(pixels)!==expected)fail('generated RGBA hash mismatch');
  return pixels;
}
