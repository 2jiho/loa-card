import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ThemeProvider,createTheme} from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import Button from '@mui/material/Button';
import {ScanReplayDialog} from '../src/features/card-scanner/ScanReplayDialog';
import {createReproductionSessionAccess} from '../src/features/card-scanner/scan-reproduction';
import type {ReproductionSessionAccess,ScanDiagnosticSummary} from '../src/features/card-scanner/scan-reproduction';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';
import '../src/index.css';
import '../src/App.css';

// This viewer shares only the dev runner's store. Main inventory and sessions
// are never read, cleared or migrated by this page.
const params=new URLSearchParams(location.search),mode=params.get('theme')==='dark'?'dark':'light';
document.documentElement.dataset.theme=mode;
/** Optional diagnostic-only fixture for UI checks after large input sessions
 * were evicted. The fixed private URL never reads or writes browser sessions. */
function summaryFixture():ReproductionSessionAccess {
  let summary:ScanDiagnosticSummary|undefined;
  return {
    async list(signal){
      const response=await fetch('/work/session-viewer-summary.json',{signal,cache:'no-store'});
      if(!response.ok)throw Error('개인 UI 검사용 진단 요약이 없습니다.');
      const reader=response.body?.getReader();if(!reader)throw Error('진단 요약 응답 없음');
      const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
      try{
        while(true){signal?.throwIfAborted();const next=await reader.read();if(next.done)break;
          bytes+=next.value.byteLength;if(bytes>3*1024*1024)throw Error('진단 요약 크기 초과');
          text+=decoder.decode(next.value,{stream:true});}
        text+=decoder.decode();
      }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      const value=JSON.parse(text) as ScanDiagnosticSummary;
      if(!value||typeof value.createdAt!=='string'||typeof value.status!=='string'||typeof value.completed!=='boolean'||
        !Array.isArray(value.warnings)||!value.warnings.every(item=>typeof item==='string')||
        !Array.isArray(value.images)||value.images.length>32||value.images.some(item=>!item||typeof item.image!=='string'||
          !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(item.image)||item.image.length>262144||
          typeof item.reason!=='string'||!Number.isFinite(item.time))||
        value.images.reduce((bytes,item)=>bytes+item.image.length,0)>1048576)throw Error('진단 요약 형식 오류');
      signal?.throwIfAborted();summary=value;
      return [{id:'summary-fixture',createdAt:value.createdAt,status:'partial',pinned:true,bytes,
        read:value.result?.read??null,expected:value.result?.expected??null,hasInput:false,
        reason:'UI 검사용 진단 요약 · 입력 픽셀 없음'}];
    },
    async load(){return undefined;},async summary(){return summary;},
    async remove(){throw Error('UI 검사용 요약은 읽기 전용입니다.');},
    async pin(){throw Error('UI 검사용 요약은 읽기 전용입니다.');},
  };
}
const access=params.get('summary')==='1'?summaryFixture():
  createReproductionSessionAccess(createReproductionSessionStore({dbName:'loacard-reproduction-dev'}));
const theme=createTheme({palette:{mode},typography:{fontFamily:"'Segoe UI','Malgun Gothic',sans-serif",fontSize:13}});
if(params.get('narrow')==='1'){
  const style=document.createElement('style');style.textContent='.MuiDialog-paper{width:360px!important;max-width:calc(100% - 24px)!important;margin:12px!important}';document.head.append(style);
}
export function Viewer(){
  const [open,setOpen]=useState(true),[busy,setBusy]=useState(false);
  return <ThemeProvider theme={theme}><CssBaseline/><main style={{padding:24}}>
    <h1>세션 UI 검사</h1><p>{params.get('summary')==='1'?'개인 진단 요약의 읽기 전용 UI 검사입니다. 입력 재현과 별개입니다.':'개발 검사의 별도 저장소를 사용합니다.'}</p>
    <Button disabled={busy} onClick={()=>setOpen(true)}>스캔 진단 열기</Button>
    <ScanReplayDialog open={open} onClose={()=>setOpen(false)} onBusy={setBusy} takePrepared={()=>undefined}
      recordingEnabled sessionAccess={access}/>
  </main></ThemeProvider>;
}
createRoot(document.querySelector('#root')!).render(<Viewer/>);
