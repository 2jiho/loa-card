import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ScanAttention} from '../src/features/card-scanner/ui/ScanAttention';
import {AppTheme,ThemeToggle} from '../src/ui/AppTheme';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';
import type {PendingCardFields} from '../src/features/card-scanner/session/current-scan-fields';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';
import '../src/App.css';

// A synthetic rendering fixture; it cannot confirm actual screen-share timing.
const svg=(label:string,color:string)=>`data:image/svg+xml;utf8,${encodeURIComponent(
 `<svg xmlns="http://www.w3.org/2000/svg" width="68" height="102"><rect width="68" height="102" rx="6" fill="${color}"/><text x="34" y="56" font-size="11" text-anchor="middle" fill="#fff" font-family="sans-serif">${label}</text></svg>`
)}`;
const beskalImage=svg('베스칼','#41507a');
const unknownImageA=svg('미식별 A','#5a4a6b');
const unknownImageB=svg('미식별 B','#6b5a41');

const beskal:ScannedCard={id:'3200813',name:'베스칼',awakening:0,extraCopies:null,confidence:98.4,
 review:['장수 확인','최신 각성·장수 확인'],image:beskalImage,time:4.96,observations:3,captureOrder:130};

// Mirrors the run-750fbfb6 beskal field issues: count read failed (unconfirmed),
// pattern value null with the occlusion-or-unclear reason -> count stays unknown.
const beskalPending:PendingCardFields={id:'3200813',name:'베스칼',image:beskalImage,time:4.9,
 captureOrder:130,reason:'각성·장수 판독 확인',countReason:'숫자 획 부족',stable:true,borderAlignment:1,
 countDiagnostics:{maximum:15,reason:'추가 장수 확인',iconPresent:false,reliability:'unconfirmed',readings:[],
  pattern:{value:null,candidate:null,score:0,gap:0,reason:'장수 숫자 미검출 또는 불명확'}}};

const unknown:ScannerState['unidentified']=[
 {image:unknownImageA,time:2.95,group:25,pending:false,reason:'카드 판독 시간 초과 · 다시 보여 주세요',
  location:{percent:0,column:5,row:3}},
 {image:unknownImageB,time:3.9,group:64,pending:false,reason:'이름 확인 필요'},
];

const recognitionNeeded=[
 {slot:3,captureTime:2.9,reason:'툴팁 패널 가림 · 가림 해제 후 재관측'},
 {slot:14,captureTime:3.4,reason:'이름 영역에 글자 대비 없음 · 가림 해제 후 재관측'},
];

type ModeFixture={label:string;sharing:boolean;busy:boolean;queued:number;activeReadings:number};
const modes:ModeFixture[]=[
 {label:'처리 중',sharing:true,busy:true,queued:2,activeReadings:1},
 {label:'공유 대기',sharing:true,busy:false,queued:0,activeReadings:0},
 {label:'공유 종료',sharing:false,busy:false,queued:0,activeReadings:0},
];

// oxlint-disable-next-line react/only-export-components -- standalone dev proof entry.
function Proof(){
 const [mode,setMode]=useState<ModeFixture>(modes[1]);
 const [evidenceLost,setEvidenceLost]=useState(false);
 const ended=!mode.sharing&&!mode.busy;
 const panel=<ScanAttention cards={[beskal]} unknown={ended?[]:unknown} discarded={ended?unknown:[]} missing={[{id:'3200999',name:'샘플 카드'}]}
  artworkById={new Map()} pendingFields={[beskalPending]} evidenceLost={evidenceLost} recognitionNeeded={recognitionNeeded}
  sharing={mode.sharing} busy={mode.busy} queued={mode.queued} activeReadings={mode.activeReadings}/>;
 if(new URLSearchParams(window.location.search).has('narrow'))
  return <AppTheme>{panel}</AppTheme>;
 return <AppTheme><main style={{maxWidth:760,margin:'1rem auto',padding:'0 1rem 2rem'}}>
  <h1>재촬영 안내 표시 검사</h1>
  <p>합성 데이터로 추가 확인 항목(ScanAttention)의 표시와 안내 문구를 검사합니다. 실제 스캔 결과나 화면 공유 시각이 아닙니다.</p>
  <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:16}}>
   <ThemeToggle/>
   {modes.map(m=><button key={m.label} aria-pressed={m.label===mode.label} onClick={()=>setMode(m)}>{m.label}</button>)}
   <button aria-pressed={evidenceLost} onClick={()=>setEvidenceLost(value=>!value)}>근거 누락 표시</button>
  </div>
  {panel}
  <h2 style={{fontSize:14}}>좁은 화면(380px) 미리보기</h2>
  <p style={{fontSize:12,color:'var(--muted)'}}>미디어 쿼리(최대 600px)는 아래 프레임 안에서 적용됩니다.</p>
  <iframe title="좁은 화면 미리보기" src="/dev/scan-attention-proof.html?narrow=1"
   width={380} height={640} style={{border:'1px solid var(--line)',borderRadius:8}}/>
  </main></AppTheme>;
}
createRoot(document.getElementById('root')!).render(<Proof/>);
