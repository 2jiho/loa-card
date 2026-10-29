import {executionSummary} from './exact-recording-codec';
import {reproductionInput} from './reproduction-input';
import {useEffect,useRef,useState} from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import {CancellableOperation} from './cancellable-operation';
import {loadReproduction,clearReproduction,openReproduction,createReproductionBundle,replayNameConfiguration,reproductionResult,compareReproduction,loadScanDiagnosticSummary,
  listReproductionSessions,loadReproductionSession,loadSessionDiagnosticSummary,deleteReproductionSession,pinReproductionSession} from './scan-reproduction';
import type {ReproductionFile,ReproductionResult,ScanDiagnosticSummary,ReproductionSessionItem,ReproductionSessionAccess} from './scan-reproduction';
import {runScanner} from './scanner';
import type {PreparedScanner} from './scanner-preparation';
import type {ScannerNameConfiguration} from './scanner-name-configuration';
import {ScanActivity} from './ScanActivity';
import type {ScannerState} from './scanner';

interface ScanReplayDialogProps {
  open:boolean;onClose:()=>void;onBusy:(busy:boolean)=>void;
  takePrepared:(configuration:ScannerNameConfiguration)=>PreparedScanner|undefined|Promise<PreparedScanner|undefined>;
  beginEngineWork?:()=>()=>void;
  engineBusy?:boolean;
  recordingEnabled?:boolean;onRecordingChange?:(enabled:boolean)=>void;recordingBusy?:boolean;recordingPreparation?:string;
  sessionAccess?:ReproductionSessionAccess;
}
const defaultSessionAccess:ReproductionSessionAccess={list:listReproductionSessions,load:loadReproductionSession,
  summary:loadSessionDiagnosticSummary,remove:deleteReproductionSession,pin:pinReproductionSession};
const sessionStatus={open:'저장 중',complete:'종료',partial:'부분 기록',failed:'기록 실패'} as const;
function sessionDate(value:string){
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'시각 미확인':date.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function sessionLabel(item:ReproductionSessionItem){
  const counts=item.read===null?'':` · ${item.read}/${item.expected??'?'}종`;
  return `${item.pinned?'고정 · ':''}${sessionDate(item.createdAt)} · ${sessionStatus[item.status]}${counts} · ${(item.bytes/1024/1024).toFixed(1)}MB`;
}
async function sessionContents(access:ReproductionSessionAccess,item:ReproductionSessionItem|undefined,signal:AbortSignal){
  if(!item||item.status==='open')return {value:undefined,diagnostic:undefined,loadError:''};
  // A corrupt/incomplete input must not hide an independently saved diagnostic.
  const [input,summary]=await Promise.allSettled([
    access.load(item.id,signal),access.summary(item.id,signal),
  ]);
  signal.throwIfAborted();
  const failed=[input,summary].filter((value):value is PromiseRejectedResult=>value.status==='rejected');
  return {value:input.status==='fulfilled'?input.value:undefined,
    diagnostic:summary.status==='fulfilled'?summary.value:undefined,
    loadError:failed.map(value=>value.reason instanceof Error?value.reason.message:String(value.reason)).join(' · ')};
}
export function ScanReplayDialog({open,onClose,onBusy,takePrepared,beginEngineWork,engineBusy=false,recordingEnabled=false,onRecordingChange,recordingBusy=false,recordingPreparation,sessionAccess=defaultSessionAccess}:ScanReplayDialogProps){
  const [file,setFile]=useState<ReproductionFile|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[reading,setReading]=useState(true);
  const [state,setState]=useState<ScannerState|null>(null),[result,setResult]=useState<ReproductionResult|null>(null);
  const [verified,setVerified]=useState(0),[execution,setExecution]=useState<Awaited<ReturnType<typeof executionSummary>>|null>(null);
  const [error,setError]=useState(''),[summary,setSummary]=useState<ScanDiagnosticSummary|null>(null),[readingLabel,setReadingLabel]=useState('기록 불러오는 중…');
  const [sessions,setSessions]=useState<ReproductionSessionItem[]>([]),[selectedSession,setSelectedSession]=useState<string|null>(null),[imported,setImported]=useState(false);
  const operation=useRef<CancellableOperation|null>(null),preview=useRef<HTMLVideoElement>(null),notifyBusy=useRef(onBusy);
  useEffect(()=>{notifyBusy.current=onBusy;},[onBusy]);
  useEffect(()=>{
    if(!open||recordingBusy)return;
    const task=new CancellableOperation(30_000,'기록을 불러오는 시간이 초과됐습니다. 다시 시도해 주세요.');
    operation.current=task;
    void Promise.resolve().then(async()=>{
      if(operation.current!==task||!task.current)return;
      setReading(true);setReadingLabel('기록 불러오는 중…');setError('');
      const loaded=await task.run(async signal=>{
        const items=await sessionAccess.list(signal),selected=items[0];
        if(selected)return {items,selected,...await sessionContents(sessionAccess,selected,signal)};
        if(sessionAccess!==defaultSessionAccess)return {items,selected,value:undefined,diagnostic:undefined,loadError:''};
        const [value,diagnostic]=await Promise.all([loadReproduction(signal),loadScanDiagnosticSummary(signal)]);
        return {items,selected,value,diagnostic,loadError:''};
      });
      if(operation.current===task&&task.current){
        setSessions(loaded.items);setSelectedSession(loaded.selected?.id??null);setImported(false);
        setFile(loaded.value??null);setSummary(loaded.diagnostic??null);setState(null);setResult(null);setExecution(null);
        setError(loaded.loadError);
        setMessage(loaded.selected?sessionLabel(loaded.selected):loaded.value?'이전 입력 기록':loaded.diagnostic?'이전 스캔 진단':'저장된 진단이 없습니다.');
      }
    }).catch(e=>{if(operation.current===task&&task.current)setError(e instanceof Error?e.message:String(e));})
      .finally(()=>{if(operation.current===task&&task.current){setReading(false);operation.current=null;}task.dispose();});
    return ()=>{operation.current?.dispose();operation.current=null;notifyBusy.current(false);};
  },[open,recordingBusy,sessionAccess]);
  useEffect(()=>{
    if(!file?.video.size||!open)return;
    const url=URL.createObjectURL(file.video),element=preview.current;
    if(element)element.src=url;
    return ()=>{if(element){element.pause();element.removeAttribute('src');element.load();}URL.revokeObjectURL(url);};
  },[file,open]);
  const close=()=>{
    operation.current?.dispose();operation.current=null;setBusy(false);setReading(false);onBusy(false);
    setFile(null);setSummary(null);setState(null);setResult(null);setExecution(null);setError('');setSessions([]);setSelectedSession(null);setImported(false);onClose();
  };
  async function read<T>(label:string,work:(signal:AbortSignal)=>Promise<T>,apply:(value:T)=>void,timeoutMs=30_000){
    operation.current?.dispose();const task=new CancellableOperation(timeoutMs,`${label} 시간이 초과됐습니다. 다시 시도해 주세요.`);operation.current=task;
    setReading(true);setReadingLabel(`${label} 중…`);setError('');
    try{const value=await task.run(work);if(operation.current===task&&task.current)apply(value);}
    catch(e){if(operation.current===task&&task.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(operation.current===task&&task.current){setReading(false);operation.current=null;}task.dispose();}
  }
  async function input(value:File){
    if(recordingBusy||busy||reading)return;
    setFile(null);setResult(null);setState(null);setExecution(null);setSummary(null);
    await read('기록 불러오기',signal=>openReproduction(value,signal),record=>{setFile(record);setSelectedSession(null);setImported(true);setMessage(`${value.name} · 임시로 불러온 파일`);});
  }
  async function selectSession(id:string){
    if(recordingBusy||busy||reading)return;
    setFile(null);setSummary(null);setResult(null);setState(null);setExecution(null);
    await read('스캔 기록 불러오기',async signal=>{
      return sessionContents(sessionAccess,sessions.find(item=>item.id===id),signal);
    },({value,diagnostic,loadError})=>{
      setSelectedSession(id);setImported(false);setFile(value??null);setSummary(diagnostic??null);
      setError(loadError);
      const item=sessions.find(item=>item.id===id);setMessage(item?sessionLabel(item):'스캔 기록');
    });
  }
  async function refreshSessions(){
    if(recordingBusy||busy||reading)return;
    await read('기록 목록 새로 읽기',async signal=>{
      const items=await sessionAccess.list(signal);
      if(imported)return {items,selected:undefined,value:undefined,diagnostic:undefined,loadError:''};
      const selected=items.find(item=>item.id===selectedSession)??items[0];
      return {items,selected,...await sessionContents(sessionAccess,selected,signal)};
    },({items,selected,value,diagnostic,loadError})=>{
      setSessions(items);if(imported)return;
      setSelectedSession(selected?.id??null);setFile(value??null);setSummary(diagnostic??null);setState(null);setResult(null);setExecution(null);
      setError(loadError);
      setMessage(selected?sessionLabel(selected):'저장된 진단이 없습니다.');
    });
  }
  async function pin(){
    const selected=sessions.find(item=>item.id===selectedSession);
    if(!selected||recordingBusy||busy||reading)return;
    await read('보관 설정 변경',async signal=>{
      await sessionAccess.pin(selected.id,!selected.pinned,signal);
      return sessionAccess.list(signal);
    },items=>{setSessions(items);const item=items.find(item=>item.id===selected.id);if(item)setMessage(sessionLabel(item));});
  }
  async function replay(){
    if(!file||busy||reading||recordingBusy||engineBusy)return;
    if(file.exact?(file.metadata.exact?.frames??0)===0:!file.video.size)return;
    operation.current?.dispose();const task=new CancellableOperation(600_000,'입력 재현이 10분을 초과해 중지했습니다. 더 짧은 기록으로 다시 시도해 주세요.');operation.current=task;
    setBusy(true);onBusy(true);setError('');setState(null);setResult(null);setVerified(0);
    let latest:ScannerState|undefined;
    let prepared:PreparedScanner|undefined,transferred=false;
    const engineSettled=beginEngineWork?.();
    try{
      const {configuration}=replayNameConfiguration(file);
      prepared=await takePrepared(configuration);
      await task.run(signal=>{
        const input=reproductionInput(file,signal,count=>{if(operation.current===task&&task.current&&!signal.aborted)setVerified(count);});
        transferred=true;
        return runScanner(document.createElement('video'),'screen',signal,next=>{
        if(operation.current!==task||!task.current||signal.aborted)return;latest=next;setState(next);
      },input.seed,undefined,'all',undefined,false,
        {...input.options,onInternalSettled:engineSettled},prepared);
      });
      if(operation.current===task&&task.current&&latest)setResult(reproductionResult(latest));
    }catch(e){if(operation.current===task&&task.current)setError(e instanceof Error?e.message:String(e));}
    finally{
      if(!transferred)try{await prepared?.dispose();}catch(e){if(operation.current===task&&task.current)setError(e instanceof Error?e.message:String(e));}finally{engineSettled?.();}
      if(operation.current===task&&task.current){operation.current=null;setBusy(false);onBusy(false);}task.dispose();
    }
  }
  async function inspect(){
    if(!file?.exact||busy||reading||recordingBusy)return;
    setExecution(null);
    await read('실행 기록 확인',signal=>executionSummary(file.exact!,signal,file.metadata.exact),setExecution,120_000);
  }
  async function clear(){
    if(recordingBusy||busy||reading)return;
    if(imported){setFile(null);setSummary(null);setState(null);setResult(null);setExecution(null);setImported(false);setMessage('불러온 파일을 닫았습니다. 저장한 기록은 유지됩니다.');return;}
    if(selectedSession){
      const id=selectedSession;
      if(sessions.find(item=>item.id===id)?.status==='open')return;
      await read('기록 삭제',async signal=>{
        await sessionAccess.remove(id,signal);
        const items=await sessionAccess.list(signal),selected=items[0];
        return {items,selected,...await sessionContents(sessionAccess,selected,signal)};
      },({items,selected,value,diagnostic,loadError})=>{
        setSessions(items);setSelectedSession(selected?.id??null);setFile(value??null);setSummary(diagnostic??null);setState(null);setResult(null);setExecution(null);
        setError(loadError);
        setMessage(selected?sessionLabel(selected):'저장된 진단이 없습니다.');
      });
    }else if(sessionAccess===defaultSessionAccess)await read('기록 삭제',signal=>clearReproduction(signal),()=>{setFile(null);setSummary(null);setState(null);setResult(null);setExecution(null);setMessage('이전 기록을 삭제했습니다.');});
  }
  function saveSummary(){
    if(!summary)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(summary,null,2)],{type:'application/json'})),a=document.createElement('a');
    a.href=url;a.download=`loacard-diagnostic-${summary.createdAt.replace(/[:.]/g,'-')}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);
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
  const selected=sessions.find(item=>item.id===selectedSession),disabled=busy||reading||recordingBusy;
  const canReplay=!!file&&(file.exact?(file.metadata.exact?.frames??0)>0:file.video.size>0);
  return <Dialog open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby="replay-title">
    <DialogTitle id="replay-title">스캔 진단</DialogTitle>
    <DialogContent dividers>
      <p>스캔별 입력과 판독 근거를 확인합니다.</p>
      {onRecordingChange&&<>
        <FormControlLabel control={<Switch checked={recordingEnabled} disabled={recordingBusy} onChange={(_,value)=>onRecordingChange(value)}/>} label="전체 입력 기록 · 문제 재현용"/>
        <p className="muted">문제를 재현할 때만 켜 주세요. 저장 공간을 많이 사용하며 한도에 닿으면 일부만 기록됩니다. 끈 상태에서도 진단 요약과 문제 이미지는 보관합니다.</p>
        {recordingPreparation&&<p role="status">{recordingPreparation}</p>}
      </>}
      {!!sessions.length&&<section aria-label="저장한 스캔 기록">
        <FormControl fullWidth size="small" sx={{mt:1}}>
          <InputLabel id="scan-session-label">스캔 기록</InputLabel>
          <Select labelId="scan-session-label" label="스캔 기록" value={selectedSession??''} disabled={disabled} onChange={event=>void selectSession(event.target.value)}>
            {selectedSession===null&&<MenuItem value="" disabled>{imported?'불러온 파일':'기록을 선택하세요'}</MenuItem>}
            {sessions.map(item=><MenuItem key={item.id} value={item.id} sx={{whiteSpace:'normal'}}>{sessionLabel(item)}</MenuItem>)}
          </Select>
        </FormControl>
        <div className="toolbar" style={{marginTop:8,marginBottom:12}}>
          <Button size="small" disabled={disabled||!selected} onClick={()=>void pin()}>{selected?.pinned?'고정 해제':'기록 고정'}</Button>
        </div>
        {selected?.reason&&<p className="notice">{selected.reason}</p>}
        {selected?.status==='open'&&<p role="status" className="muted">저장 중인 기록입니다. 종료 후 입력을 열 수 있습니다.</p>}
        {selected&&!selected.hasInput&&selected.status!=='open'&&<p className="muted">판독 요약만 남아 있어 입력 재현은 할 수 없습니다.</p>}
      </section>}
      <p className="muted">최근 8개·총 512MiB 한도로 보관합니다. 고정한 기록은 자동 삭제하지 않아요.</p>
      {summary&&<section aria-label="선택한 스캔 진단">
        <p>{summary.completed?'판독 종료':'중단'} · 판독 {summary.result?.read??0} / {summary.result?.expected??'?'}종 · 진단 이미지 {summary.images.length}개</p>
        <Button variant="outlined" disabled={recordingBusy} onClick={saveSummary}>진단 정보 저장</Button>
        {!!summary.images.length&&<details><summary>진단 이미지 확인</summary><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(72px,1fr))',gap:8,maxHeight:260,overflowY:'auto'}}>
          {summary.images.map((item,index)=>{
            const label=item.source==='recognition'?'판독 원본':item.source==='preview'?'미리보기':'';
            return <figure key={index} style={{margin:0}}><img src={item.image} alt={`${label?label+' · ':''}${item.reason}`} title={`${label?label+' · ':''}${item.reason} · ${item.time.toFixed(1)}초`} style={{width:'100%',height:'auto'}}/><figcaption className="muted">{label&&<b>{label} · </b>}{item.reason}</figcaption></figure>;
          })}
        </div></details>}
        {!!summary.warnings.length&&<p className="notice">{summary.warnings.join(' · ')}</p>}
      </section>}
      <p className="muted">파일은 자동 전송되지 않습니다. 공유 전 이미지·영상의 개인정보를 확인하세요.</p>
      <div className="toolbar" style={{marginBottom:12}}>
        <Button variant="outlined" disabled={disabled} onClick={()=>void refreshSessions()}>목록 새로 읽기</Button>
        <Button component="label" variant="outlined" disabled={busy||reading||recordingBusy}>
          기록 불러오기<input className="visually-hidden" type="file" accept=".loareplay" aria-label="재현 기록 불러오기" disabled={busy||reading||recordingBusy} onChange={e=>{const value=e.target.files?.[0];e.target.value='';if(value)void input(value);}}/>
        </Button>
        <Button disabled={!file||busy||reading||recordingBusy} onClick={save}>기록 파일 저장</Button>
        <Button color="inherit" disabled={disabled||selected?.status==='open'||!selected&&!file&&!summary} onClick={()=>void clear()}>{imported?'파일 닫기':'선택한 기록 삭제'}</Button>
      </div>
      <p role="status">{recordingBusy?'진단 기록 저장 중…':reading?readingLabel:message}</p>
      {engineBusy&&!busy&&<p role="status">이전 인식 엔진 종료를 기다리고 있습니다.</p>}
      {imported&&<p className="muted">불러온 파일은 임시로 열려 있습니다. 브라우저에 저장한 스캔 기록과 내 카드 목록은 바뀌지 않습니다.</p>}
      <video ref={preview} controls muted playsInline preload="metadata" hidden={!file?.video.size} style={{width:'100%',maxHeight:220,background:'#111'}}/>
      {file&&<>
        <p>{Math.round(file.metadata.duration)}초 · {((file.metadata.bytes+(file.metadata.exact?.bytes??0))/1024/1024).toFixed(1)}MB · 시작 목록 {file.metadata.seed.length}종 · {file.metadata.completed?'판독 종료 기록':'중단 기록'}</p>
        {file.metadata.nameConfiguration===undefined&&<p className="muted">판독 설정 미기록 · 현재 기본 설정으로 비교합니다.</p>}
        {!!file.metadata.warnings.length&&<p className="notice">{file.metadata.warnings.join(' · ')}</p>}
        <p className="muted">{file.exact?'검출 전 픽셀과 캡처 시각을 복원해 다시 판독합니다. 입력 해시를 검증하며, 당시의 병렬 실행 속도까지 같다는 뜻은 아닙니다.':'이전 형식의 압축 영상 기록입니다. 원래 입력 픽셀과 같지 않을 수 있습니다.'} 내 카드 목록은 바뀌지 않습니다.</p>
        {file.exact&&<>
          <p className={file.metadata.exact?.complete?'muted':'notice'}>{file.metadata.exact?.complete?'무손실 입력 기록':'부분 입력 기록'} · {file.metadata.exact?.frames}프레임 · 누락 {file.metadata.exact?.dropped??'미확인'}프레임</p>
          <Button variant="outlined" disabled={busy||reading||recordingBusy} onClick={()=>void inspect()}>원래 실행 기록 확인</Button>
          {!canReplay&&<p className="muted">픽셀 입력이 없어 실행 기록만 확인할 수 있습니다.</p>}
          {execution&&<section aria-label="관측 상태 재생" role="status">
            {execution.recordingComplete===false&&<p className="notice">부분 기록입니다. 남아 있는 상태만 재생하며 원래 실행과의 전체 일치는 확인할 수 없습니다.</p>}
            <p>입력 {execution.frames}프레임 · 판독 시작 {execution.kinds['read-start']??0}회 / 종료 {execution.kinds['read-end']??0}회 · 카드 갱신 {execution.kinds.card??0}회 · {execution.seconds.toFixed(1)}초</p>
            {execution.observations.supported?<>
              <strong>관측 상태 재생</strong>
              <p>관측 {execution.observations.observations.toLocaleString()}건 · 이벤트 {execution.observations.facts.toLocaleString()}건</p>
              <p>대기 {execution.observations.waiting.toLocaleString()} · 판독 중 {execution.observations.reading.toLocaleString()} · 완료 {execution.observations.read.toLocaleString()} · 확인 필요 {execution.observations.review.toLocaleString()}</p>
              <p className="muted">관측 건수는 카드 종류 수나 현재 진행창의 칸 수와 다릅니다. 실시간 처리 속도는 재현하지 않습니다.</p>
              <p className="muted" style={{overflowWrap:'anywhere'}}>상태 SHA-256 <code>{execution.observations.hash}</code></p>
            </>:<p className="muted">관측 상태 재생 미지원 · 이 기록에는 관측 상태 이벤트가 없습니다.</p>}
            {execution.grid.supported?<p className={execution.grid.matchesCapturedState===false?'notice':'muted'}>
              지도 상태 재생 · {execution.grid.commands.toLocaleString()}개 명령 · {execution.grid.matchesCapturedState===true?'원래 진행창 상태와 일치':execution.grid.matchesCapturedState===false?'원래 진행창 상태와 불일치':'원래 해시가 없어 일치 여부 미확인'}
            </p>:<p className="muted">지도 상태 재생 미지원 · 이 기록에는 지도 명령이 없습니다.</p>}
            {execution.inventory.supported&&<p className={execution.inventory.matchesCapturedState===false?'notice':'muted'}>
              카드 근거 재생 · {execution.inventory.cards.toLocaleString()}종 · {execution.inventory.matchesCapturedState===true?'원래 카드 근거와 일치':execution.inventory.matchesCapturedState===false?'원래 카드 근거와 불일치':'일치 여부 미확인'}
            </p>}
          </section>}
          {file.metadata.signature!==import.meta.env.VITE_REPLAY_SIGNATURE&&<p className="notice">코드·데이터·모델 구성 해시가 다릅니다. 변경 후 결과 비교로 실행됩니다.</p>}
        </>}
        {file.metadata.build!==import.meta.env.VITE_BUILD_REVISION&&<p className="muted">다른 코드 버전의 기록입니다. 원래 결과와 달라질 수 있습니다.</p>}
      </>}
      {busy&&<><p role="status"><span className="scan-spinner"/> {state?.status??'재현 준비 중'} · 입력 {Math.floor(state?.percent??0)}% · {state?.cards.length??0}종{file?.exact?` · 픽셀 검증 ${verified}/${file.metadata.exact?.frames}`:''}</p><ScanActivity items={state?.activity??[]} queued={state?.queued??0}/></>}
      {result&&<div role="status">{file?.exact&&<p>입력 픽셀 검증 {verified} / {file.metadata.exact?.frames}프레임</p>}<strong>입력 재현 종료 · {result.cards.length}종 · 확인 필요 {result.cards.filter(c=>c.review.length).length}종</strong>
        {result.unidentified>0&&<p className="notice">미식별 입력 {result.unidentified}개 · 이미 읽은 카드의 중복 관측일 수 있습니다.</p>}
        {difference&&<><p>원래 결과와 비교: 추가 {difference.added.length} · 누락 {difference.missing.length} · 값/확인 상태 변경 {difference.changed.length}</p>
          {[['추가',difference.added],['누락',difference.missing],['변경',difference.changed]].map(([label,names])=>Array.isArray(names)&&names.length>0?<p key={String(label)}>{label}: {names.join(', ')}</p>:null)}</>}
      </div>}
      {error&&<p role="alert" className="error">{error}</p>}
    </DialogContent>
    <DialogActions>
      {!recordingBusy&&(busy||reading)?<Button onClick={()=>operation.current?.cancel()}>{busy?'재현 중지':'작업 중지'}</Button>:<Button variant="contained" disabled={!canReplay||reading||recordingBusy||engineBusy} onClick={()=>void replay()}>{result?'같은 입력 다시 재현':'입력 재현 시작'}</Button>}
      <Button onClick={close}>닫기</Button>
    </DialogActions>
  </Dialog>;
}
