import type {FrameStorage} from './native-frame-storage';
import type {RGBA_WINDOW_CODEC, RGBA_WINDOW_POLICY} from './rgba-window-policy';

export interface ExactFrame {
  kind:'frame';id:number;time:number;width:number;height:number;key:boolean;hash:string;
  codec?:'lz4'|typeof RGBA_WINDOW_CODEC;policy?:typeof RGBA_WINDOW_POLICY;xor?:boolean;
  phase?:'input'|'recovery';canonical?:true;storage?:FrameStorage;
}

export interface ExactEvent {
  kind:'event';seq:number;time:number;type:string;value:unknown;
}

export type ExactEntry = ExactFrame | ExactEvent;
