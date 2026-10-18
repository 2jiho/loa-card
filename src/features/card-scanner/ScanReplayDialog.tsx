import {exactReplayFrames,executionSummary} from './exact-recording-codec';
import {useEffect,useRef,useState} from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import {loadReproduction,clearReproduction,openReproduction,createReproductionBundle,replaySettings,reproductionResult,compareReproduction} from './scan-reproduction';
import type {ReproductionFile,ReproductionResult} from './scan-reproduction';
import {runScanner} from './scanner';
import {recordedFrames} from './continuous-capture';
import type {PreparedScanner} from './scanner-preparation';
import {ScanActivity} from './ScanActivity';
import type {ScannerState} from './scanner';

export function ScanReplayDialog({open,onClose,onBusy,takePrepared}:{open:boolean;onClose:()=>void;onBusy:(busy:boolean)=>void;takePrepared:()=>PreparedScanner|undefined}){
  const [file,setFile]=useState<ReproductionFile|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[reading,setReading]=useState(true);
  const [state,setState]=useState<ScannerState|null>(null),[result,setResult]=useState<ReproductionResult|null>(null);
  const [verified,setVerified]=useState(0),[execution,setExecution]=useState<Awaited<ReturnType<typeof executionSummary>>|null>(null);
  const [error,setError]=useState('');
  const abort=useRef<AbortController|null>(null),preview=useRef<HTMLVideoElement>(null);
  useEffect(()=>{
    if(!open)return;
    let active=true;
    void loadReproduction().then(value=>{if(active){setFile(value??null);setExecution(null);setMessage(value?'최근 스캔 기록':'저장된 스캔 기록이 없습니다.');}})
      .catch(e=>{if(active)setError(String(e));}).finally(()=>{if(active)setReading(false);});
    return ()=>{active=false;};
  },[open]);
  useEffect(()=>{
    if(!file||!open)return;
    const url=URL.createObjectURL(file.video),element=preview.current;
    if(element)element.src=url;
    return ()=>{if(element){element.pause();element.removeAttribute('src');element.load();}URL.revokeObjectURL(url);};
  },[file,open]);
  useEffect(()=>()=>abort.current?.abort(),[]);
  const close=()=>{if(busy||reading)return;setFile(null);setState(null);setResult(null);setExecution(null);setError('');onClose();};
  async function input(value:File){
    setReading(true);setError('');setFile(null);setResult(null);setState(null);setExecution(null);
    try{setFile(await openReproduction(value,new AbortController().signal));setMessage(value.name);}
    catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setReading(false);}
  }
  async function replay(){
    if(!file||busy)return;
    const controller=new AbortController();abort.current=controller;
    const prepared=takePrepared();
    setBusy(true);onBusy(true);setError('');setState(null);setResult(null);setVerified(0);
    let latest:ScannerState|undefined;
    try{
      const settings=replaySettings(file);
      await runScanner(document.createElement('video'),'screen',controller.signal,next=>{latest=next;setState(next);},
        structuredClone(settings.seed),undefined,'all',undefined,false,
        {replay:settings,replayInputs:file.exact?exactReplayFrames(file.exact,controller.signal,count=>setVerified(count),file.metadata.exact?.frames):recordedFrames({blob:file.video,duration:file.metadata.duration},controller.signal)},prepared);
      controller.signal.throwIfAborted();
      if(latest)setResult(reproductionResult(latest));
    }catch(e){setError(controller.signal.aborted?'재현을 중지했습니다.':e instanceof Error?e.message:String(e));}
    finally{abort.current=null;setBusy(false);onBusy(false);}
  }
  async function inspect(){
    if(!file?.exact)return;
    setReading(true);setError('');
    try{setExecution(await executionSummary(file.exact,new AbortController().signal));}
    catch(e){setError(String(e));}finally{setReading(false);}
  }
  function save(){
    if(!file)return;
    try{
      const url=URL.createObjectURL(createReproductionBundle(file)),a=document.createElement('a');
      a.href=url;a.download=`loacard-${file.metadata.createdAt.replace(/[:.]/g,'-')}.loareplay`;a.click();
      setTimeout(()=>URL.revokeObjectURL(url),60_000);
    }catch(e){setError(String(e));}
  }
  const difference=result&&file?compareReproduction(file.metadata.result,result):null;
  return <Dialog open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby="replay-title">
    <DialogTitle id="replay-title">스캔 재현</DialogTitle>
    <DialogContent dividers>
      <p>최근 스캔의 입력과 처리 기록을 보관합니다. 다음 스캔을 시작하면 교체됩니다.</p>
      <p className="muted">공유한 화면 전체가 포함됩니다. 이슈 첨부 전 아래 영상에서 개인정보를 확인해 주세요. 자동으로 전송하지 않습니다.</p>
      <div className="toolbar" style={{marginBottom:12}}>
        <Button component="label" variant="outlined" disabled={busy||reading}>
          기록 불러오기<input className="visually-hidden" type="file" accept=".loareplay" aria-label="재현 기록 불러오기" disabled={busy||reading} onChange={e=>{const value=e.target.files?.[0];e.target.value='';if(value)void input(value);}}/>
        </Button>
        <Button disabled={!file||busy||reading} onClick={save}>기록 파일 저장</Button>
        <Button color="inherit" disabled={busy||reading} onClick={()=>{setReading(true);void clearReproduction().then(()=>{setFile(null);setState(null);setResult(null);setExecution(null);setMessage('기록을 삭제했습니다.');}).catch(e=>setError(String(e))).finally(()=>setReading(false));}}>기록 삭제</Button>
      </div>
      <p role="status">{reading?'기록 불러오는 중…':message}</p>
      <video ref={preview} controls muted playsInline preload="metadata" hidden={!file} style={{width:'100%',maxHeight:220,background:'#111'}}/>
      {file&&<>
        <p>{Math.round(file.metadata.duration)}초 · {((file.metadata.bytes+(file.metadata.exact?.bytes??0))/1024/1024).toFixed(1)}MB · 시작 목록 {file.metadata.seed.length}종 · {file.metadata.completed?'판독 종료 기록':'중단 기록'}</p>
        {!!file.metadata.warnings.length&&<p className="notice">{file.metadata.warnings.join(' · ')}</p>}
        <p className="muted">{file.exact?'검출 전 픽셀과 캡처 시각을 복원해 다시 판독합니다. 입력 해시를 검증하며, 당시의 병렬 실행 속도까지 같다는 뜻은 아닙니다.':'이전 형식의 압축 영상 기록입니다. 원래 입력 픽셀과 같지 않을 수 있습니다.'} 내 카드 목록은 바뀌지 않습니다.</p>
        {file.exact&&<>
          <p className={file.metadata.exact?.complete?'muted':'notice'}>{file.metadata.exact?.complete?'무손실 입력 기록':'부분 입력 기록'} · {file.metadata.exact?.frames}프레임 · 누락 {file.metadata.exact?.dropped}프레임</p>
          <Button variant="outlined" disabled={busy||reading} onClick={()=>void inspect()}>원래 실행 기록 확인</Button>
          {execution&&<p role="status">입력 {execution.frames}프레임 · 판독 시작 {execution.kinds['read-start']??0}회 / 종료 {execution.kinds['read-end']??0}회 · 카드 갱신 {execution.kinds.card??0}회 · {execution.seconds.toFixed(1)}초</p>}
          {file.metadata.signature!==import.meta.env.VITE_REPLAY_SIGNATURE&&<p className="notice">코드·데이터·모델 구성 해시가 다릅니다. 변경 후 결과 비교로 실행됩니다.</p>}
        </>}
        {file.metadata.build!==import.meta.env.VITE_BUILD_REVISION&&<p className="muted">다른 코드 버전의 기록입니다. 원래 결과와 달라질 수 있습니다.</p>}
      </>}
      {busy&&<><p role="status"><span className="scan-spinner"/> {state?.status??'재현 준비 중'} · 입력 {Math.floor(state?.percent??0)}% · {state?.cards.length??0}종{file?.exact?` · 픽셀 검증 ${verified}/${file.metadata.exact?.frames}`:''}</p><ScanActivity items={state?.activity??[]} queued={state?.queued??0}/></>}
      {result&&<div role="status">{file?.exact&&<p>입력 픽셀 검증 {verified} / {file.metadata.exact?.frames}프레임</p>}<strong>입력 재현 종료 · {result.cards.length}종 · 확인 필요 {result.cards.filter(c=>c.review.length).length}종</strong>
        {difference&&<><p>원래 결과와 비교: 추가 {difference.added.length} · 누락 {difference.missing.length} · 값/확인 상태 변경 {difference.changed.length}</p>
          {[['추가',difference.added],['누락',difference.missing],['변경',difference.changed]].map(([label,names])=>Array.isArray(names)&&names.length>0?<p key={String(label)}>{label}: {names.join(', ')}</p>:null)}</>}
      </div>}
      {error&&<p role="alert" className="error">{error}</p>}
    </DialogContent>
    <DialogActions>
      {busy?<Button onClick={()=>abort.current?.abort()}>재현 중지</Button>:<Button variant="contained" disabled={!file||reading} onClick={()=>void replay()}>{result?'같은 입력 다시 재현':'입력 재현 시작'}</Button>}
      <Button onClick={close} disabled={busy||reading}>닫기</Button>
    </DialogActions>
  </Dialog>;
}
