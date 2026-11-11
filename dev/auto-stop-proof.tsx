import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ScanReadProgress} from '../src/features/card-scanner/ui/ScanReadProgress';
import {createScanMonitorStore} from '../src/features/card-scanner/ui/scan-monitor-store';
import type {AutoCompletionGate} from '../src/features/card-scanner/session/auto-completion-diagnostics';
import '../src/App.css';

// A synthetic rendering fixture; it cannot confirm actual screen-share timing.
const store=createScanMonitorStore();
store.publish({currentRunRead:394,expected:394,capacity:450,grid:undefined,interrupted:undefined});
const gates:AutoCompletionGate[]=['latest-observations','input','metadata','hold','header-reading','header-mismatch','header-error'];
const startedAt=performance.now();
// oxlint-disable-next-line react/only-export-components -- standalone dev proof entry.
function Proof(){
 const [enabled,setEnabled]=useState(true);
 function select(gate:AutoCompletionGate){store.publishAutoCompletion({gate,expected:394,identities:394,names:394,fields:394,
  unresolved:gate==='latest-observations'?13:0,inputPending:gate==='input',headerAvailable:true,
  headerAttempts:0,headerMismatches:0,headerErrors:0});}
 return <main style={{maxWidth:640,margin:'2rem auto'}}><h1>자동 종료 안내 검사</h1>
  <p>합성 상태로 진행 문구만 검사합니다. 실제 스캔 결과가 아닙니다.</p>
  <div>{gates.map(gate=><button key={gate} onClick={()=>select(gate)}>{gate}</button>)}</div>
  <button onClick={()=>setEnabled(value=>!value)}>{enabled?'공유 종료':'공유 중'}</button>
  <ScanReadProgress completed={394} expected={394} store={store} phase={enabled?'capture':'reading'} startedAt={startedAt} autoCompletionEnabled={enabled}/>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Proof/>);
