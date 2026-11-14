import type {ScannerState} from './scanner-state';
import {runRowScan} from './row-scan';
import type {RowScanSnapshot} from './row-scan';
import type {PreparedScanner} from '../session/scanner-preparation';
import {rowCanStopSharing,rowScannerState,smallScreenNotice} from './row-scanner-state';
import {stopCompletedShare} from '../session/auto-completion';
import {inputScale} from '../acquisition/detector';

/** The row-centred scan behind the scanner's interface (docs/scanner-live-redesign.md, section 13).
 *
 * The scan of every screen share: `runScanner` (orchestration/scanner.ts) runs it under the scan
 * guard and the name operation, with the development recorder around it. It reads a live screen share and
 * publishes the scanner's state shape.
 *
 * It reads the displayed total and issues the completion receipt under the conditions of
 * row-scanner-state.ts, and passes the list guidance (rows to show again, the list map) and a
 * small-screen notice to the app. It lists no pictures of unidentified observations (only their
 * count) and starts from an empty list: it is not seeded with saved cards, so this scan's result
 * never rests on an earlier list (the app keeps the earlier list when the scan is not complete). */
export async function runRowScannerInternal(options:{video:HTMLVideoElement;signal:AbortSignal;
  update:(state:ScannerState)=>void;onReady?:()=>void;
  /** A frame the card window was found in (the development recorder keeps those spans). */
  onLocated?:()=>void;
  /** Readers prepared before the share; their owner releases them. */
  prepared?:PreparedScanner}):Promise<void> {
  const {video,signal,update}=options;
  const track=(video.srcObject as MediaStream|null)?.getVideoTracks()[0];
  if(!track)throw Error('공유 화면의 비디오 트랙을 확인할 수 없습니다.');
  // The share ends when its track does (the person stops sharing); an abort ends the wait too
  // and the scan loop then throws on the aborted signal.
  // A track stopped by the page itself fires no `ended` event, so its state is also polled.
  let endShare=()=>{};
  const ended=new Promise<void>(resolve=>{
    const live=()=>track.readyState==='live'&&(video.srcObject as MediaStream|null)?.getVideoTracks().includes(track)===true;
    const timer=setInterval(()=>{if(!live())finish();},200);
    const finish=()=>{clearInterval(timer);resolve();};
    endShare=finish;
    if(!live())finish();
    track.addEventListener('ended',finish,{once:true});
    signal.addEventListener('abort',finish,{once:true});
  });
  update({status:'인식 엔진 준비 중',percent:0,sampled:0,stable:0,expected:null,capacity:null,cards:[],
    located:false,unreadable:0,queued:0,droppedFrames:0,liveInput:'track',workPhase:'capture',unidentified:[]});
  let last:RowScanSnapshot|undefined,lastState:ScannerState|undefined;
  // As the scanner does: when everything is confirmed and stays so for a second, the share is
  // ended here, and the scan finishes from what it has.
  let readySince:number|null=null,autoStopped=false;
  const state=(snapshot:RowScanSnapshot)=>{
    const notice=smallScreenNotice(video.videoWidth,video.videoHeight,inputScale(video.videoWidth,video.videoHeight));
    return {...rowScannerState(snapshot),...(autoStopped?{autoStopped:true}:{}),...(notice?{resolutionNotice:notice}:{})};
  };
  const pool=options.prepared;
  await runRowScan({target:video,signal,relativeTime:true,
    ...(pool&&pool.readers[0]?{prepared:{acquisition:pool.acquisition,visuals:pool.visuals,recognizer:pool.readers[0]}}:{}),
    input:{start:()=>ended,dispose:()=>{}},
    onReady:options.onReady,onLocated:options.onLocated,
    // The screen's place on the list map follows each arriving frame; the rest of the state is the last snapshot.
    onPosition:row=>{
      const map=lastState?.listGuidance?.map;
      if(!lastState||!map||signal.aborted||last?.phase!=='capture')return;
      lastState={...lastState,listGuidance:{...lastState.listGuidance!,map:{...map,currentRow:row}}};
      update(lastState);
    },
    onSnapshot:snapshot=>{
      last=snapshot;
      if(signal.aborted)return;
      if(!autoStopped){
        if(!rowCanStopSharing(snapshot))readySince=null;
        else if(readySince===null)readySince=performance.now();
        else if(performance.now()-readySince>=1000){
          autoStopped=true;
          const stream=video.srcObject as MediaStream|null;
          if(stream)stopCompletedShare(stream,endShare);else endShare();
        }
      }
      lastState=state(snapshot);
      update(lastState);
    }});
  signal.throwIfAborted();
  if(last&&last.phase!=='done')update(state({...last,phase:'done'}));
}
