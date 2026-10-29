import {NAME_LABEL_VARIANTS,nameLabelVariant,parseNameLabelProofData} from './name-label-proof-core';
import type {NameLabelVariant} from './name-label-proof-core';
import {NAME_LABEL_CONTRAST_VARIANTS,nameLabelContrast} from './name-label-contrast';
import type {NameLabelContrastVariant} from './name-label-contrast';
import {NAME_LABEL_COLOR_VARIANTS,nameLabelColor,type NameLabelColorVariant} from './name-label-color';

export type NameLabelProofVariant=NameLabelVariant|NameLabelContrastVariant|NameLabelColorVariant;
export interface NameLabelProofRoute {
  readonly manifestPath:string;readonly expectedManifestSha256:string|null;
  readonly family:'legacy'|'contrast-first-line'|'color-first-line';readonly variants:readonly NameLabelProofVariant[];
}
const MANIFEST=/^failure-name-label-[a-z0-9][a-z0-9-]{0,120}-([a-f0-9]{64})\.json$/;
const LEGACY=Object.freeze([...NAME_LABEL_VARIANTS]);
const CONTRAST=Object.freeze(['raw-first','gray-first',...NAME_LABEL_CONTRAST_VARIANTS] as const);
const COLOR=Object.freeze(['raw-first','gray-first',...NAME_LABEL_COLOR_VARIANTS] as const);
/** Only a local content-addressed basename and a fixed recipe family. Neither
 * query nor input annotations can select a model, name or confidence gate. */
export function parseNameLabelProofRoute(search:string):NameLabelProofRoute {
  if(typeof search!=='string'||search.length>1024)throw Error('Name label query exceeds its bound.');
  const parameters=new URLSearchParams(search),seen=new Set<string>();
  for(const [key] of parameters){
    if(!['manifest','recipes'].includes(key)||seen.has(key))throw Error('Unsupported or duplicate name label option.');seen.add(key);
  }
  const selected=parameters.get('manifest'),matched=selected===null?null:MANIFEST.exec(selected);
  if(selected!==null&&!matched)throw Error('Select a content-addressed local name label manifest basename.');
  const requested=parameters.get('recipes');
  if(requested!==null&&requested!=='contrast-first-line'&&requested!=='color-first-line')throw Error('Unsupported recipe family.');
  return Object.freeze({manifestPath:selected===null?'/work/paired-name-inputs.json':`/work/${selected}`,
    expectedManifestSha256:matched?.[1]??null,family:requested??'legacy',variants:requested==='color-first-line'?COLOR:requested?CONTRAST:LEGACY});
}
export function parseSelectedNameLabels(route:NameLabelProofRoute,text:string,actualSha256:string){
  if(!/^[a-f0-9]{64}$/.test(actualSha256)||route.expectedManifestSha256!==null&&actualSha256!==route.expectedManifestSha256)
    throw Error('Selected name label manifest SHA-256 mismatch.');
  return parseNameLabelProofData(text);
}
export function nameLabelProofVariant(source:Uint8ClampedArray,variant:NameLabelProofVariant){
  if((NAME_LABEL_COLOR_VARIANTS as readonly string[]).includes(variant))return nameLabelColor(source,variant as NameLabelColorVariant);
  return (NAME_LABEL_CONTRAST_VARIANTS as readonly string[]).includes(variant)
    ?nameLabelContrast(source,variant as NameLabelContrastVariant):nameLabelVariant(source,variant as NameLabelVariant);
}
