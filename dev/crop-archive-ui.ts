import {createCropIndexedDbSink,listCropIndexedDbRuns,loadCropIndexedDbRun} from './recognition-crop-indexeddb';
import {exportCropArchive,openCropArchive,restoreCropArchive,type StreamSink} from './crop-archive';

const list=document.querySelector<HTMLButtonElement>('#list')!,runs=document.querySelector<HTMLSelectElement>('#runs')!;
const id=document.querySelector<HTMLInputElement>('#id')!,file=document.querySelector<HTMLInputElement>('#file')!;
const save=document.querySelector<HTMLButtonElement>('#export')!,verify=document.querySelector<HTMLButtonElement>('#verify')!;
const restore=document.querySelector<HTMLButtonElement>('#import')!,status=document.querySelector<HTMLElement>('#status')!;
const result=document.querySelector<HTMLElement>('#result')!;const page=new AbortController();let busy=false;
function lock(value:boolean){busy=value;for(const el of [list,runs,id,file,save,verify,restore])el.disabled=value;}
function show(value:unknown){result.textContent=JSON.stringify(value,null,2);}
list.addEventListener('click',async()=>{if(busy)return;lock(true);try{const data=await listCropIndexedDbRuns();
 runs.replaceChildren(new Option('기록 선택',''),...data.runs.map(run=>new Option(`${run.id} · ${run.status}`,run.id)));
 status.textContent=`기록 ${data.runs.length}개${data.truncated?' · 일부만 표시':''}`;
 }catch(error){status.textContent=String(error);}finally{lock(false);}});
runs.addEventListener('change',()=>{if(runs.value)id.value=runs.value;});
type SavePicker=(options:{suggestedName:string;types:{description:string;accept:Record<string,string[]>}[]})=>Promise<{name:string;createWritable():Promise<StreamSink>;getFile():Promise<File>}>;
save.addEventListener('click',async()=>{
 if(busy)return;const runId=id.value.trim(),picker=(window as unknown as {showSaveFilePicker?:SavePicker}).showSaveFilePicker;
 if(!/^[a-zA-Z0-9-]{1,160}$/.test(runId)){status.textContent='기록 ID를 입력하세요.';return;}
 if(!picker){status.textContent='이 브라우저는 스트리밍 파일 저장 선택기를 지원하지 않습니다.';return;}
 lock(true);let sink:StreamSink|undefined,run:Awaited<ReturnType<typeof loadCropIndexedDbRun>>|undefined;
 try{
  const handle=await picker.call(window,{suggestedName:`loacard-crops-${runId}.loacrops`,types:[{description:'LoaCard 판독 크롭',accept:{'application/octet-stream':['.loacrops']}}]});
  sink=await handle.createWritable();status.textContent='저널과 픽셀을 검증하고 파일로 저장합니다.';
  run=await loadCropIndexedDbRun(runId);const output=await exportCropArchive(run,sink,AbortSignal.any([page.signal,AbortSignal.timeout(300000)]));sink=undefined;
  status.textContent='브라우저가 저장한 파일을 다시 열어 무결성을 확인합니다.';
  let reopened:{complete:boolean;crops:number}|null=null,reopenError:string|null=null;
  try{const file=await handle.getFile(),proof=await openCropArchive(file,AbortSignal.any([page.signal,AbortSignal.timeout(300000)]));
   if(file.size!==output.bytes||proof.metadataSha256!==output.metadataSha256||proof.proof.crops!==output.crops||proof.proof.complete!==output.complete)
    throw Error('다시 연 파일이 저장한 기록과 일치하지 않습니다.');
   reopened={complete:proof.proof.complete,crops:proof.proof.crops};
  }catch(error){reopenError=String(error).slice(0,500);}
  show({scope:'판독 크롭과 이벤트 전용',runId,...output,sourceFrame:false,selectedName:handle.name,reopened,reopenError,
   saveVerification:'다시 열기 결과는 브라우저 파일 핸들 기준입니다. 운영체제 절대 경로와 실제 파일시스템 존재 여부는 확인하지 못합니다.'});
  status.textContent=`브라우저 저장 응답 · ${handle.name} · ${reopened?'다시 열기 검증 완료':'다시 열기 미확인'} · 저장 위치는 선택기에서 확인하세요.`;
 }catch(error){await sink?.abort(error).catch(()=>{});status.textContent=`내보내기 중단 · ${String(error).slice(0,500)}`;}finally{run?.close();lock(false);}
});
async function openSelected(){const input=file.files?.[0];if(!input)throw Error('기록 파일을 선택하세요.');
 return openCropArchive(input,AbortSignal.any([page.signal,AbortSignal.timeout(300000)]));}
verify.addEventListener('click',async()=>{if(busy)return;lock(true);try{status.textContent='파일 무결성과 이벤트 순서를 확인합니다.';
 const archive=await openSelected();show({kind:archive.kind,metadataSha256:archive.metadataSha256,seed:archive.seed,checkpoint:archive.checkpoint,proof:archive.proof,
  scope:'판독 크롭에 한정. 원본 프레임·획득·전체 스캔·실시간 성능 미검증.'});
 status.textContent=`무결성 확인 · ${archive.proof.complete?'저널 봉인':'부분 기록'} · ${archive.proof.crops}회`;
 }catch(error){status.textContent=`파일 무결성 확인 실패 · ${String(error).slice(0,500)}`;}finally{lock(false);}});
restore.addEventListener('click',async()=>{if(busy)return;lock(true);let sink:Awaited<ReturnType<typeof createCropIndexedDbSink>>|undefined;
 let newId:string|undefined;try{
  status.textContent='파일을 먼저 검증하고 있습니다.';const archive=await openSelected();newId=crypto.randomUUID();
  sink=await createCropIndexedDbSink(newId);status.textContent=`새 기록 ${newId}으로 복사 중입니다.`;
  const copied=await restoreCropArchive(archive,sink,AbortSignal.any([page.signal,AbortSignal.timeout(300000)]));
  show({id:newId,metadataSha256:archive.metadataSha256,...copied,scope:'원본 화면·전체 스캔 아님'});
  status.textContent=`새 기록 복원 완료 · ${copied.complete?'저널 봉인':'부분 기록'} · ${newId}`;
 }catch(error){show({id:newId??null,complete:false,error:String(error).slice(0,1000),warning:'중단된 새 기록이 남을 수 있습니다. 기존 기록은 변경하지 않았습니다.'});
  status.textContent=`복원 중단 · ${String(error).slice(0,500)}`;
 }finally{sink?.close();lock(false);}});
window.addEventListener('pagehide',()=>page.abort());
