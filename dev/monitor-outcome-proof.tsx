import {useLayoutEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {ThemeProvider,createTheme} from '@mui/material/styles';
import {ScanMonitor,ScanMonitorPanel} from '../src/features/card-scanner/ui/ScanMonitor';
import {ScanReadProgress} from '../src/features/card-scanner/ui/ScanReadProgress';
import {createScanMonitorStore} from '../src/features/card-scanner/ui/scan-monitor-store';
import type {ScanMonitorInput} from '../src/features/card-scanner/ui/scan-monitor-store';
import {scanMonitorOutcome} from '../src/features/card-scanner/session/scan-monitor-outcome';
import type {ScanGridSnapshot} from '../src/features/card-scanner/session/scan-grid';
import styles from '../src/features/card-scanner/scan-monitor.css?inline';

const names=['판독 완료','최신 필드 미확정','미식별 남음','1종 누락','입력 누락 3건','중단','대기','다시 공유 중','최근 화면 혼합 상태','중간 위치 추정','공유 중 마지막 화면','공유 중 장수 확인','공유 중 미식별','보관함 충돌'] as const;
const params=new URLSearchParams(location.search),mode=params.get('theme')==='dark'?'dark':'light';
document.documentElement.dataset.theme=mode;
if(params.get('narrow')==='1')document.documentElement.dataset.narrow='1';
const theme=createTheme({palette:{mode},typography:{fontFamily:"'Segoe UI','Malgun Gothic',sans-serif",fontSize:13}});
type Scenario=typeof names[number];
function fixture(scenario:Scenario):{state:ScanMonitorInput|null;busy:boolean;sharing:boolean}{
 if(scenario==='대기')return {state:null,busy:false,sharing:false};
 const read=scenario==='중단'?0:scenario==='1종 누락'||scenario==='입력 누락 3건'?384:385,unresolved=scenario==='미식별 남음'||scenario==='다시 공유 중'?14:scenario==='1종 누락'?8:scenario==='공유 중 미식별'?1:0;
 const grid:ScanGridSnapshot={located:true,totalRows:55,estimatedTop:36,
  cells:Array.from({length:40},(_,index)=>({status:index+350<read?'read':'unknown',row:36+Math.floor(index/10)})),
  inventory:Array.from({length:550},(_,index)=>({status:index<read?'read':'unknown',row:Math.floor(index/10)+1}))};
 if(scenario==='중간 위치 추정'){
  grid.liveTracking=true;grid.liveTop=20;grid.estimatedTop=20;
  grid.cells=Array.from({length:40},()=>({status:'unknown' as const}));
  grid.inventory=Array.from({length:195},(_,i)=>({status:i===190?'read' as const:'unknown' as const}));
  grid.recentFrame={frame:1,capturedTop:20,cells:Array.from({length:40},(_,i)=>({status:i===0?'reading' as const:i===1?'waiting' as const:i===2?'read' as const:'unknown' as const}))};
 }
 if(scenario==='최근 화면 혼합 상태'){
  grid.recentFrame={frame:436,cells:Array.from({length:40},(_,i)=>({status:i<18?'read':i<20?'waiting':i===20?'reading':i===21?'review':i<24?'empty':'unknown'}))};
  // Intentionally disagreeing historical summary must not override visible cells.
  grid.recent={captured:40,read:18,waiting:22,reading:0,review:0};
 }
 const finalView=scenario==='공유 중 마지막 화면'||scenario==='공유 중 장수 확인'||scenario==='공유 중 미식별';
 if(finalView){grid.liveTracking=true;grid.liveTop=52;grid.estimatedTop=52;
  grid.cells=Array.from({length:40},(_,i)=>({status:'empty' as const,row:52+Math.floor(i/10)}));}
 const gate=scenario==='공유 중 장수 확인'?'fields':scenario==='공유 중 미식별'?'latest-observations':'inventory';
 return {busy:finalView||scenario==='다시 공유 중'||scenario==='최근 화면 혼합 상태'||scenario==='중간 위치 추정',sharing:finalView||scenario==='다시 공유 중'||scenario==='중간 위치 추정',state:{grid,currentRunRead:finalView&&scenario==='공유 중 마지막 화면'?350:read,expected:scenario==='중단'?null:385,capacity:450,
  queued:0,activeReadings:0,droppedFrames:scenario==='입력 누락 3건'?3:0,unresolvedObservations:unresolved,interrupted:scenario==='중단'?'cancelled':undefined,sampled:scenario==='중단'?0:30,
  ...(finalView?{autoCompletionDiagnostic:{gate,expected:385,identities:read,names:read,fields:scenario==='공유 중 장수 확인'?384:read,
   unresolved:scenario==='공유 중 미식별'?1:0,inputPending:false,headerAvailable:true,headerAttempts:0,headerMismatches:0,headerErrors:0}}:{}),
  unresolvedFieldChanges:scenario==='최신 필드 미확정'?2:0,
  ...(scenario==='보관함 충돌'?{headerConflict:true}:{}),
  unidentified:Array.from({length:unresolved},(_,index)=>({image:'synthetic-display-fixture',time:index,pending:false}))}};
}
const store=createScanMonitorStore();store.publish(fixture('미식별 남음').state!);
let syntheticInput=0;
// oxlint-disable-next-line react/only-export-components -- standalone dev proof uses the production panel/store.
function Proof(){
 const [scenario,setScenario]=useState<Scenario>('미식별 남음'),[mode,setMode]=useState('공통 저장소'),[target,setTarget]=useState('패널'),
  [delayed,setDelayed]=useState('없음'),[busyOverride,setBusyOverride]=useState<boolean|null>(null),[showLiveGuidance,setShowLiveGuidance]=useState(false);
 const selected=useMemo(()=>fixture(scenario),[scenario]),live=useSyncExternalStore(store.subscribe,store.getSnapshot);
 useLayoutEffect(()=>{if(selected.state){store.publish(selected.state);if(selected.state.autoCompletionDiagnostic)store.publishAutoCompletion(selected.state.autoCompletionDiagnostic);}else store.clear();},[selected]);
 const state=delayed==='이전 완료'?fixture('판독 완료').state:delayed==='이전 누락'?fixture('1종 누락').state:
  mode==='원본 상태'?selected.state:live;
 const busy=busyOverride??selected.busy,sharing=selected.sharing;
 // The expected projection uses the store. The actual wrapper below receives
 // deliberately stale full props so its DOM, not this JSON, proves precedence.
 const outcome=scanMonitorOutcome(target==='실제 진행창'?live:state,{busy,sharing});
 const reset=()=>{store.clear();setScenario('대기');setDelayed('없음');setBusyOverride(null);setShowLiveGuidance(false);};
 const showSyntheticObstruction=(withInputLoss:boolean)=>{
  store.clear();store.publish(fixture('다시 공유 중').state!);
  setScenario('다시 공유 중');setTarget('실제 진행창');setDelayed('없음');setBusyOverride(true);setShowLiveGuidance(true);
  if(withInputLoss)store.publishAutoCompletion({gate:'input-dropped',expected:385,identities:0,names:0,fields:0,
   unresolved:null,inputPending:false,headerAvailable:false,headerAttempts:0,headerMismatches:0,headerErrors:0});
  const now=performance.now(),id=++syntheticInput;
  store.publishLiveObstructionHint({sessionId:'synthetic-proof',inputId:id,frameId:id,captureTime:now/1000,expiresAtMs:now+2000});
 };
 return <ThemeProvider theme={theme}><style>{styles}</style><h1>진행창 표시 검사</h1><p>합성 표시 시나리오입니다. 실제 스캔 정확도나 완료 판정의 근거가 아닙니다.</p>
  <label>표시 시나리오 <select aria-label="표시 시나리오" value={scenario} onChange={event=>{store.clear();if(showLiveGuidance)setShowLiveGuidance(false);setScenario(event.target.value as Scenario);setBusyOverride(null);}}>{names.map(name=><option key={name}>{name}</option>)}</select></label>
  <label>전달 방식 <select aria-label="전달 방식" value={mode} onChange={event=>setMode(event.target.value)}><option>공통 저장소</option><option>원본 상태</option></select></label>
  <label>표시 대상 <select aria-label="표시 대상" value={target} onChange={event=>setTarget(event.target.value)}><option>패널</option><option>실제 진행창</option></select></label>
  <label>지연된 전체 상태 <select aria-label="지연된 전체 상태" value={delayed} onChange={event=>{
   setDelayed(event.target.value);if(event.target.value!=='없음'){setTarget('실제 진행창');setBusyOverride(true);}
  }}><option>없음</option><option>이전 완료</option><option>이전 누락</option></select></label>
  <label><input aria-label="처리 중 상태" type="checkbox" checked={busy} onChange={event=>setBusyOverride(event.target.checked)}/>처리 중 상태</label>
  <button onClick={reset}>새 입력으로 초기화</button>
  <button onClick={()=>showSyntheticObstruction(false)}>합성 가림 안내 2초</button>
  <button onClick={()=>showSyntheticObstruction(true)}>합성 가림 + 입력 누락</button>
  {showLiveGuidance&&<div aria-label="메인 진행 표시"><ScanReadProgress completed={0} expected={385} store={store} startedAt={0} phase="capture" autoCompletionEnabled/></div>}
  {delayed!=='없음'&&<p>이전 전체 상태를 props에 고정합니다. 처리 중 상태를 끄면 최신 저장소와 상반된 이전 결과가 종료 표시를 덮는지 확인할 수 있습니다.</p>}
  <div id="monitor-host">{target==='실제 진행창'
   ?<ScanMonitor state={state} store={store} busy={busy} sharing={sharing} onStop={()=>{setScenario('중단');setBusyOverride(null);}}/>
   :<ScanMonitorPanel state={state} busy={busy} sharing={sharing} onStop={()=>{setScenario('중단');setBusyOverride(null);}}/>}</div>
  <pre aria-label="표시 판정">{JSON.stringify(outcome,null,2)}</pre>
 </ThemeProvider>;
}
createRoot(document.querySelector('#root')!).render(<Proof/>);
