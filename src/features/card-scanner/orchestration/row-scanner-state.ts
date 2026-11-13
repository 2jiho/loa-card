import type {ScannerState} from './scanner';
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

export function rowScannerState(snapshot:RowScanSnapshot):ScannerState {
  // One frame is always taken ahead of the one being read; it is not a backlog.
  const done=snapshot.phase==='done',queued=snapshot.waitingReads+(done?snapshot.waitingFrames:Math.max(0,snapshot.waitingFrames-1));
  const gaps=done?rowCompletionGaps(snapshot):[];
  const complete=done&&gaps.length===0;
  const covered=rowAllNamed(snapshot)?snapshot.unidentifiedCells:0;
  const passed=(covered>0?` · 가려진 채 보인 칸 ${covered}개(이미 읽은 카드)`:'')+(snapshot.droppedFrames>0?` · 읽지 않고 넘긴 화면 ${snapshot.droppedFrames}장`:'');
  const status=done?`입력 처리 완료 · ${complete?'표시 수량 일치':gaps.join(' · ')}${passed} · 줄 중심 경로(개발)`
    :snapshot.phase==='verifying'?'판독 결과 검증 중'
    :queued>0?`카드 스캔 중 · ${queued}개 판독 대기`:'카드 스캔 중';
  const expected=snapshot.expected;
  return {
    status,
    percent:done?100:expected?Math.min(99,Math.floor(snapshot.confirmed/expected*100))
      :snapshot.cards.length?Math.min(99,Math.floor(snapshot.confirmed/snapshot.cards.length*100)):0,
    sampled:snapshot.frames,stable:snapshot.locatedFrames,
    expected,capacity:snapshot.capacity,
    ...(snapshot.growthPoints?{growthPoints:{current:snapshot.growthPoints.current,maximum:snapshot.growthPoints.maximum}}:{}),
    cards:shownCards(snapshot.cards),
    currentRunNames:snapshot.cards.length,currentRunRead:snapshot.confirmed,
    // Cells seen but not named are unresolved observations (there are no pictures of them to list)
    // while cards are missing; once every card is named they are repeats of cards already read.
    unresolvedObservations:covered>0?0:snapshot.unidentifiedCells,unresolvedFieldChanges:0,
    ...(covered>0?{duplicateUnidentifiedObservations:covered}:{}),
    located:snapshot.located,unreadable:0,queued,activeReadings:snapshot.waitingReads>0?1:0,
    // Frames passed over in the line are missed frames, not frames taken and lost (see above).
    droppedFrames:0,liveMissedFrames:snapshot.droppedFrames,liveInput:'track',
    workPhase:snapshot.phase==='capture'?'capture':snapshot.phase==='reading'?'reading':snapshot.phase==='verifying'?'verifying':'cleanup',
    unidentified:[],
    listGuidance:{asks:[...snapshot.guidance.asks],notes:[...snapshot.guidance.notes]},
    ...(complete&&expected!==null?{completionReceipt:{version:1 as const,mode:'ended' as const,expected,finalExpected:snapshot.finalExpected!}}:{}),
  };
}
