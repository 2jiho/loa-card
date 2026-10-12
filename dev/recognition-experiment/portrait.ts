import {createPortraitMatcher as original} from './legacy-portrait';
import type { Reference } from '../../src/features/card-scanner/recognizer';
import type { PortraitTextEvidence } from '../../src/features/card-scanner/portrait-matcher';
import {createMaskedMatcher} from './masked-matcher';
import type {MaskedAtlas,PortraitPixels} from './masked-matcher';
export type {PortraitEvidence,PortraitTextEvidence} from '../../src/features/card-scanner/portrait-matcher';

export function createPortraitMatcher(cards:Reference[],atlas:Record<string,string>,supplement:Record<string,string>,experiment:MaskedAtlas) {
  const masked=createMaskedMatcher(cards,experiment);
  // Preserve the validated fast path. High-resolution masked matching runs
  // only when it cannot decide; its evidence never depends on banner text.
  const fallback=original(cards,atlas,supplement);
  return(gray:ArrayLike<number>,text?:PortraitTextEvidence&{id:string},source?:PortraitPixels)=>{
    if(!source)return null;
    const old=fallback(gray,text);if(old)return old;
    return masked(source,text);
  };
}
