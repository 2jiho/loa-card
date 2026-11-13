import type {ScannerState} from './scanner';
import {runRowScan} from './row-scan';
import type {RowScanSnapshot} from './row-scan';
import {rowScannerState} from './row-scanner-state';

/** The row-centred scan behind the scanner's interface (docs/scanner-live-redesign.md, section 13).
 *
 * Development only for now: `runScanner` calls this instead of its own loop when asked to
 * (`debug.engine: 'row'`), so the app, the watchdog and the development recorder run unchanged
 * around it. It reads a live screen share and publishes the scanner's state shape.
 *
 * It reads the displayed total and issues the completion receipt under the conditions of
 * row-scanner-state.ts. What it does not do yet: it lists no pictures of unidentified observations
 * (only their count), passes no guidance to the app, and starts from an empty list (it is not
 * seeded with saved cards). */
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
