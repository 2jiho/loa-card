/** Bounded counters from one acquisition, not independent recognition evidence. */
export type AcquisitionProfile={exact:number;moved:number;inspected:number;probeMs:number;shifted:number;moveCompared:number;moveMatched:number};
export type AcquisitionProfileSummary=AcquisitionProfile&{samples:number};

export function acquisitionProfile(value:unknown):AcquisitionProfile|undefined{
  if(!value||typeof value!=='object')return;
  const p=value as AcquisitionProfile;
  if(![p.exact,p.moved,p.inspected,p.moveCompared,p.moveMatched].every(n=>Number.isInteger(n)&&n>=0&&n<=40)||
    ![0,1].includes(p.shifted)||p.moved>p.moveMatched||p.moveMatched>p.moveCompared||
    p.exact+p.moved+p.inspected>40||!Number.isFinite(p.probeMs)||p.probeMs<0)return;
  return {exact:p.exact,moved:p.moved,inspected:p.inspected,probeMs:p.probeMs,
    shifted:p.shifted,moveCompared:p.moveCompared,moveMatched:p.moveMatched};
}

/** Totals over measured frames only. Missing measurements never become zeros. */
export function addAcquisitionProfile(previous:AcquisitionProfileSummary|undefined,value:unknown):AcquisitionProfileSummary|undefined{
  const p=acquisitionProfile(value);
  if(!p)return previous;
  return {samples:(previous?.samples??0)+1,exact:(previous?.exact??0)+p.exact,
    moved:(previous?.moved??0)+p.moved,inspected:(previous?.inspected??0)+p.inspected,
    probeMs:(previous?.probeMs??0)+p.probeMs,shifted:(previous?.shifted??0)+p.shifted,
    moveCompared:(previous?.moveCompared??0)+p.moveCompared,moveMatched:(previous?.moveMatched??0)+p.moveMatched};
}
