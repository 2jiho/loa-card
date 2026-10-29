import {planNativeYuvFrame,UnsupportedNativeYuvError} from './native-yuv-recipe';
import type {NativeYuvFrameMetadata,NativeYuvPlan} from './native-yuv-recipe';

/** Native timestamps describe a source, never scanner capture order/freshness. */
export interface NativeYuvTransformNative extends NativeYuvFrameMetadata {
 readonly timestampMicroseconds:number;
 readonly durationMicroseconds:number|null;
}
export interface NativeYuvTransformSourceFrame {
 readonly format:string|null;readonly codedWidth:number;readonly codedHeight:number;
 readonly displayWidth:number;readonly displayHeight:number;
 readonly visibleRect:{readonly x:number;readonly y:number;readonly width:number;readonly height:number}|null;
 readonly rotation?:number;readonly flip?:boolean;
 readonly timestamp:number;readonly duration:number|null;
 readonly colorSpace:{toJSON():VideoColorSpaceInit};
 close():void;
}

/** Pure metadata read, used independently before and after frame transfer.
 * VideoFrame/DOMRect getters must not be object-spread. No Worker, Canvas,
 * source ID, inventory or side-effectful client import belongs in this module. */
export function describeNativeYuvTransformFrame(frame:NativeYuvTransformSourceFrame):{native:NativeYuvTransformNative;plan:NativeYuvPlan}{
 if(!frame||frame.rotation!==0||frame.flip!==false)throw new UnsupportedNativeYuvError('native-orientation-unknown-or-unsupported');
 if(!Number.isSafeInteger(frame.timestamp)||frame.duration!==null&&(!Number.isSafeInteger(frame.duration)||frame.duration<0))throw new UnsupportedNativeYuvError('native-timing');
 const rect=frame.visibleRect,color=frame.colorSpace.toJSON();
 const native:NativeYuvTransformNative=Object.freeze({format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
  displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,
  visibleRect:rect?Object.freeze({x:rect.x,y:rect.y,width:rect.width,height:rect.height}):null,rotation:0,flip:false,
  colorSpace:Object.freeze({primaries:color.primaries??null,transfer:color.transfer??null,matrix:color.matrix??null,fullRange:color.fullRange??null}),
  timestampMicroseconds:frame.timestamp,durationMicroseconds:frame.duration});
 return {native,plan:planNativeYuvFrame(native)};
}
