import type {ScannerState} from './scanner-state';
import type {RowScanSnapshot} from './row-scan';
import type {ScannedCard} from '../recognition/recognizer-types';

/** The scanner state for one snapshot of the row-centred scan (pure; see row-scanner.ts).
 *
 * Completion. The receipt the app requires is issued only when everything was read (`done`) and
 * all of these hold; any one missing leaves the scan incomplete with the reason in the status:
 *
 * - the displayed total was read, and read again from the last frame with the same value;
 * - the cards named and the cards confirmed both equal that total;
 * - nothing waits to be read;
 * - while cards are missing, no cell was seen without being named (such a cell may be a missing card).
 *
 * Once as many different cards as the displayed total are named, a cell seen without being named
 * cannot be another card: it is a card already read, seen covered (a game notice over the list
 * does this), or no card. It is then reported and does not block completion (decision of
 * 2026-11-13). What this leaves open is the same as for passed-over frames: a value that changed
 * and was shown only covered keeps its earlier reading.
 *
 * Frames dropped from the line of waiting frames do not block completion (decision of
 * 2026-11-13): a share delivers more frames than can be read, so frames are passed over on every
 * real share, as the scanner's own loop never sees the frames the browser did not hand it. They
 * are reported as missed frames. What this leaves open: a value that changed during the scan and
 * was shown only in passed-over frames, never again, keeps its earlier reading.
 *
 * A matching count alone never completes the scan: every card's values must be confirmed by this
 * scan's observations, and the total must be the one shown at the end. */
const collator=new Intl.Collator('ko');

function shownCards(cards:readonly ScannedCard[]):ScannedCard[] {
  return cards.map(card=>({...card,review:[...card.review]})).sort((a,b)=>collator.compare(a.name,b.name));
}

/** Whether as many different cards as the displayed total are named: no cell can then be another card. */
function rowAllNamed(snapshot:RowScanSnapshot):boolean {
  return snapshot.expected!==null&&snapshot.expected>0&&snapshot.cards.length===snapshot.expected&&
    new Set(snapshot.cards.map(card=>card.id)).size===snapshot.expected;
}

/** Why the finished row-centred scan is not complete; empty when it is. */
export function rowCompletionGaps(snapshot:RowScanSnapshot):string[] {
  const gaps:string[]=[];
  if(snapshot.phase!=='done'){gaps.push('판독 진행 중');return gaps;}
  const expected=snapshot.expected;
  if(expected===null||!Number.isSafeInteger(expected)||expected<=0)gaps.push('표시 수량 미확인');
  else if(snapshot.finalExpected===null)gaps.push('끝에서 표시 수량을 다시 읽지 못함');
  else if(snapshot.finalExpected!==expected)gaps.push(`표시 수량이 바뀜 (${expected} → ${snapshot.finalExpected})`);
  if(expected!==null){
    if(snapshot.cards.length<expected)gaps.push(`${expected-snapshot.cards.length}종 부족`);
    else if(snapshot.cards.length>expected)gaps.push('읽은 카드가 표시 수량보다 많음');
    else if(snapshot.confirmed<expected)gaps.push(`${expected-snapshot.confirmed}종 각성·장수 확인 필요`);
  }
  if(snapshot.unidentifiedCells>0&&!rowAllNamed(snapshot))gaps.push(`이름을 읽지 못한 칸 ${snapshot.unidentifiedCells}개`);
  if(snapshot.waitingFrames>0||snapshot.waitingReads>0)gaps.push('판독 작업 미완료');
  return gaps;
}

/** Whether the share may be ended now: everything the displayed total asks for is confirmed and
 * that total was read again while it was. The caller still waits for this to hold for a while,
 * and completion is decided only after the end, from the total of the last frame. */
export function rowCanStopSharing(snapshot:RowScanSnapshot):boolean {
  return snapshot.phase==='capture'&&snapshot.expected!==null&&snapshot.expected>0&&snapshot.freshExpected===snapshot.expected&&
    rowAllNamed(snapshot)&&snapshot.confirmed===snapshot.expected&&snapshot.waitingReads===0;
}

/** Below this interface scale (1920x1080 is 0.75) the count digits are about 8 pixels high and
 * some cannot be read at all, even from a still frame (docs/dev-recording.md, 1600x900). */
export const SMALL_SCREEN_SCALE=.75;
/** What to tell the person when the shared picture is smaller than 1920x1080 at the interface
 * scale, or null. Values that cannot be read stay unconfirmed; nothing is guessed. */
export function smallScreenNotice(width:number,height:number,scale:number|null):string|null {
  if(scale===null||scale>=SMALL_SCREEN_SCALE-.005)return null;
  return `게임 화면이 작습니다(공유 화면 ${width}×${height}). 카드 숫자가 작아 일부 각성·장수를 읽지 못할 수 있어요. 게임 해상도를 1920×1080 이상으로 하면 모두 읽을 수 있습니다.`;
}

/** Once every card is named, cells seen but not named are repeats of cards already read (see
 * `duplicateUnidentifiedObservations`): their rows are not asked for again and count as read on
 * the map. Cards whose values are still open stay highlighted; a complete scan asks for nothing. */
export function settledGuidance(guidance:RowScanSnapshot['guidance'],complete:boolean):NonNullable<ScannerState['listGuidance']> {
  const map=guidance.map;
  if(!map)return complete?{asks:[],notes:[]}:{asks:[...guidance.asks],notes:[...guidance.notes]};
  const repeats=new Set(map.targets.filter(target=>target.kind==='cell').map(target=>target.row));
  const rows=new Set<number>();
  for(const run of map.done??[])for(let row=run.from;row<=run.to;row++)rows.add(row);
  for(const row of repeats)rows.add(row);
  // Every card of the displayed total is confirmed: all the rows holding cards were read, also the
  // ones scrolled past too fast to be placed while sharing.
  if(complete)for(let row=0;row<(map.emptyFrom??map.lockedFrom??map.totalRows);row++)rows.add(row);
  const done:{from:number;to:number}[]=[];
  for(const row of [...rows].sort((a,b)=>a-b)){const last=done[done.length-1];if(last&&last.to===row-1)last.to=row;else done.push({from:row,to:row});}
  // Complete: every card is confirmed, so no row is left to show again.
  const targets=complete?[]:map.targets.filter(target=>target.kind!=='cell');
  return {asks:complete?[]:[...guidance.asks],notes:complete?[]:[...guidance.notes],
    map:{...map,targets,done,direction:targets.length?map.direction:null}};
}

export function rowScannerState(snapshot:RowScanSnapshot):ScannerState {
  // One frame is always taken ahead of the one being read; it is not a backlog.
  const done=snapshot.phase==='done',queued=snapshot.waitingReads+(done?snapshot.waitingFrames:Math.max(0,snapshot.waitingFrames-1));
  const gaps=done?rowCompletionGaps(snapshot):[];
  const complete=done&&gaps.length===0;
  const covered=rowAllNamed(snapshot)?snapshot.unidentifiedCells:0;
  // While the scan runs, every card of the displayed total is named and confirmed: no row is left to
  // show again (the map says so at once; whether the scan is complete is still decided at the end).
  // Guidance only, so it follows the count the window shows; the automatic end uses `confirmed`.
  const allConfirmed=!done&&snapshot.expected!==null&&snapshot.cards.length===snapshot.expected&&
    (snapshot.displayConfirmed??snapshot.confirmed)===snapshot.expected;
  // The person sees what is done or missing. Frames passed over and cells seen covered after
  // everything was named are diagnostics: they stay in their own fields (liveMissedFrames,
  // duplicateUnidentifiedObservations), not in the status line.
  const status=done?`입력 처리 완료 · ${complete?'표시 수량 일치':gaps.join(' · ')}`
    :snapshot.phase==='verifying'?'판독 결과 검증 중'
    :queued>0?`카드 스캔 중 · ${queued}개 판독 대기`:'카드 스캔 중';
  const expected=snapshot.expected;
  // What the window shows; completion and the automatic end use `confirmed`.
  const shown=done?snapshot.confirmed:snapshot.displayConfirmed??snapshot.confirmed;
  return {
    status,
    percent:done?100:expected?Math.min(99,Math.floor(shown/expected*100))
      :snapshot.cards.length?Math.min(99,Math.floor(shown/snapshot.cards.length*100)):0,
    sampled:snapshot.frames,stable:snapshot.locatedFrames,
    expected,capacity:snapshot.capacity,
    ...(snapshot.growthPoints?{growthPoints:{current:snapshot.growthPoints.current,maximum:snapshot.growthPoints.maximum}}:{}),
    cards:shownCards(snapshot.cards),
    currentRunNames:snapshot.cards.length,currentRunRead:shown,
    // Cells seen but not named are unresolved observations (there are no pictures of them to list)
    // while cards are missing; once every card is named they are repeats of cards already read.
    unresolvedObservations:covered>0?0:snapshot.unidentifiedCells,unresolvedFieldChanges:0,
    ...(covered>0?{duplicateUnidentifiedObservations:covered}:{}),
    located:snapshot.located,unreadable:0,queued,activeReadings:snapshot.waitingReads>0?1:0,
    // Frames passed over in the line are missed frames, not frames taken and lost (see above).
    droppedFrames:0,liveMissedFrames:snapshot.droppedFrames,liveInput:'track',
    workPhase:snapshot.phase==='capture'?'capture':snapshot.phase==='reading'?'reading':snapshot.phase==='verifying'?'verifying':'cleanup',
    unidentified:[],
    activity:snapshot.activity.map(item=>({...item})),
    listGuidance:covered>0||complete||allConfirmed?settledGuidance(snapshot.guidance,complete||allConfirmed)
      :{asks:[...snapshot.guidance.asks],notes:[...snapshot.guidance.notes],...(snapshot.guidance.map?{map:snapshot.guidance.map}:{})},
    ...(complete&&expected!==null?{completionReceipt:{version:1 as const,mode:'ended' as const,expected,finalExpected:snapshot.finalExpected!}}:{}),
  };
}
