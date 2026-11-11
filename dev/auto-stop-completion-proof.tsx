import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AutoCompletionHold,canStopSharing} from '../src/features/card-scanner/session/auto-completion';
import type {CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';
import {FinishTimer} from '../src/features/card-scanner/session/finish-timing';

// Synthetic state harness; it exercises the production completion decision and
// timer functions, not a real media stream, OCR, or input latency measurement.
type Scenario='complete'|'unresolved'|'dropped'|'name';
const labels:Record<Scenario,string>={complete:'완료(자동 종료 경로)',unresolved:'미확정 1건',dropped:'입력 누락 1건',name:'이름 미확인'};
const ids=['a','b','c','d'];
function fixture():CaptureCompletion {
 return {expected:4,finalExpected:4,unresolved:0,dropped:0,
  cards:ids.map(id=>({id,name:`카드 ${id}`,awakening:0,extraCopies:0,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1})),
  latest:new Map(ids.map(id=>[id,1])),confirmedNames:new Map(ids.map(id=>[id,1])),
  confirmed:new Map(ids.map(id=>[id,1])),inputSettled:true,headerAvailable:true,fieldChangesSettled:true};
}
interface Measured {lastCardInputMs:number;autoStoppedMs:number;afterLastIdentifiedToAutoStopMs:number;
 finishedMs:number;afterLastCardMs:number;identifiedCaptureWithinTarget:boolean;
 goalWithinTarget:null;sufficientInputVerified:false}
interface Result {scenario:Scenario;canStop:boolean;holdFirst:boolean;holdSecond:boolean;measured:Measured|null}
async function runScenario(scenario:Scenario):Promise<Result>{
 const input=fixture();
 if(scenario==='unresolved')input.unresolved=1;
 if(scenario==='dropped')input.dropped=1;
 if(scenario==='name')input.cards=[{...input.cards[0],review:['이름 확인']},...input.cards.slice(1)];
 const canStop=canStopSharing(input);
 const hold=new AutoCompletionHold(),timer=new FinishTimer();
 const start=performance.now();
 // All synthetic captures share one clock start; the measured delay is the
 // production one-second stable hold, not an OCR or input latency.
 for(const id of ids)timer.record(id,start);
 const coverage=timer.coverage(ids,4,performance.now());
 const holdFirst=hold.observe(input,performance.now());
 await new Promise<void>(resolve=>setTimeout(resolve,1100));
 const holdSecond=hold.observe(input,performance.now());
 let measured:Measured|null=null;
 if(canStop&&holdSecond&&coverage){
  const stopped=timer.stopSharing(coverage,performance.now());
  const finished=timer.finish(stopped,performance.now());
  measured={lastCardInputMs:finished.lastCardInputMs,autoStoppedMs:finished.autoStoppedMs!,
   afterLastIdentifiedToAutoStopMs:finished.afterLastIdentifiedToAutoStopMs!,
   finishedMs:finished.finishedMs!,afterLastCardMs:finished.afterLastCardMs!,
   identifiedCaptureWithinTarget:finished.identifiedCaptureWithinTarget!,
   goalWithinTarget:finished.goalWithinTarget,sufficientInputVerified:finished.sufficientInputVerified};
 }
 return {scenario,canStop,holdFirst,holdSecond,measured};
}
// oxlint-disable-next-line react/only-export-components -- standalone dev proof entry.
function Proof(){
 const [result,setResult]=useState<Result|null>(null),[running,setRunning]=useState(false);
 async function run(scenario:Scenario){
  setRunning(true);
  setResult(await runScenario(scenario));
  setRunning(false);
 }
 return <main style={{maxWidth:760,margin:'1rem auto',padding:'0 1rem 2rem',fontFamily:"'Segoe UI','Malgun Gothic',sans-serif"}}>
  <h1>자동 종료 완료 경로 검사</h1>
  <p>합성 완료 상태로 실제 <code>canStopSharing</code>·<code>AutoCompletionHold</code>·<code>FinishTimer</code> 경로만 검사합니다. 실제 OCR·입력 지연·화면 공유 시간 측정이 아니며, 캡처 시각은 합성값입니다.</p>
  <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:16}}>
   {(Object.keys(labels) as Scenario[]).map(scenario=>
    <button key={scenario} disabled={running} onClick={()=>void run(scenario)}>{labels[scenario]}</button>)}
  </div>
  {result&&<section style={{border:'1px solid var(--line)',borderRadius:8,padding:'12px 16px'}}>
   <h2 style={{fontSize:14}}>결과: {labels[result.scenario]}</h2>
   <table style={{borderCollapse:'collapse',fontSize:12}}><tbody>
    <tr><td style={{padding:'2px 8px'}}>canStopSharing</td><td>{String(result.canStop)}</td></tr>
    <tr><td style={{padding:'2px 8px'}}>hold 1차 / 1.1초 후 2차</td><td>{String(result.holdFirst)} / {String(result.holdSecond)}</td></tr>
    {result.measured&&<>
     <tr><td style={{padding:'2px 8px'}}>lastCardInputMs</td><td>{result.measured.lastCardInputMs.toFixed(1)}</td></tr>
     <tr><td style={{padding:'2px 8px'}}>autoStoppedMs</td><td>{result.measured.autoStoppedMs.toFixed(1)}</td></tr>
     <tr><td style={{padding:'2px 8px'}}><strong>autoStoppedMs − lastCardInputMs</strong></td><td><strong>{result.measured.afterLastIdentifiedToAutoStopMs.toFixed(1)} ms</strong></td></tr>
     <tr><td style={{padding:'2px 8px'}}>finishedMs / afterLastCardMs</td><td>{result.measured.finishedMs.toFixed(1)} / {result.measured.afterLastCardMs.toFixed(1)}</td></tr>
     <tr><td style={{padding:'2px 8px'}}>identifiedCaptureWithinTarget</td><td>{String(result.measured.identifiedCaptureWithinTarget)} (target 10000ms)</td></tr>
     <tr><td style={{padding:'2px 8px'}}>sufficientInputVerified / goalWithinTarget</td><td>{String(result.measured.sufficientInputVerified)} / {String(result.measured.goalWithinTarget)}</td></tr>
    </>}
   </tbody></table>
   {!result.measured&&<p style={{fontSize:12,color:'var(--muted)'}}>이 시나리오는 완료 조건을 충족하지 않아 자동 종료가 발동하지 않았습니다(hold 2차도 false).</p>}
  </section>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Proof/>);
