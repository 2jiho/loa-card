/** Development/test only. Saves the live scan's own result next to its share
 * recording (docs/dev-recording.md), in the same report format as a replay, so
 * a replay of the recording can be compared with what the live scan produced.
 *
 * The report is overwritten about once a second while the scan runs (so the last
 * state survives a refresh or a crash) and written once more, final, when the
 * recording is sealed and its hash is known. Failures are ignored: this must
 * never affect scanning. */
export interface LiveRunState {
  readonly cards:readonly {readonly id:string;readonly name:string;readonly awakening:number|null;readonly extraCopies:number|null}[];
  readonly status?:string;
  readonly currentRunRead?:number;
  readonly queued?:number;
  readonly activeReadings?:number;
  readonly sampled?:number;
  readonly workPhase?:string;
  /** Set when the scan was cut short (stalled, cancelled or failed). */
  readonly interrupted?:string;
  readonly expected?:number|null;
  readonly unidentified?:readonly unknown[];
}
export interface LiveRecordingMeta {readonly sha256:string|null;readonly complete:boolean;readonly frames:number}

/** One point of the scan's progress: seconds since the scan started. */
export interface LiveTimelinePoint {
  readonly t:number;readonly read:number;readonly cards:number;readonly queued:number;readonly status:string;
  readonly active:number;readonly sampled:number;readonly phase:string;readonly interrupted:string|null;
}
export const MAX_TIMELINE_POINTS=900;

export function buildLiveRunReport(input:{recordingId:string;startedAt:string;now:string;state:LiveRunState;build:string;final:boolean;meta?:LiveRecordingMeta|null;timeline?:readonly LiveTimelinePoint[]}) {
  const {state,meta}=input;
  return {
    kind:'recording-replay' as const,version:1 as const,startedAt:input.startedAt,finishedAt:input.now,
    recording:{id:input.recordingId,sha256:meta?.sha256??null,complete:meta?.complete??false,frames:meta?.frames??0},
    delivery:null,
    status:`${input.final?'':'(진행 중) '}${state.status??''}`.trim(),
    cards:state.cards.map(card=>({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies})),
    live:{final:input.final,timeline:input.timeline??[]},
    summary:{build:input.build,read:state.currentRunRead??0,expected:state.expected??null,unidentified:state.unidentified?.length??0,
      meanLateMs:0,maxLateMs:0,lateOver33Ms:0,deliveredRatio:1,mode:'live' as const,faithful:true},
  };
}

export function createLiveRunReporter(options:{recordingId:string;build:string;base?:string;intervalMs?:number;request?:typeof fetch;now?:()=>Date}) {
  const base=options.base??'/__rec',interval=options.intervalMs??1000,request=options.request??fetch,now=options.now??(()=>new Date());
  const startedAt=now().toISOString();
  const startedMs=now().getTime(),timeline:LiveTimelinePoint[]=[];
  let latest:LiveRunState|undefined,timer:ReturnType<typeof setTimeout>|undefined,closed=false;
  const send=async(final:boolean,meta?:LiveRecordingMeta|null)=>{
    if(!latest)return;
    // Progress over time, so a result that stopped early can be explained
    // (when it stopped, and whether work was still queued).
    const point:LiveTimelinePoint={t:Math.round((now().getTime()-startedMs)/100)/10,read:latest.currentRunRead??0,cards:latest.cards.length,
      queued:latest.queued??0,status:(latest.status??'').slice(0,60),active:latest.activeReadings??0,sampled:latest.sampled??0,
      phase:latest.workPhase??'',interrupted:latest.interrupted??null};
    if(timeline.length<MAX_TIMELINE_POINTS)timeline.push(point);else timeline[timeline.length-1]=point;
    const report=buildLiveRunReport({recordingId:options.recordingId,startedAt,now:now().toISOString(),state:latest,build:options.build,final,meta,timeline});
    try{await request(`${base}/${encodeURIComponent(options.recordingId)}/runs/live`,{method:'PUT',body:JSON.stringify(report)});}
    catch{/* Development tooling never affects the scan. */}
  };
  return {
    /** Remember the newest state; it is sent at most once per interval. */
    update(state:LiveRunState):void {
      latest=state;
      if(closed||timer!==undefined)return;
      timer=setTimeout(()=>{timer=undefined;void send(false);},interval);
    },
    /** The scan ended and the recording is sealed: write the final report. */
    async finish(meta:LiveRecordingMeta|null):Promise<void> {
      if(closed)return;
      closed=true;
      if(timer!==undefined){clearTimeout(timer);timer=undefined;}
      await send(true,meta);
    },
  };
}
