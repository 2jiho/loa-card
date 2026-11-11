const stages=['global','tracked','refinement','growth'] as const;
type Stage=typeof stages[number];
export type DetectorProfile=Partial<Record<Stage,{calls:number;cached:number;elapsedMs:number}>>;
/** Bounded development counters; no pixels or per-frame event queue. */
export function recordDetectorStage(profile:DetectorProfile,event:Record<string,unknown>):void {
  const stage:Stage|undefined=event.stage==='coarse'?event.tracked===true?'tracked':'global':
    event.stage==='refinement-work'?'refinement':event.stage==='growth'?'growth':undefined;
  if(!stage||typeof event.cached!=='boolean'||typeof event.elapsedMs!=='number'||
    !Number.isFinite(event.elapsedMs)||event.elapsedMs<0)return;
  const row=profile[stage]??={calls:0,cached:0,elapsedMs:0};
  row.calls++;row.cached+=Number(event.cached);row.elapsedMs+=event.elapsedMs;
}
export function detectorProfile(value:unknown):DetectorProfile|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const result:DetectorProfile={};
  for(const [key,v] of Object.entries(value)) {
    if(!stages.includes(key as Stage)||!v||typeof v!=='object')return;
    const row=v as {calls:number;cached:number;elapsedMs:number};
    if(!Number.isSafeInteger(row.calls)||row.calls<1||!Number.isSafeInteger(row.cached)||row.cached<0||
      row.cached>row.calls||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0)return;
    result[key as Stage]={calls:row.calls,cached:row.cached,elapsedMs:row.elapsedMs};
  }
  return Object.keys(result).length?result:undefined;
}
export function addDetectorProfile(previous:DetectorProfile|undefined,value:unknown):DetectorProfile|undefined {
  const next=detectorProfile(value);if(!next)return previous;
  const result:DetectorProfile={...previous};
  for(const stage of stages) {
    const row=next[stage];if(!row)continue;
    const old=previous?.[stage];result[stage]={calls:(old?.calls??0)+row.calls,
      cached:(old?.cached??0)+row.cached,elapsedMs:(old?.elapsedMs??0)+row.elapsedMs};
  }
  return result;
}
