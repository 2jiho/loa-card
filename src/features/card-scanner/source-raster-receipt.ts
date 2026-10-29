import {MAX_FRAME_BYTES} from './recording-frame-integrity';

export interface PreparedRasterBinding {readonly sourceFrameId:number;readonly captureTime:number}
export interface PreparedAcquisitionInput {
  readonly pixels:Uint8Array<ArrayBuffer>;readonly width:number;readonly height:number;readonly binding:PreparedRasterBinding;
}
export interface MeasuredSourceRasterReceipt extends PreparedRasterBinding {
  readonly version:1;readonly kind:'measured';readonly acquisitionFrameId:number;
  readonly width:number;readonly height:number;readonly hash:string;
}
/** A cached analysis may name its measured origin, never a fresh measurement. */
export interface AnalysisReusedSourceRasterReceipt extends Omit<MeasuredSourceRasterReceipt,'kind'> {
  readonly kind:'analysis-reused';readonly originAcquisitionFrameId:number;
}
export type SourceRasterReceipt=MeasuredSourceRasterReceipt|AnalysisReusedSourceRasterReceipt;
export interface AcquisitionPixelProof {readonly hash:string;readonly sample:readonly number[]}
export type ExpectedRasterReceipt=Omit<MeasuredSourceRasterReceipt,'version'|'kind'>;

function fail(detail:string):never {throw Error(`Invalid source raster: ${detail}`);}
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('plain object required');
  const record=value as Record<string,unknown>;
  if(Object.keys(record).length!==keys.length||keys.some(key=>!Object.hasOwn(record,key)))fail('unexpected or missing field');
  return record;
}
function positive(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<1)fail('positive integer required');return value as number;}
function hash(value:unknown):string {if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('SHA-256 required');return value;}
export function preparedRasterBytes(width:number,height:number):number {
  const bytes=positive(width)*positive(height)*4;
  if(!Number.isSafeInteger(bytes)||bytes>MAX_FRAME_BYTES)fail('RGBA byte limit');return bytes;
}
export function parsePreparedRasterBinding(value:unknown):PreparedRasterBinding {
  const binding=object(value,['sourceFrameId','captureTime']);
  if(typeof binding.captureTime!=='number'||!Number.isFinite(binding.captureTime)||binding.captureTime<0)fail('capture time');
  return Object.freeze({sourceFrameId:positive(binding.sourceFrameId),captureTime:binding.captureTime});
}
/** Validates exclusive whole-buffer ownership before any transfer or await. */
export function parsePreparedAcquisitionInput(value:unknown):PreparedAcquisitionInput {
  const input=object(value,['pixels','width','height','binding']),width=positive(input.width),height=positive(input.height),
    bytes=preparedRasterBytes(width,height),pixels=input.pixels;
  if(!(pixels instanceof Uint8Array)||!(pixels.buffer instanceof ArrayBuffer)||pixels.byteOffset!==0||
    pixels.byteLength!==bytes||pixels.buffer.byteLength!==bytes||
    (pixels.buffer as ArrayBuffer&{resizable?:boolean}).resizable===true)fail('owned whole RGBA ArrayBuffer required');
  try{new Uint8Array(pixels.buffer,0,bytes);}catch{fail('detached RGBA buffer');}
  return Object.freeze({pixels:pixels as Uint8Array<ArrayBuffer>,width,height,binding:parsePreparedRasterBinding(input.binding)});
}
export function parseMeasuredSourceRasterReceipt(value:unknown):MeasuredSourceRasterReceipt {
  const receipt=object(value,['version','kind','sourceFrameId','captureTime','acquisitionFrameId','width','height','hash']);
  if(receipt.version!==1||receipt.kind!=='measured')fail('measured receipt version/kind');
  const binding=parsePreparedRasterBinding({sourceFrameId:receipt.sourceFrameId,captureTime:receipt.captureTime}),
    width=positive(receipt.width),height=positive(receipt.height);preparedRasterBytes(width,height);
  return Object.freeze({version:1,kind:'measured',...binding,acquisitionFrameId:positive(receipt.acquisitionFrameId),width,height,hash:hash(receipt.hash)});
}
/** Shape validation only. Reuse is not another measurement; consumers must join
 * its origin to an actual measured receipt before treating the analysis as bound. */
export function parseSourceRasterReceipt(value:unknown):SourceRasterReceipt {
  if(value&&typeof value==='object'&&(value as Record<string,unknown>).kind==='analysis-reused'){
    const receipt=object(value,['version','kind','sourceFrameId','captureTime','acquisitionFrameId','width','height','hash','originAcquisitionFrameId']),
      originAcquisitionFrameId=positive(receipt.originAcquisitionFrameId),
      measured=parseMeasuredSourceRasterReceipt({version:receipt.version,kind:'measured',sourceFrameId:receipt.sourceFrameId,
        captureTime:receipt.captureTime,acquisitionFrameId:receipt.acquisitionFrameId,width:receipt.width,height:receipt.height,hash:receipt.hash});
    if(originAcquisitionFrameId===measured.acquisitionFrameId)fail('analysis reuse origin must differ from acquisition');
    return Object.freeze({...measured,kind:'analysis-reused',originAcquisitionFrameId});
  }
  return parseMeasuredSourceRasterReceipt(value);
}
export function validateMeasuredSourceRasterReceipt(value:unknown,expected:ExpectedRasterReceipt):MeasuredSourceRasterReceipt {
  const receipt=parseMeasuredSourceRasterReceipt(value),bound=parseMeasuredSourceRasterReceipt({version:1,kind:'measured',...expected});
  for(const key of ['sourceFrameId','captureTime','acquisitionFrameId','width','height','hash']as const)
    if(receipt[key]!==bound[key])fail(`receipt ${key} binding mismatch`);
  return receipt;
}
export function parseAcquisitionPixelProof(value:unknown):AcquisitionPixelProof {
  const proof=object(value,['hash','sample']);
  if(!Array.isArray(proof.sample)||proof.sample.length>32||proof.sample.some(byte=>!Number.isInteger(byte)||byte<0||byte>255))fail('pixel sample');
  for(let i=0;i<proof.sample.length;i++)if(!Object.hasOwn(proof.sample,i))fail('sparse pixel sample');
  return Object.freeze({hash:hash(proof.hash),sample:Object.freeze([...proof.sample])});
}
