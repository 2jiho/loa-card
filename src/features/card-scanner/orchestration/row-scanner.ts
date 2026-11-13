import type {ScannerState} from './scanner';
import type {ScannedCard} from '../recognition/recognizer-types';
import {runRowScan} from './row-scan';
import type {RowScanSnapshot} from './row-scan';

/** The row-centred scan behind the scanner's interface (docs/scanner-live-redesign.md, section 13).
 *
 * Development only for now: `runScanner` calls this instead of its own loop when asked to
 * (`debug.engine: 'row'`), so the app, the watchdog and the development recorder run unchanged
 * around it. It reads a live screen share and publishes the scanner's state shape.
 *
 * What it does not do yet, and therefore never claims: it reads no displayed total (`expected`
 * stays null), issues no completion receipt, reports no unidentified observations and starts
 * from an empty list (it is not seeded with saved cards). The app shows its cards and marks the
 * scan incomplete. */
const collator=new Intl.Collator('ko');

function shownCards(cards:readonly ScannedCard[]):ScannedCard[] {
  return cards.map(card=>({...card,review:[...card.review]})).sort((a,b)=>collator.compare(a.name,b.name));
}

/** The scanner state for one snapshot of the row-centred scan. */
export function rowScannerState(snapshot:RowScanSnapshot):ScannerState {
  const queued=snapshot.waitingFrames+snapshot.waitingReads,done=snapshot.phase==='done';
  const status=done?'입력 처리 완료 · 표시 수량 미확인 · 줄 중심 경로(개발)'
    :snapshot.phase==='verifying'?'판독 결과 검증 중'
    :queued>0?`카드 스캔 중 · ${queued}개 판독 대기`:'카드 스캔 중';
  return {
    status,
    // There is no displayed total to measure progress against: confirmed over named cards.
    percent:done?100:snapshot.cards.length?Math.min(99,Math.floor(snapshot.confirmed/snapshot.cards.length*100)):0,
    sampled:snapshot.frames,stable:snapshot.locatedFrames,
    expected:null,capacity:null,
    cards:shownCards(snapshot.cards),
    currentRunNames:snapshot.cards.length,currentRunRead:snapshot.confirmed,
    located:snapshot.located,unreadable:0,queued,activeReadings:snapshot.waitingReads>0?1:0,
    droppedFrames:snapshot.droppedFrames,liveInput:'track',
    workPhase:snapshot.phase==='capture'?'capture':snapshot.phase==='reading'?'reading':snapshot.phase==='verifying'?'verifying':'cleanup',
    unidentified:[],
  };
}

export async function runRowScannerInternal(options:{video:HTMLVideoElement;signal:AbortSignal;
  update:(state:ScannerState)=>void;onReady?:()=>void;
  /** A frame the card window was found in (the development recorder keeps those spans). */
  onLocated?:()=>void}):Promise<void> {
  const {video,signal,update}=options;
  const track=(video.srcObject as MediaStream|null)?.getVideoTracks()[0];
  if(!track)throw Error('공유 화면의 비디오 트랙을 확인할 수 없습니다.');
  // The share ends when its track does (the person stops sharing); an abort ends the wait too
  // and the scan loop then throws on the aborted signal.
  // A track stopped by the page itself fires no `ended` event, so its state is also polled.
  const ended=new Promise<void>(resolve=>{
    const live=()=>track.readyState==='live'&&(video.srcObject as MediaStream|null)?.getVideoTracks().includes(track)===true;
    const timer=setInterval(()=>{if(!live())finish();},200);
    const finish=()=>{clearInterval(timer);resolve();};
    if(!live())finish();
    track.addEventListener('ended',finish,{once:true});
    signal.addEventListener('abort',finish,{once:true});
  });
  update({status:'인식 엔진 준비 중',percent:0,sampled:0,stable:0,expected:null,capacity:null,cards:[],
    located:false,unreadable:0,queued:0,droppedFrames:0,liveInput:'track',workPhase:'capture',unidentified:[]});
  let last:RowScanSnapshot|undefined;
  await runRowScan({target:video,signal,relativeTime:true,
    input:{start:()=>ended,dispose:()=>{}},
    onReady:options.onReady,onLocated:options.onLocated,
    onSnapshot:snapshot=>{last=snapshot;if(!signal.aborted)update(rowScannerState(snapshot));}});
  signal.throwIfAborted();
  if(last&&last.phase!=='done')update(rowScannerState({...last,phase:'done'}));
}
