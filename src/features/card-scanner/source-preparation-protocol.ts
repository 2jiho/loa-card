import {MAX_FRAME_BYTES} from './recording-frame-integrity';
import {parseNativeYuvMetadata} from './native-frame-storage';
import {planNativeYuvFrame,type NativeYuvFrameMetadata} from './native-yuv-recipe';

export const SOURCE_PREPARATION_BYTES=128*1024*1024;
export type SourcePreparationMode='auto'|'canvas';
export function parseSourcePreparationMode(value:unknown):SourcePreparationMode {
  if(value!=='auto'&&value!=='canvas')throw Error('Invalid source preparation selector');
  return value;
}
export interface SourceBinding {readonly sourceFrameId:number;readonly captureTime:number}
export interface SourcePreparationAttestationIdentity {readonly version:1;readonly sessionId:string;readonly producerId:string}
export const preparationTicketId=(value:unknown):value is string=>typeof value==='string'&&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function parsePreparationAttestationIdentity(value:unknown):SourcePreparationAttestationIdentity {
  const data=preparationObject(value,['version','sessionId','producerId']);
  const valid=(value:unknown)=>{
    if(typeof value!=='string'||value.length<1||value.length>128||/\s/u.test(value))return false;
    for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code<32||code===127)return false;}return true;
  };
  if(data.version!==1||!valid(data.sessionId)||!valid(data.producerId))throw Error('Invalid source preparation attestation identity');
  return Object.freeze({version:1,sessionId:data.sessionId as string,producerId:data.producerId as string});
}
export interface PreparedSource {
  readonly binding:SourceBinding;readonly width:number;readonly height:number;
  readonly pixels:Uint8Array<ArrayBuffer>;
  readonly storage:{readonly kind:'native';readonly descriptor:NativeYuvFrameMetadata;readonly pixels:Uint8Array<ArrayBuffer>;readonly ticketId?:string}
    |{readonly kind:'rgba';readonly pixels:ArrayBuffer};
  readonly hash:string;readonly mode:'native'|'rgba';readonly fallbackReason?:string;
  readonly timing:{readonly copyMs:number;readonly conversionHashMs:number;readonly rasterMs:number;readonly totalMs:number};
  /** Conservative reservation before the transferred input's profile is read. */
  readonly reservationBytes:number;
  /** Native+RGBA or the two returned raw buffers, excluding decoder/Canvas. */
  readonly outputBytes:number;
}
export function preparationObject(value:unknown,keys:readonly string[],required=keys):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    throw Error('Source preparation requires a plain object');
  const result=value as Record<string,unknown>;
  if(Object.keys(result).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(result,key)))
    throw Error('Invalid source preparation fields');
  return result;
}
export function parseSourceBinding(value:unknown):SourceBinding{
  const input=preparationObject(value,['sourceFrameId','captureTime']);
  if(!Number.isSafeInteger(input.sourceFrameId)||(input.sourceFrameId as number)<1||typeof input.captureTime!=='number'||
    !Number.isFinite(input.captureTime)||input.captureTime<0)throw Error('Invalid source preparation binding');
  return Object.freeze({sourceFrameId:input.sourceFrameId as number,captureTime:input.captureTime});
}
export function sourceRgbaBytes(width:number,height:number):number{
  const bytes=width*height*4;
  if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||
    !Number.isSafeInteger(bytes)||bytes>MAX_FRAME_BYTES)throw Error('Invalid source preparation dimensions');
  return bytes;
}
export function sourceOwnedBytes(value:unknown,bytes:number):value is Uint8Array<ArrayBuffer>{
  return value instanceof Uint8Array&&value.buffer instanceof ArrayBuffer&&value.byteOffset===0&&
    value.byteLength===bytes&&value.buffer.byteLength===bytes&&(value.buffer as ArrayBuffer&{resizable?:boolean}).resizable!==true;
}
export function parsePreparedSource(value:unknown):PreparedSource{
  const input=preparationObject(value,['binding','width','height','pixels','storage','hash','mode','fallbackReason','timing','reservationBytes','outputBytes'],
    ['binding','width','height','pixels','storage','hash','mode','timing','reservationBytes','outputBytes']);
  const binding=parseSourceBinding(input.binding),width=input.width as number,height=input.height as number,bytes=sourceRgbaBytes(width,height);
  if(!sourceOwnedBytes(input.pixels,bytes)||typeof input.hash!=='string'||!/^[a-f0-9]{64}$/.test(input.hash))
    throw Error('Invalid prepared source pixels/hash');
  const timing=preparationObject(input.timing,['copyMs','conversionHashMs','rasterMs','totalMs']);
  for(const time of Object.values(timing))if(typeof time!=='number'||!Number.isFinite(time)||time<0)throw Error('Invalid source preparation timing');
  let storage:PreparedSource['storage'],outputBytes:number;
  if(input.mode==='native'){
    const data=preparationObject(input.storage,['kind','descriptor','pixels','ticketId'],['kind','descriptor','pixels']),descriptor=parseNativeYuvMetadata(data.descriptor),plan=planNativeYuvFrame(descriptor);
    if(data.kind!=='native'||plan.width!==width||plan.height!==height||!sourceOwnedBytes(data.pixels,plan.nativeByteLength)||
      data.pixels.buffer===input.pixels.buffer||Object.hasOwn(input,'fallbackReason'))throw Error('Invalid prepared native storage');
    if(Object.hasOwn(data,'ticketId')&&!preparationTicketId(data.ticketId))throw Error('Invalid prepared native ticket');
    storage=Object.freeze({kind:'native',descriptor,pixels:data.pixels,...(Object.hasOwn(data,'ticketId')?{ticketId:data.ticketId as string}:{})});outputBytes=plan.nativeByteLength+bytes;
  }else if(input.mode==='rgba'){
    const data=preparationObject(input.storage,['kind','pixels']);
    if(data.kind!=='rgba'||!(data.pixels instanceof ArrayBuffer)||data.pixels.byteLength!==bytes||
      data.pixels===input.pixels.buffer||(data.pixels as ArrayBuffer&{resizable?:boolean}).resizable===true||
      typeof input.fallbackReason!=='string'||!input.fallbackReason.length||input.fallbackReason.length>256)
      throw Error('Invalid prepared raw storage');
    storage=Object.freeze({kind:'rgba',pixels:data.pixels});outputBytes=bytes*2;
  }else throw Error('Invalid source preparation mode');
  if(input.reservationBytes!==bytes*2||input.reservationBytes>SOURCE_PREPARATION_BYTES||input.outputBytes!==outputBytes)
    throw Error('Invalid source preparation reservation');
  return Object.freeze({binding,width,height,pixels:input.pixels,storage,hash:input.hash,mode:input.mode,
    ...(input.mode==='rgba'?{fallbackReason:input.fallbackReason as string}:{}),timing:Object.freeze(timing) as unknown as PreparedSource['timing'],
    reservationBytes:input.reservationBytes as number,outputBytes});
}
