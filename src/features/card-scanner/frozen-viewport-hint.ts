import type {Box,Layout} from './detector';
import {LiveScrollPreview} from './live-scroll-preview';
import {estimateScrollRows} from './scroll-card-location';

/** A scheduling hint, never an absolute slot or card/coverage observation.
 * Its private strip reader cannot consume the display lane's polling budget. */
export class FrozenViewportHints<Source> {
  private readonly reader:LiveScrollPreview<Source>;
  constructor(pixels:(source:Source,box:Box,width:number,height:number)=>ArrayLike<number>) {
    this.reader=new LiveScrollPreview(pixels);
  }
  bind(source:Source,width:number,height:number,layout:Layout|null,capturedAtMs:number) {
    this.reader.bind(source,width,height,layout,capturedAtMs);
  }
  read(source:Source,width:number,height:number,capturedAtMs:number):Readonly<{rowStart:number;rowCount:number}>|undefined {
    // Callers pass the owned frozen source, not the mutable preview video.
    const geometry=this.reader.read(source,width,height,capturedAtMs);
    if(!geometry||estimateScrollRows(geometry)!==55||!Number.isFinite(geometry.position)||geometry.position<0||geometry.position>1)return;
    return Object.freeze({rowStart:Math.round(geometry.position*51),rowCount:4});
  }
}
