import {exactEntries} from './exact-recording-codec';
import {yieldForCapture} from './input-source';
import {frameStorageSignature,frameDecodeWorkBytes} from './native-frame-storage';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY,admitWindowFrame,type DependencyState} from './rgba-window-policy';

/** Recover only fully written archive entries after interruption. This checks
 * structure and dependency order; exactPixels still verifies decoded hashes. */
export async function inspectExactPrefix(blob:Blob,signal:AbortSignal){
  let bytes=0,frames=0,events=0,lastFrame=0,lastEvent=0,width=0,height=0,first=Infinity,last=0,error='',canonical:boolean|undefined,
    signature:string|undefined,storageVersion:1|undefined,nativeFrames=0,rgbaFrames=0,chainFrames=0,chainBytes=0,
    windowMode:boolean|undefined,windowState:DependencyState|null=null;
  const selected={kind:'rgba-window' as const,version:6 as const,codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY};
  try {
    for await(const entry of exactEntries(blob,signal)) {
      const header=entry.header;
      if(header.kind==='frame') {
        const nextWindow=header.codec===RGBA_WINDOW_CODEC;
        if(windowMode!==undefined&&windowMode!==nextWindow)throw Error('혼합된 원본 복원 정책');
        if(nextWindow){
          const admission=admitWindowFrame(selected,windowState,header,entry.payload.size);
          windowState=admission.state;
        }else if(Object.hasOwn(header,'policy'))throw Error('구버전 원본에 window 정책을 적용할 수 없습니다.');
        if(canonical!==undefined&&canonical!==!!header.canonical)throw Error('혼합된 원본 기록 형식');
        canonical=!!header.canonical;
        const nextSignature=frameStorageSignature(header.storage,header.width,header.height);
        if(header.id<=lastFrame||!header.key&&(!frames||header.width!==width||header.height!==height||signature!==nextSignature))
          throw Error('이전 기준 프레임이 없는 부분 입력');
        const nextChainFrames=header.key?1:chainFrames+1,
          nextChainBytes=frameDecodeWorkBytes(header.storage,header.width,header.height)+(header.key?0:chainBytes);
        if(header.canonical&&(nextChainFrames>8||!nextWindow&&nextChainBytes>32*1024*1024&&nextChainFrames>1))
          throw Error('부분 정규 입력의 복원 예산 초과');
        frames++;lastFrame=header.id;width=header.width;height=header.height;signature=nextSignature;windowMode=nextWindow;
        chainFrames=nextChainFrames;chainBytes=nextChainBytes;
        if(header.storage!==undefined){storageVersion=1;if(header.storage.kind==='native-yuv420')nativeFrames++;else rgbaFrames++;}
      }else {
        if(header.seq<=lastEvent)throw Error('부분 실행 기록의 순서가 올바르지 않습니다.');
        events++;lastEvent=header.seq;
      }
      first=Math.min(first,header.time);last=Math.max(last,header.time);bytes=entry.endOffset;
      if((frames+events)%256===0)await yieldForCapture(signal);
    }
  }catch(reason){signal.throwIfAborted();error=reason instanceof Error?reason.message:String(reason);}
  signal.throwIfAborted();
  return {blob:blob.slice(0,bytes),bytes,frames,events,duration:frames+events?Math.max(0,last-first):0,
    complete:bytes===blob.size&&!error,error,...(canonical?{canonical:true as const}:{}),...(storageVersion?{storageVersion,nativeFrames,rgbaFrames}:{}),
    ...(windowMode?{codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY}:{})};
}
