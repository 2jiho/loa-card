import {parseCardCropSource,type CardCropSource} from './card-crop-proof-core';
export const NAME_LABEL_PROOF_LIMITS=Object.freeze({fileBytes:2*1024*1024,inputs:8,metadataBytes:8192,resultBytes:256*1024,decodeMs:5000,runMs:360000});
export interface NameLabelProofInput {
  key:string;provider:'canvas-control'|'native-yuv'|'normal-acquisition';processingFrame:number;slot:number;
  image:string;pngSha256:string;rgbaSha256:string;width:128;height:36;
  /** Normal acquisition keeps the actual source tuple and exact parent run.
   * Legacy provider-only inputs cannot invent this missing provenance. */
  runSha256?:string;source?:CardCropSource;
}
export interface NameLabelRunReference {sha256:string;provider:NameLabelProofInput['provider'];runFile?:string;sourceDigest?:string}
export interface NameLabelProofData {
  version:1;sourceDigest:string;runReferences:NameLabelRunReference[];inputs:NameLabelProofInput[];
}
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const small=(value:Record<string,unknown>)=>new TextEncoder().encode(JSON.stringify(value)).length<=NAME_LABEL_PROOF_LIMITS.metadataBytes;
const fields=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
/** Only private, bounded data is accepted; no URL supplied in this file is fetched. */
export function parseNameLabelProofData(text:string):NameLabelProofData {
  if(new TextEncoder().encode(text).byteLength>NAME_LABEL_PROOF_LIMITS.fileBytes)throw Error('Name-label input exceeds 2 MiB.');
  const value:unknown=JSON.parse(text);
  if(!plain(value)||!fields(value,['version','sourceDigest','runReferences','inputs'])||value.version!==1||!digest(value.sourceDigest)||!Array.isArray(value.runReferences)||value.runReferences.length<1||value.runReferences.length>8||!Array.isArray(value.inputs)||value.inputs.length<1||value.inputs.length>NAME_LABEL_PROOF_LIMITS.inputs)throw Error('Invalid name-label input manifest.');
  const runReferences=value.runReferences.map((reference:unknown):NameLabelRunReference=>{
    if(!plain(reference)||!fields(reference,['sha256','provider','runFile','sourceDigest'])||!digest(reference.sha256)||!small(reference)
      ||reference.provider!=='canvas-control'&&reference.provider!=='native-yuv'&&reference.provider!=='normal-acquisition'
      ||reference.runFile!==undefined&&(typeof reference.runFile!=='string'||reference.runFile.length>512)
      ||reference.sourceDigest!==undefined&&(!digest(reference.sourceDigest)||reference.sourceDigest!==value.sourceDigest)
      ||reference.provider==='normal-acquisition'&&reference.sourceDigest!==value.sourceDigest)throw Error('Invalid source run reference.');
    return reference as unknown as NameLabelRunReference;
  });
  const keys=new Set<string>();
  const inputs=value.inputs.map((input:unknown):NameLabelProofInput=>{
    if(!plain(input)||!fields(input,['key','provider','processingFrame','slot','image','pngSha256','rgbaSha256','width','height','runSha256','source'])
      ||typeof input.key!=='string'||!/^[a-zA-Z0-9_.:-]{1,120}$/.test(input.key)||keys.has(input.key)
      ||input.provider!=='canvas-control'&&input.provider!=='native-yuv'&&input.provider!=='normal-acquisition'||!Number.isSafeInteger(input.processingFrame)||Number(input.processingFrame)<1
      ||!Number.isSafeInteger(input.slot)||Number(input.slot)<0||Number(input.slot)>39||input.width!==128||input.height!==36
      ||!digest(input.pngSha256)||!digest(input.rgbaSha256)||typeof input.image!=='string'
      ||!/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.image)||input.image.length<=22
      ||input.image.length>128*1024)throw Error('Invalid, duplicate, or oversized name-label image.');
    let source:CardCropSource|undefined,runSha256:string|undefined;
    if(input.provider==='normal-acquisition'){
      source=parseCardCropSource(input.source);
      if(!digest(input.runSha256)||source.processingFrame!==input.processingFrame||source.slot!==input.slot||
        !runReferences.some(reference=>reference.provider===input.provider&&reference.sha256===input.runSha256))throw Error('Normal label has no exact source/run binding.');
      runSha256=input.runSha256;
    }else if(Object.hasOwn(input,'source')||Object.hasOwn(input,'runSha256'))throw Error('Legacy label cannot invent source provenance.');
    keys.add(input.key);
    return {key:input.key,provider:input.provider as NameLabelProofInput['provider'],processingFrame:Number(input.processingFrame),slot:Number(input.slot),
      image:input.image,pngSha256:input.pngSha256,rgbaSha256:input.rgbaSha256,width:128,height:36,...(source?{source,runSha256}:{})};
  });
  if(inputs.some(input=>!runReferences.some(reference=>reference.provider===input.provider)))throw Error('Name-label provider has no source run reference.');
  return {version:1,sourceDigest:value.sourceDigest,runReferences,inputs};
}
export const NAME_LABEL_VARIANTS=['raw-first','raw-second','raw-full','gray-first','gray-second','gray-full'] as const;
export type NameLabelVariant=typeof NAME_LABEL_VARIANTS[number];
/** Check the IHDR size before asking the browser to allocate a decoded raster.
 * This is a header guard, not PNG CRC/content validation; the decoder does that. */
export function assertNameLabelPngHeader(bytes:Uint8Array){
  if(bytes.length<33||![137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value)
    ||![73,72,68,82].every((value,index)=>bytes[12+index]===value))throw Error('Invalid name-label PNG header.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(8)!==13||view.getUint32(16)!==128||view.getUint32(20)!==36)throw Error('Name-label PNG must declare exactly 128×36.');
}
/** Browser decoding is not natively cancellable. Bound the caller's wait and
 * close a result that arrives after cancellation/deadline instead of leaking it. */
export function decodeNameLabelBitmap(blob:Blob,signal:AbortSignal,options:{decode?:(blob:Blob)=>Promise<ImageBitmap>;deadlineMs?:number}={}):Promise<ImageBitmap>{
  const deadlineMs=options.deadlineMs??NAME_LABEL_PROOF_LIMITS.decodeMs;
  if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>NAME_LABEL_PROOF_LIMITS.decodeMs)return Promise.reject(Error('Invalid PNG decode deadline.'));
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    let settled=false;
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',aborted);};
    const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();reject(error);};
    const aborted=()=>fail(signal.reason);
    const timer=setTimeout(()=>fail(Error('Name-label PNG decode deadline exceeded.')),deadlineMs);
    signal.addEventListener('abort',aborted,{once:true});
    try{Promise.resolve((options.decode??createImageBitmap)(blob)).then(bitmap=>{
      if(settled){try{bitmap.close();}catch{/* The native result is no longer usable. */}return;}
      settled=true;cleanup();resolve(bitmap);
    },fail);}catch(error){fail(error);}
  });
}
/** A new array for one variant. No masks, inversion, enlargement or alpha edits. */
export function nameLabelVariant(source:Uint8ClampedArray,variant:NameLabelVariant){
  if(source.length!==128*36*4||!NAME_LABEL_VARIANTS.includes(variant))throw Error('Invalid initial label raster or variant.');
  const height=variant.endsWith('-full')?36:18,top=variant.endsWith('-second')?18:0;
  const data=source.slice(top*128*4,(top+height)*128*4);
  if(variant.startsWith('gray-'))for(let i=0;i<data.length;i+=4){
    const gray=Math.round(.299*data[i]+.587*data[i+1]+.114*data[i+2]);
    data[i]=data[i+1]=data[i+2]=gray;
  }
  return {width:128,height,data,recipe:{variant,sourceBox:{x:0,y:top,width:128,height},
    grayscale:variant.startsWith('gray-')?'round(.299R+.587G+.114B); alpha preserved':null}};
}
