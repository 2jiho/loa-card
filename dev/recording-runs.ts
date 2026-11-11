/** Pure helpers for replay run reports (docs/dev-recording.md). Reports of the
 * same recording are comparable only when the input hash matches. */
/** `observations`: how many times the scan saw the card (evidence strength; not part of a card's identity or value). */
export interface RunCard {readonly id:string;readonly name:string;readonly awakening:number|null;readonly extraCopies:number|null;readonly observations?:number}
export interface RunDeliveryLike {
  readonly meanLateMs:number;readonly maxLateMs:number;readonly lateOver33Ms:number;readonly frames:number;readonly declaredFrames:number;
  /** `sequential`: every recorded frame fed in order (deterministic). `realtime`:
   * the recorded cadence (load sensitive). Absent: treated as realtime. */
  readonly mode?:'realtime'|'sequential'|'live';
}
export interface RunSummary {
  readonly build:string;readonly read:number;readonly expected:number|null;readonly unidentified:number;
  readonly meanLateMs:number;readonly maxLateMs:number;readonly lateOver33Ms:number;
  /** Frames replayed versus frames the recording lists; below 1 the input was cut short. */
  readonly deliveredRatio:number;
  /** `live`: the scan the recording was made from (its own result, not a replay). */
  readonly mode:'realtime'|'sequential'|'live';
  /** Whether delivery kept the recorded cadence. A late replay lets the video
   * pipeline merge frames, so its result is not comparable to a faithful one. */
  readonly faithful:boolean;
}

/** Thresholds for a replay to count as faithful.
 * sequential: every recorded frame was fed (it cannot be late or merged).
 * realtime: nearly every frame delivered, none later than 250 ms, at most 5 %
 * later than 33 ms; otherwise the video pipeline may have merged frames. */
export const FAITHFUL_MIN_DELIVERED=0.99,FAITHFUL_MAX_LATE_MS=250,FAITHFUL_MAX_LATE_SHARE=0.05;
export function deliveryFaithful(delivery:RunDeliveryLike):boolean {
  if(!delivery.declaredFrames||!delivery.frames)return false;
  if(delivery.frames/delivery.declaredFrames<FAITHFUL_MIN_DELIVERED)return false;
  if(delivery.mode==='sequential')return true;
  return delivery.maxLateMs<=FAITHFUL_MAX_LATE_MS&&delivery.lateOver33Ms/delivery.frames<=FAITHFUL_MAX_LATE_SHARE;
}
export interface UnresolvedObservation {
  readonly time:number;readonly reason:string|null;readonly pending:boolean;
  readonly attempts:readonly {readonly text:string;readonly confidence:number;readonly reason:string;
    readonly candidates:readonly {readonly name:string;readonly score:number}[]}[];
  readonly image?:string;
  /** The artwork matcher's own diagnostics (stages, candidates, gate checks), bounded by its own limits. */
  readonly portrait?:unknown;
}
const IMAGES_KEPT=12;
interface UnresolvedSource {time:number;reason?:string;pending:boolean;image?:string;portraitDiagnostics?:unknown;
  nameAttempts?:readonly {text:string;confidence:number;reason:string;candidates:readonly {name:string;score:number}[]}[]}
/** Plain, bounded copy of the scan's unresolved observations. */
export function summarizeUnresolved(items:readonly UnresolvedSource[]|undefined):UnresolvedObservation[] {
  return (items??[]).map((item,index)=>({time:item.time,reason:item.reason??null,pending:item.pending,
    attempts:(item.nameAttempts??[]).slice(0,6).map(attempt=>({text:attempt.text,confidence:attempt.confidence,reason:attempt.reason,
      candidates:attempt.candidates.slice(0,3).map(candidate=>({name:candidate.name,score:candidate.score}))})),
    ...(item.portraitDiagnostics?{portrait:item.portraitDiagnostics}:{}),
    ...(index<IMAGES_KEPT&&item.image?{image:item.image}:{})}));
}
export interface FrameTimingSummary {readonly frames:number;readonly consumeMs:number;readonly prepMs:number}
export interface RunReport {
  readonly kind:'recording-replay';readonly version:1;readonly startedAt:string;readonly finishedAt:string;
  readonly recording:{readonly id:string;readonly sha256:string|null;readonly complete:boolean;readonly frames:number};
  readonly delivery:unknown;readonly status:string;readonly cards:readonly RunCard[];readonly summary:RunSummary;
  /** Capture times (seconds) of frames from which at least one crop was admitted
   * to recognition. Observed by the run, not a human-confirmed fact. */
  readonly usedFrameTimes?:readonly number[];
  /** Capture times of frames in which the card grid (window) was located. */
  readonly locatedFrameTimes?:readonly number[];
  /** What the scan could not resolve by the end (for diagnosing a missing card).
   * Observed by the run, not a human-confirmed fact. Images are kept only for
   * the first few observations to bound the report size. */
  readonly unresolved?:{
    readonly unidentified:readonly UnresolvedObservation[];
    readonly discarded:readonly UnresolvedObservation[];
    readonly recognitionNeeded:readonly {readonly slot:number;readonly captureTime:number;readonly reason:string}[];
  };
  /** Cards whose extra-copy count the scan left unread (`null`), with the reading's own
   * diagnostics and a preview, to tell a truly unreadable count from an over-strict rule. */
  readonly countReview?:readonly {
    readonly name:string;readonly awakening:number|null;readonly review:readonly string[];readonly countReliable:boolean|null;
    readonly time:number|null;readonly observations:number|null;readonly diagnostics:unknown;readonly image?:string;
  }[];
  /** Per-card empty-counter evidence of every stored observation (development measurement). */
  readonly countCalibration?:readonly unknown[];
  /** Scanner time per fed frame, split by whether the card grid was located in it. */
  readonly frameTiming?:{readonly frames:number;readonly located:FrameTimingSummary;readonly other:FrameTimingSummary;readonly wallMs:number;readonly stages?:{readonly located:Readonly<Record<string,number>>;readonly other:Readonly<Record<string,number>>};readonly loop?:{readonly located:Readonly<Record<string,number>>;readonly other:Readonly<Record<string,number>>}};
  /** Present for a live-path replay: how the scanner was run and its progress over time. */
  readonly liveReplay?:{readonly recordingMode:'off'|'detailed';readonly timeline:readonly unknown[];readonly recoveryProbe?:unknown;
    /** The scanner's own input and acquisition statistics at the end of the run. */
    readonly inputPipeline?:unknown;readonly performance?:unknown};
  /** Set when only part of the recording was fed (subset experiment). */
  readonly subsetOf?:{readonly run:string;readonly frames:number;readonly of:number};
  /** First 16 hex digits of the hash of the source and scanner data the dev server started with. */
  readonly sourceSignature?:string;
  /** Where the reading work went (development measurement). */
  readonly readAnalysis?:ReadAnalysis;
  /** Where the time of a card read went, by read kind and outcome (development measurement). */
  readonly readProfile?:readonly ReadProfileGroup[];
  /** Present only with ?rescue=tile|verify: the rescue feature read check and its counters. */
  readonly rescueFeature?:{readonly mode:string;readonly calls:number;readonly ms:number;readonly compared:number;readonly different:number};
  /** Present only for a `realtime-batch` run: the frame-batch visual reading counters. */
  readonly visualBatch?:{readonly batches:number;readonly crops:number;readonly declinedCrops:number;
    readonly resolved:number;readonly failed:number;readonly meanRoundTripMs:number};
  /** One example crop per rejection reason, as the scanner kept it. */
  readonly rejectedSamples?:readonly {readonly image:string;readonly time:number;readonly slot:number;readonly reason:string;readonly sharpness:number}[];
}

export function summarizeRun(input:{build:string;read:number;expected:number|null;unidentified:number;delivery:RunDeliveryLike}):RunSummary {
  const {delivery}=input;
  return Object.freeze({build:input.build,read:input.read,expected:input.expected,unidentified:input.unidentified,
    meanLateMs:delivery.meanLateMs,maxLateMs:delivery.maxLateMs,lateOver33Ms:delivery.lateOver33Ms,
    deliveredRatio:delivery.declaredFrames?delivery.frames/delivery.declaredFrames:0,mode:delivery.mode??'realtime',faithful:deliveryFaithful(delivery)});
}

export interface RunDiff {
  readonly onlyA:readonly RunCard[];
  readonly onlyB:readonly RunCard[];
  readonly changed:readonly {readonly a:RunCard;readonly b:RunCard}[];
  readonly same:number;
}

/** Card-level difference between two runs of the same input. A card that is
 * only present in one run is a read/not-read difference; a changed card
 * differs in awakening or extra copies. Order does not matter. */
export function diffRuns(a:readonly RunCard[],b:readonly RunCard[]):RunDiff {
  const mapA=new Map(a.map(card=>[card.id,card])),mapB=new Map(b.map(card=>[card.id,card]));
  const onlyA:RunCard[]=[],onlyB:RunCard[]=[],changed:{a:RunCard;b:RunCard}[]=[];
  let same=0;
  for(const [id,left] of mapA){
    const right=mapB.get(id);
    if(!right)onlyA.push(left);
    else if(left.awakening!==right.awakening||left.extraCopies!==right.extraCopies)changed.push({a:left,b:right});
    else same++;
  }
  for(const [id,right] of mapB)if(!mapA.has(id))onlyB.push(right);
  const byName=(x:RunCard,y:RunCard)=>x.name.localeCompare(y.name,'ko');
  return Object.freeze({onlyA:onlyA.sort(byName),onlyB:onlyB.sort(byName),
    changed:changed.sort((x,y)=>byName(x.a,y.a)),same});
}

/** Two reports describe the same input only with equal, known hashes. */
export function sameInput(a:RunReport,b:RunReport):boolean {
  return !!a.recording.sha256&&a.recording.sha256===b.recording.sha256;
}

/** Why two runs may not be compared as like for like; empty when they may. */
export function comparabilityIssues(a:RunReport,b:RunReport):string[] {
  const issues:string[]=[];
  if(!sameInput(a,b))issues.push('입력이 같다고 증명되지 않았습니다(해시가 다르거나 없음).');
  if(!a.summary.faithful)issues.push('A의 재실행이 충실하지 않습니다(프레임이 합쳐지거나 빠졌을 수 있음).');
  if(!b.summary.faithful)issues.push('B의 재실행이 충실하지 않습니다(프레임이 합쳐지거나 빠졌을 수 있음).');
  // A live scan against its own replay is the intended comparison; its timing differs by nature.
  if(a.summary.mode!==b.summary.mode&&a.summary.mode!=='live'&&b.summary.mode!=='live')issues.push('두 실행의 재생 방식이 다릅니다(실시간 간격 대 순차).');
  if((a.summary.mode==='live'||b.summary.mode==='live')&&!(a.recording.complete&&b.recording.complete))issues.push('라이브 결과와 비교하려면 기록이 완전해야 합니다(프레임 누락 가능).');
  return issues;
}

/** A scan ledger trace, as far as the read analysis needs it. */
export interface ReadTraceLike {
  readonly time:number;readonly stage:string;readonly cardId?:string;readonly phase?:string;readonly reason?:string;readonly slot?:number;
  readonly readings?:readonly {readonly kind:'visual'|'short'|'full';readonly startedAt:number;readonly endedAt?:number}[];
}
export interface ReadAnalysis {
  /** Card crops the scanner looked at, by where each one ended. */
  readonly stages:Readonly<Record<string,number>>;
  /** Why crops were rejected before reading, most frequent first. */
  readonly rejected:readonly {readonly reason:string;readonly count:number}[];
  /** Per whole second of capture time: crops seen, and crops rejected in each of the four rows. */
  readonly bySecond:readonly {readonly second:number;readonly crops:number;readonly rejectedByRow:readonly number[]}[];
  /** Read passes by kind (recorded only on the live path; at most three per crop). */
  readonly reads:Readonly<Record<'visual'|'short'|'full',{readonly count:number;readonly ms:number}>>;
  /** Identified crops by the heaviest pass they needed. */
  readonly identifiedBy:Readonly<Record<'visual'|'short'|'full'|'unrecorded',number>>;
  readonly cards:number;
  /** Identified crops per card: how often the same card was read to an identity. */
  readonly identifiedCropsPerCard:{readonly mean:number;readonly max:number};
  /** Read passes that started after their card had already been identified from an earlier crop. */
  readonly afterFirstIdentity:{readonly count:number;readonly ms:number};
}

/** Where the reading work of a scan went. Observation of one run, not a fact about the input. */
export function analyzeReads(traces:readonly ReadTraceLike[]):ReadAnalysis {
  const stages:Record<string,number>={};
  const reads={visual:{count:0,ms:0},short:{count:0,ms:0},full:{count:0,ms:0}};
  const identifiedBy={visual:0,short:0,full:0,unrecorded:0};
  const perCard=new Map<string,number>(),firstIdentity=new Map<string,number>();
  const rank={visual:0,short:1,full:2} as const,rejectedReasons=new Map<string,number>(),seconds=new Map<number,{second:number;crops:number;rejectedByRow:number[]}>();
  for(const trace of traces){
    stages[trace.stage]=(stages[trace.stage]??0)+1;
    {
      const second=Math.floor(trace.time);let row=seconds.get(second);
      if(!row){row={second,crops:0,rejectedByRow:[0,0,0,0]};seconds.set(second,row);}
      row.crops++;
      if(trace.stage==='rejected'&&trace.slot!==undefined&&trace.reason!=='미보유 카드 뒷면 · 빈 슬롯')row.rejectedByRow[Math.min(3,Math.floor(trace.slot/10))]++;
    }
    if(trace.stage==='rejected')rejectedReasons.set(trace.reason??'',(rejectedReasons.get(trace.reason??'')??0)+1);
    const readings=trace.readings??[];
    for(const reading of readings){
      reads[reading.kind].count++;
      if(reading.endedAt!==undefined)reads[reading.kind].ms+=Math.max(0,reading.endedAt-reading.startedAt)*1000;
    }
    if(trace.stage!=='identified'||!trace.cardId)continue;
    perCard.set(trace.cardId,(perCard.get(trace.cardId)??0)+1);
    if(!readings.length)identifiedBy.unrecorded++;
    else identifiedBy[readings.reduce((a,b)=>rank[b.kind]>rank[a.kind]?b:a).kind]++;
    const ended=readings.reduce((latest,reading)=>Math.max(latest,reading.endedAt??reading.startedAt),-Infinity);
    if(Number.isFinite(ended)&&ended<(firstIdentity.get(trace.cardId)??Infinity))firstIdentity.set(trace.cardId,ended);
  }
  const after={count:0,ms:0};
  for(const trace of traces){
    if(!trace.cardId)continue;
    const known=firstIdentity.get(trace.cardId);
    if(known===undefined)continue;
    for(const reading of trace.readings??[])if(reading.startedAt>known){
      after.count++;if(reading.endedAt!==undefined)after.ms+=Math.max(0,reading.endedAt-reading.startedAt)*1000;
    }
  }
  const counts=[...perCard.values()];
  const round=(value:number)=>Math.round(value*10)/10;
  for(const kind of ['visual','short','full'] as const)reads[kind].ms=Math.round(reads[kind].ms);
  return {stages,rejected:[...rejectedReasons].map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count),bySecond:[...seconds.values()].sort((a,b)=>a.second-b.second),reads,identifiedBy,cards:perCard.size,
    identifiedCropsPerCard:{mean:counts.length?round(counts.reduce((a,b)=>a+b,0)/counts.length):0,max:counts.length?Math.max(...counts):0},
    afterFirstIdentity:{count:after.count,ms:Math.round(after.ms)}};
}

export interface ReadProfileLike {readonly stage:string;readonly identified:boolean;readonly spans:Readonly<Record<string,number>>}
export interface ReadProfileGroup {
  readonly stage:string;readonly identified:boolean;readonly reads:number;
  /** Mean milliseconds per read, by span, and their sum. */
  readonly meanMs:Readonly<Record<string,number>>;readonly totalMeanMs:number;
}
/** Mean time of each part of a card read, grouped by read kind and outcome. */
export function summarizeReadProfiles(profiles:readonly ReadProfileLike[]):readonly ReadProfileGroup[] {
  const groups=new Map<string,{stage:string;identified:boolean;reads:number;sums:Record<string,number>}>();
  for(const profile of profiles){
    const key=profile.stage+'/'+profile.identified;
    let group=groups.get(key);
    if(!group){group={stage:profile.stage,identified:profile.identified,reads:0,sums:{}};groups.set(key,group);}
    group.reads++;
    for(const [name,ms] of Object.entries(profile.spans))group.sums[name]=(group.sums[name]??0)+ms;
  }
  const round=(value:number)=>Math.round(value*10)/10;
  return [...groups.values()].sort((a,b)=>b.reads-a.reads).map(group=>{
    const meanMs=Object.fromEntries(Object.entries(group.sums).map(([name,sum])=>[name,round(sum/group.reads)]));
    return {stage:group.stage,identified:group.identified,reads:group.reads,meanMs,
      totalMeanMs:round(Object.values(group.sums).reduce((a,b)=>a+b,0)/group.reads)};
  });
}
