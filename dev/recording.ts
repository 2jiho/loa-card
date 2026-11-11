import {runScanner} from '../src/features/card-scanner/orchestration/scanner';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../src/features/card-scanner/session/scanner-name-configuration';
import {prepareRecordedShareInput} from './recorded-share-input';
import {openRecordedShareStream} from './recorded-share-frames';
import type {RecordedShareInput} from './recorded-share-input';
import {comparabilityIssues,diffRuns,summarizeRun,summarizeUnresolved} from './recording-runs';
import type {RunCard,RunDeliveryLike,RunReport,RunSummary} from './recording-runs';

/** Development page: re-run a server-side recording through the live scanner
 * and compare runs on the same input. See docs/dev-recording.md. */
const BASE='/__rec';
const $=<T extends HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
const recordingsBody=$<HTMLTableSectionElement>('#recordings tbody'),runsBody=$<HTMLTableSectionElement>('#runs tbody');
const startButton=$<HTMLButtonElement>('#start'),stopButton=$<HTMLButtonElement>('#stop');
const statusLine=$('#status'),progress=$('#progress'),diffBox=$('#diff'),share=$<HTMLVideoElement>('#share');

interface RecordingRow {
  id:string;width:number;height:number;pixelFormat:string;frames:number;status:string;complete:boolean;note:string|null;startedAt:string;
}
let rows:RecordingRow[]=[],picked:string|null=null,controller:AbortController|undefined;
let runs:{name:string;summary:RunSummary|null}[]=[];
const diffPicks:string[]=[];

const text=(value:string|number|null|undefined)=>value===null||value===undefined?'':String(value);
function cell(row:HTMLTableRowElement,value:string,className?:string):void {
  const td=document.createElement('td');td.textContent=value;if(className)td.className=className;row.append(td);
}

async function loadRecordings():Promise<void> {
  const response=await fetch(BASE,{cache:'no-store'});
  rows=((await response.json()) as {recordings:RecordingRow[]}).recordings.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  recordingsBody.textContent='';
  for(const item of rows){
    const tr=document.createElement('tr');tr.className=item.id===picked?'picked':'';
    const pick=document.createElement('td'),radio=document.createElement('input');
    radio.type='radio';radio.name='recording';radio.checked=item.id===picked;
    radio.addEventListener('change',()=>{picked=item.id;startButton.disabled=!!controller;void loadRecordings();void loadRuns();});
    pick.append(radio);tr.append(pick);
    cell(tr,item.id);cell(tr,text(item.frames));cell(tr,`${item.width}×${item.height} ${item.pixelFormat}`);
    cell(tr,`${item.status}${item.complete?'':' · 불완전'}`,item.complete?'ok':'bad');cell(tr,text(item.note));
    recordingsBody.append(tr);
  }
  if(!rows.length)recordingsBody.innerHTML='<tr><td colspan="6">저장된 기록이 없습니다. 메인 앱이나 개발 페이지에서 화면 공유를 하면 자동으로 쌓입니다.</td></tr>';
}

async function loadRuns():Promise<void> {
  runsBody.textContent='';diffBox.textContent='';diffPicks.length=0;
  if(!picked)return;
  runs=((await (await fetch(`${BASE}/${encodeURIComponent(picked)}/runs`,{cache:'no-store'})).json()) as {runs:typeof runs}).runs;
  for(const run of runs){
    const tr=document.createElement('tr');
    const box=document.createElement('td'),check=document.createElement('input');
    check.type='checkbox';check.addEventListener('change',()=>{
      if(check.checked)diffPicks.push(run.name);else diffPicks.splice(diffPicks.indexOf(run.name),1);
      while(diffPicks.length>2){const dropped=diffPicks.shift()!;runsBody.querySelectorAll<HTMLInputElement>(`input[data-run="${dropped}"]`).forEach(input=>{input.checked=false;});}
      void showDiff();
    });
    check.dataset.run=run.name;box.append(check);tr.append(box);
    const summary=run.summary;
    cell(tr,run.name.replace(/^run-|\.json$/g,''));cell(tr,text(summary?.build));
    cell(tr,summary?`${summary.read}/${summary.expected??'?'}`:'');cell(tr,text(summary?.unidentified));
    cell(tr,summary?`${summary.meanLateMs.toFixed(0)} · ${summary.maxLateMs.toFixed(0)}`:'');
    cell(tr,summary?(summary.mode==='live'?'라이브(스캔 당시 결과)':`${summary.mode==='sequential'?'순차':'실시간'} · ${summary.faithful?'충실':'불충실'}`):'',summary?.faithful?'ok':'bad');
    runsBody.append(tr);
  }
}

async function showDiff():Promise<void> {
  if(diffPicks.length!==2||!picked){diffBox.textContent=diffPicks.length?'비교할 실행을 하나 더 선택하세요.':'';return;}
  const [first,second]=await Promise.all(diffPicks.map(async name=>
    (await (await fetch(`${BASE}/${encodeURIComponent(picked!)}/runs/${name}`)).json()) as RunReport));
  const diff=diffRuns(first.cards,second.cards);
  const issues=comparabilityIssues(first,second);
  diffBox.textContent=[issues.length?`⚠ 비교 주의: ${issues.join(' ')}`:'입력 동일(해시 일치), 두 재실행 모두 충실',
    `A ${first.summary.build} → B ${second.summary.build}`,
    `A에만 ${diff.onlyA.length}장, B에만 ${diff.onlyB.length}장, 값이 다름 ${diff.changed.length}장, 같음 ${diff.same}장`,
    ...diff.onlyA.map(card=>`  A에만: ${card.name} (${card.id})`),
    ...diff.onlyB.map(card=>`  B에만: ${card.name} (${card.id})`),
    ...diff.changed.map(item=>`  다름: ${item.a.name} 각성 ${item.a.awakening}→${item.b.awakening}, 장수 ${item.a.extraCopies}→${item.b.extraCopies}`)].join('\n');
}

function busy(value:boolean):void {startButton.disabled=value||!picked;stopButton.disabled=!value;}

async function run():Promise<void> {
  if(!picked||controller)return;
  const recordingId=picked;
  controller=new AbortController();busy(true);progress.textContent='';statusLine.textContent='기록을 여는 중…';
  const signal=controller.signal;
  let input:RecordedShareInput|undefined,latest:ScannerState|undefined;
  const modeValue=$<HTMLSelectElement>('#mode').value;
  const sequential=modeValue!=='realtime';
  let calibration:readonly unknown[]|undefined;
  // ?peek=name1,name2 adds those cards (with preview and count diagnostics) to the report's countReview.
  const peek=new Set((new URLSearchParams(location.search).get('peek')??'').split(',').map(name=>name.trim()).filter(Boolean));
  const usedTimes:number[]=[],usedSeen=new Set<number>(),locatedTimes:number[]=[],locatedSeen=new Set<number>();
  let subsetOf:RunReport['subsetOf'];
  let delivery:RunDeliveryLike&{recordingId:string;recordingComplete:boolean;recordingSha256:string|null}|undefined;
  const startedAt=new Date().toISOString();
  const onState=(state:ScannerState)=>{
    latest=state;
    progress.textContent=`${state.status}\n읽음 ${state.currentRunRead??0} / ${state.expected??'?'} · 카드 ${state.cards.length}`;
  };
  try{
    if(sequential){
      // Deterministic: the scanner's own sequential input, fed from the server recording.
      let only:Set<number>|undefined;
      if(modeValue==='subset'||modeValue==='located'){
        // Frames a full run admitted crops from, plus each one's predecessor
        // (the scanner compares a frame with the one before it for stability).
        const source=[...runs].reverse().find(item=>item.summary?.mode==='sequential'&&item.summary.faithful);
        if(!source)throw Error('먼저 순차 실행을 한 번 해야 합니다.');
        const full=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs/${source.name}`)).json() as RunReport;
        const chosen=modeValue==='located'?full.locatedFrameTimes:full.usedFrameTimes;
        if(!chosen?.length)throw Error('그 실행에는 프레임 선택 정보가 없습니다. 순차 실행을 다시 하세요.');
        const {lines}=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/lines`)).json() as {lines:{deliveredAtMs:number}[]};
        const used=new Set(chosen);only=new Set<number>();
        lines.forEach((line,index)=>{
          const time=line.deliveredAtMs/1000;
          if(used.has(time)){only!.add(time);if(index>0)only!.add(lines[index-1].deliveredAtMs/1000);}
        });
        subsetOf={run:source.name,frames:only.size,of:lines.length};
      }
      const stream=await openRecordedShareStream({recordingId,signal,...(only?{only}:{})});
      statusLine.textContent=only?`사용 프레임만 재실행 중… (${only.size}/${stream.frameCount})`:'순차 재실행 중…';
      await runScanner(document.createElement('video'),'screen',signal,onState,[],undefined,'all',undefined,false,
        {nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION,shareRecording:'off',
          onCountCalibration:rows=>{calibration=rows;},
          onFrameAdmitted:(captureTime:number)=>{if(!usedSeen.has(captureTime)){usedSeen.add(captureTime);usedTimes.push(captureTime);}},
          onFrameLocated:(captureTime:number)=>{if(!locatedSeen.has(captureTime)){locatedSeen.add(captureTime);locatedTimes.push(captureTime);}},
          replay:{kind:'loacard-capture',version:1,createdAt:startedAt,source:'screen',rowMode:'all',captureOnly:false,seed:[],frames:[],truncated:false},
          replayInputs:stream.frames()});
      delivery={meanLateMs:0,maxLateMs:0,lateOver33Ms:0,frames:stream.delivered(),declaredFrames:only?only.size:stream.frameCount,mode:'sequential',
        recordingId,recordingComplete:stream.meta.complete,recordingSha256:stream.meta.sha256};
    }else{
      input=await prepareRecordedShareInput({recordingId,target:share,signal});
      statusLine.textContent='실시간 재실행 중…';
      await runScanner(share,'screen',signal,onState,[],()=>{void input!.start().catch(()=>{});},'all',undefined,false,
        {nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION,shareRecording:'off'});
      delivery={...input.delivery(),mode:'realtime'};
    }
    if(!latest)throw Error('결과가 없습니다.');
    const cards:RunCard[]=latest.cards.map(card=>({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,observations:card.observations}));
    if(!delivery)throw Error('전달 정보가 없습니다.');
    const report:RunReport={
      kind:'recording-replay',version:1,startedAt,finishedAt:new Date().toISOString(),
      recording:{id:recordingId,sha256:delivery.recordingSha256,complete:delivery.recordingComplete,frames:delivery.declaredFrames},
      delivery,status:latest.status,cards,usedFrameTimes:usedTimes,locatedFrameTimes:locatedTimes,
      ...(calibration?{countCalibration:calibration}:{}),
      countReview:latest.cards.filter(card=>card.extraCopies===null||peek.has(card.name)).slice(0,12).map(card=>({name:card.name,awakening:card.awakening,
        review:card.review,countReliable:card.countReliable??null,time:card.time??null,observations:card.observations??null,diagnostics:card.countDiagnostics??null,
        ...(card.image?{image:card.image}:{})})),
      unresolved:{unidentified:summarizeUnresolved(latest.unidentified),discarded:summarizeUnresolved(latest.discardedObservations),
        recognitionNeeded:(latest.recognitionNeeded??[]).map(item=>({slot:item.slot,captureTime:item.captureTime,reason:item.reason}))},...(subsetOf?{subsetOf}:{}),
      summary:summarizeRun({build:import.meta.env.VITE_BUILD_REVISION??'local',read:latest.currentRunRead??0,expected:latest.expected,
        unidentified:latest.unidentified?.length??0,delivery}),
    };
    const saved=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs`,{method:'POST',body:JSON.stringify(report)})).json() as {name:string};
    statusLine.textContent=`완료 · 저장됨 ${saved.name}`;
    await loadRuns();
  }catch(error){
    statusLine.textContent=signal.aborted?'중지됨':`실패: ${error instanceof Error?error.message:String(error)}`;
  }finally{
    input?.dispose();controller=undefined;busy(false);
  }
}

$('#refresh').addEventListener('click',()=>{void loadRecordings();void loadRuns();});
startButton.addEventListener('click',()=>{void run();});
stopButton.addEventListener('click',()=>controller?.abort());
void loadRecordings();
