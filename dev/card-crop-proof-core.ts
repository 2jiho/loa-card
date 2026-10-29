/** Private diagnostic input only. None of these references is fetched as a URL. */
export const CARD_CROP_PROOF_LIMITS=Object.freeze({
  fileBytes:2*1024*1024,inputs:8,pngBytes:128*1024,metadataBytes:8192,
  resultBytes:512*1024,fetchMs:10000,decodeMs:5000,prepareMs:120000,
  cardMs:3000,disposeMs:5000,runMs:360000,
});
export interface CardCropRunReference {id:string;sha256:string;sourceDigest:string;runFile?:string}
export interface CardCropSource {
  sessionId:string;observationId:string;sourceFrameId:number|null;acquisitionFrameId:number;
  processingFrame:number;captureOrder:number;captureTime:number;phase:'input'|'recovery';slot:number;
}
export interface CardCropInput {
  key:string;runReferenceId:string;source:CardCropSource;
  capture:{stable:boolean|null;borderAlignment:number|null;intact:boolean|null;complete:boolean|null;
    provenance:'recorded'|'recomputed-acquisition'|'unknown'};
  width:140;height:210;image:string;pngSha256:string;rgbaSha256:string;
  /** Unverified diagnostic annotation. Never a recognizer argument or catalog filter. */
  candidate?:{id?:string;name?:string};
}
export interface CardCropProofData {version:1;sourceDigest:string;runReferences:CardCropRunReference[];inputs:CardCropInput[]}
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
function record(value:unknown,allowed:readonly string[],required:readonly string[]=allowed):Record<string,unknown>{
  if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw Error('Unexpected or missing crop proof property.');
  return value;
}
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=160
  &&!Array.from(value).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127);
const integer=(value:unknown,min=0):value is number=>Number.isSafeInteger(value)&&Number(value)>=min;
const small=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=CARD_CROP_PROOF_LIMITS.metadataBytes;
export function parseCardCropSource(value:unknown):CardCropSource {
  const source=record(value,['sessionId','observationId','sourceFrameId','acquisitionFrameId','processingFrame','captureOrder','captureTime','phase','slot']);
  if(!identifier(source.sessionId)||!identifier(source.observationId)||source.sourceFrameId!==null&&!integer(source.sourceFrameId,1)
    ||!integer(source.acquisitionFrameId)||!integer(source.processingFrame,1)||!integer(source.captureOrder)
    ||typeof source.captureTime!=='number'||!Number.isFinite(source.captureTime)||source.captureTime<0
    ||source.phase!=='input'&&source.phase!=='recovery'||!integer(source.slot)||source.slot>39||!small(source))throw Error('Invalid crop source tuple.');
  return source as unknown as CardCropSource;
}
/** The caller receives ordered, exactly bound references, never human truth. */
export function parseCardCropProofData(text:string):CardCropProofData {
  if(new TextEncoder().encode(text).byteLength>CARD_CROP_PROOF_LIMITS.fileBytes)throw Error('Card crop input exceeds 2 MiB.');
  const value=record(JSON.parse(text),['version','sourceDigest','runReferences','inputs']);
  if(value.version!==1||!digest(value.sourceDigest)||!Array.isArray(value.runReferences)||value.runReferences.length<1||value.runReferences.length>8
    ||!Array.isArray(value.inputs)||value.inputs.length<1||value.inputs.length>CARD_CROP_PROOF_LIMITS.inputs)throw Error('Invalid card crop manifest.');
  const references=new Map<string,string>();
  const runReferences=value.runReferences.map((item:unknown):CardCropRunReference=>{
    const reference=record(item,['id','sha256','sourceDigest','runFile'],['id','sha256','sourceDigest']);
    if(!identifier(reference.id)||references.has(reference.id)||!digest(reference.sha256)||reference.sourceDigest!==value.sourceDigest
      ||reference.runFile!==undefined&&(typeof reference.runFile!=='string'||reference.runFile.length>512)||!small(reference))throw Error('Invalid or duplicate crop run reference.');
    references.set(reference.id,reference.sha256);return reference as unknown as CardCropRunReference;
  });
  const keys=new Set<string>(),observations=new Set<string>();
  const inputs=value.inputs.map((item:unknown):CardCropInput=>{
    const input=record(item,['key','runReferenceId','source','capture','width','height','image','pngSha256','rgbaSha256','candidate'],
      ['key','runReferenceId','source','capture','width','height','image','pngSha256','rgbaSha256']);
    if(!identifier(input.key)||keys.has(input.key)||!identifier(input.runReferenceId)||!references.has(input.runReferenceId)
      ||input.width!==140||input.height!==210||!digest(input.pngSha256)||!digest(input.rgbaSha256))throw Error('Invalid, duplicate or unbound card crop.');
    const source=parseCardCropSource(input.source),capture=record(input.capture,['stable','borderAlignment','intact','complete','provenance']);
    if([capture.stable,capture.intact,capture.complete].some(flag=>flag!==null&&typeof flag!=='boolean')
      ||capture.borderAlignment!==null&&(typeof capture.borderAlignment!=='number'||!Number.isFinite(capture.borderAlignment)||capture.borderAlignment<0||capture.borderAlignment>1)
      ||typeof capture.provenance!=='string'||!['recorded','recomputed-acquisition','unknown'].includes(capture.provenance)
      ||capture.provenance==='unknown'&&[capture.stable,capture.intact,capture.complete,capture.borderAlignment].some(field=>field!==null))throw Error('Invalid recorded capture metadata.');
    const observation=JSON.stringify([references.get(input.runReferenceId),source.sessionId,source.observationId]);
    if(observations.has(observation))throw Error('Duplicate crop source observation.');
    let candidate:CardCropInput['candidate'];
    if(input.candidate!==undefined){
      const annotation=record(input.candidate,['id','name'],[]);
      if(!Object.keys(annotation).length||annotation.id!==undefined&&!identifier(annotation.id)||annotation.name!==undefined&&!identifier(annotation.name)||!small(annotation))throw Error('Invalid diagnostic candidate annotation.');
      candidate=annotation as CardCropInput['candidate'];
    }
    // Validate decoded byte bounds and IHDR now, before any native decoder allocation.
    const png=cardCropPngBytes(input.image);assertCardCropPngHeader(png);
    keys.add(input.key);observations.add(observation);
    return {key:input.key,runReferenceId:input.runReferenceId,source,capture:capture as unknown as CardCropInput['capture'],
      width:140,height:210,image:input.image as string,pngSha256:input.pngSha256,rgbaSha256:input.rgbaSha256,...(candidate?{candidate}:{})};
  });
  return {version:1,sourceDigest:value.sourceDigest,runReferences,inputs};
}
export function cardCropPngBytes(image:unknown):Uint8Array<ArrayBuffer>{
  const prefix='data:image/png;base64,';
  if(typeof image!=='string'||!image.startsWith(prefix))throw Error('An embedded PNG is required.');
  const payload=image.slice(prefix.length);
  if(!payload.length||payload.length%4||payload.length>4*Math.ceil(CARD_CROP_PROOF_LIMITS.pngBytes/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(payload))throw Error('Invalid or oversized embedded PNG.');
  const binary=atob(payload);
  if(binary.length>CARD_CROP_PROOF_LIMITS.pngBytes||btoa(binary)!==payload)throw Error('Invalid or oversized PNG bytes.');
  const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;
}
/** Header/size guard only. Browser decode and SHA checks remain necessary. */
export function assertCardCropPngHeader(bytes:Uint8Array){
  if(bytes.length<33||bytes.length>CARD_CROP_PROOF_LIMITS.pngBytes||![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)
    ||![73,72,68,82].every((v,i)=>bytes[12+i]===v))throw Error('Invalid card PNG header.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(8)!==13||view.getUint32(16)!==140||view.getUint32(20)!==210)throw Error('Card PNG must declare exactly 140×210.');
}
export async function sha256CardCropBytes(bytes:Uint8Array<ArrayBuffer>|Uint8ClampedArray<ArrayBuffer>):Promise<string>{
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function verifyCardCropPng(input:Pick<CardCropInput,'image'|'pngSha256'>){
  const bytes=cardCropPngBytes(input.image);assertCardCropPngHeader(bytes);
  const sha256=await sha256CardCropBytes(bytes);
  if(sha256!==input.pngSha256)throw Error('Card PNG SHA-256 mismatch.');
  return {bytes,sha256};
}
export async function measureCardCropRgba(pixels:Uint8ClampedArray<ArrayBuffer>,expected:string){
  if(pixels.length!==140*210*4||!digest(expected))throw Error('Invalid decoded card raster.');
  const sha256=await sha256CardCropBytes(pixels);
  return {sha256,verified:sha256===expected};
}
export async function verifyCardCropRgba(pixels:Uint8ClampedArray<ArrayBuffer>,expected:string){
  const evidence=await measureCardCropRgba(pixels,expected);
  if(!evidence.verified)throw Error('Decoded card RGBA SHA-256 mismatch.');return evidence.sha256;
}
/** Native decode cannot be cancelled; close late results after abort/deadline. */
export function decodeCardCropBitmap(blob:Blob,signal:AbortSignal,options:{decode?:(blob:Blob)=>Promise<ImageBitmap>;deadlineMs?:number}={}):Promise<ImageBitmap>{
  const deadlineMs=options.deadlineMs??CARD_CROP_PROOF_LIMITS.decodeMs;
  if(!integer(deadlineMs,1)||deadlineMs>CARD_CROP_PROOF_LIMITS.decodeMs)return Promise.reject(Error('Invalid crop PNG decode deadline.'));
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    let settled=false;
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',aborted);};
    const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();reject(error);};
    const aborted=()=>fail(signal.reason),timer=setTimeout(()=>fail(Error('Card PNG decode deadline exceeded.')),deadlineMs);
    signal.addEventListener('abort',aborted,{once:true});
    try{Promise.resolve((options.decode??createImageBitmap)(blob)).then(bitmap=>{
      if(settled){try{bitmap.close();}catch{/* Late native output has no consumer. */}return;}
      settled=true;cleanup();resolve(bitmap);
    },fail);}catch(error){fail(error);}
  });
}
