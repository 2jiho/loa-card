import {compareReproduction,type ReproductionResult} from '../src/features/card-scanner/scan-reproduction';

/** Equality is a regression observation, never a claim of independent truth. */
export function compareReplayResult(before:ReproductionResult|null,after:ReproductionResult|null,
 completed:boolean,partialInput:boolean){
 const fields=before&&after?compareReproduction(before,after):null;
 const totals=before&&after?{
  expected:before.expected===after.expected,read:before.read===after.read,
  experience:before.experience===after.experience,unidentified:before.unidentified===after.unidentified,
 }:null;
 const matches=fields&&totals?fields.added.length===0&&fields.missing.length===0&&fields.changed.length===0&&Object.values(totals).every(Boolean):null;
 return {kind:'recorded-program-result-comparison' as const,completed,partialInput,matches,
  status:!completed?'incomplete':matches===null?'baseline-unavailable':matches?'match':'different',fields,totals};
}
