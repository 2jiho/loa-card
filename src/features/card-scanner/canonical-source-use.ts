/** A processing use references stored pixels; it does not append another frame
 * or turn either identity into card freshness. */
export interface CanonicalSourceUse {readonly sourceFrameId:number;readonly acquisitionFrameId:number;readonly phase:'input'|'recovery';readonly captureTime:number}
export function parseCanonicalSourceUse(input:unknown):CanonicalSourceUse {
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw Error('잘못된 공통 원본 사용 기록');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['sourceFrameId','acquisitionFrameId','phase','captureTime'].includes(key))||
    !Number.isSafeInteger(value.sourceFrameId)||(value.sourceFrameId as number)<1||!Number.isSafeInteger(value.acquisitionFrameId)||(value.acquisitionFrameId as number)<1||
    !['input','recovery'].includes(value.phase as string)||typeof value.captureTime!=='number'||!Number.isFinite(value.captureTime)||value.captureTime<0)
    throw Error('잘못된 공통 원본 사용 기록');
  return Object.freeze({sourceFrameId:value.sourceFrameId as number,acquisitionFrameId:value.acquisitionFrameId as number,
    phase:value.phase as 'input'|'recovery',captureTime:value.captureTime});
}
