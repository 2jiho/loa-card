import {parseCardCropProofData} from './card-crop-proof-core';
import type {CardCropProofData} from './card-crop-proof-core';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../src/features/card-scanner/scanner-name-configuration';
import type {ScannerNameConfiguration} from '../src/features/card-scanner/scanner-name-configuration';

export type CardCropProofModeId='baseline'|'gray-first-line-opt-in'|'fractional-registration-opt-in'|'contrast-first-line-opt-in';
export interface CardCropProofMode {
  readonly id:CardCropProofModeId;
  readonly portraitRefinement:boolean;
  readonly grayNameFallback:boolean;
  readonly contrastNameFallback?:boolean;
}
export interface CardCropProofRoute {
  readonly manifestPath:string;
  readonly expectedManifestSha256:string|null;
  readonly comparison:'baseline-gray'|'portrait-registration'|'name-contrast';
  readonly modes:readonly CardCropProofMode[];
  readonly nameConfiguration:ScannerNameConfiguration;
}
const BASELINE=Object.freeze({id:'baseline' as const,portraitRefinement:false,grayNameFallback:false});
const GRAY=Object.freeze({id:'gray-first-line-opt-in' as const,portraitRefinement:false,grayNameFallback:true});
const FRACTIONAL=Object.freeze({id:'fractional-registration-opt-in' as const,portraitRefinement:true,grayNameFallback:false});
const LEGACY_MODES=Object.freeze([BASELINE,GRAY]);
const PORTRAIT_MODES=Object.freeze([BASELINE,FRACTIONAL]);
const CONTRAST_MODES=Object.freeze([BASELINE,Object.freeze({id:'contrast-first-line-opt-in' as const,portraitRefinement:false,grayNameFallback:false,contrastNameFallback:true})]);
const HASH=/^[a-f0-9]{64}$/;
// A basename, not a URL/path. No arbitrary fetch, traversal, or mutable pointer write.
const MANIFEST=/^failure-card-crop-[a-z0-9][a-z0-9-]{0,120}-([a-f0-9]{64})\.json$/;

/** DEV-only routing. Defaults preserve the selected legacy pointer and modes.
 * Neither URL fields nor manifest annotations may change recognition gates. */
export function parseCardCropProofRoute(search:string):CardCropProofRoute {
  if(typeof search!=='string'||search.length>1024)throw Error('Crop proof query exceeds its bound.');
  const parameters=new URLSearchParams(search),seen=new Set<string>();
  for(const [key] of parameters){
    if(!['manifest','comparison'].includes(key)||seen.has(key))throw Error('Unsupported or duplicate crop proof option.');
    seen.add(key);
  }
  const selected=parameters.get('manifest');
  const matched=selected===null?null:MANIFEST.exec(selected);
  if(selected!==null&&!matched)throw Error('Select a content-addressed local failure crop manifest basename.');
  const requested=parameters.get('comparison');
  if(requested!==null&&requested!=='baseline-gray'&&requested!=='portrait-registration'&&requested!=='name-contrast')throw Error('Unsupported crop proof comparison.');
  const comparison=requested??'baseline-gray';
  return Object.freeze({manifestPath:selected===null?'/work/card-crop-inputs.json':`/work/${selected}`,
    expectedManifestSha256:matched?.[1]??null,comparison,
    modes:comparison==='name-contrast'?CONTRAST_MODES:comparison==='portrait-registration'?PORTRAIT_MODES:LEGACY_MODES,
    nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION});
}

/** The hash is computed by the bounded response reader over actual bytes before
 * parsing. Existing strict v1 schema is reused; no source/candidate adapter. */
export function parseSelectedCardCropProof(route:CardCropProofRoute,text:string,actualManifestSha256:string):CardCropProofData {
  if(!HASH.test(actualManifestSha256)||route.expectedManifestSha256!==null&&actualManifestSha256!==route.expectedManifestSha256)
    throw Error('Selected crop manifest SHA-256 mismatch.');
  return parseCardCropProofData(text);
}
