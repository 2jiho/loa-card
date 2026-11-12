import {runScanner} from '../src/features/card-scanner/orchestration/scanner';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';
import {NORMAL_SCANNER_NAME_CONFIGURATION} from '../src/features/card-scanner/session/scanner-name-configuration';
import {prepareRecordedShareInput} from './recorded-share-input';
import {openRecordedShareStream} from './recorded-share-frames';
import type {RecordedShareInput} from './recorded-share-input';
import {analyzeReads,summarizeReadProfiles,comparabilityIssues,diffRuns,summarizeRun,summarizeUnresolved} from './recording-runs';
import type {RunCard,RunDeliveryLike,RunReport,RunSummary} from './recording-runs';
import {compareLean,runLeanScan} from './lean-scan';
import {runRowScan} from './row-scan';
import {runCardMap} from './card-map';
import {runGridFit} from './grid-fit';
import {runArtFail} from './art-fail';
import {runRowRead} from './row-read';
import {runRowLight} from './row-light';
import {runRowLive} from './row-live';
import {analyzeRows} from './row-analysis';
import type {LeanCard} from './lean-scan';
import {parsePolicy} from '../src/features/card-scanner/capture/frame-similarity';
import type {LiveTimelinePoint} from '../src/features/card-scanner/reproduction/live-run-report';
import type {ContinuousRecording} from '../src/features/card-scanner/capture/continuous-capture';

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

function loopMeans(rows:readonly {collectMs:number;drainMs:number;drained:number}[]) {
  const total=(pick:(row:(typeof rows)[number])=>number)=>rows.reduce((sum,row)=>sum+pick(row),0);
  return {frames:rows.length,collectMs:Math.round(total(row=>row.collectMs)),drainMs:Math.round(total(row=>row.drainMs)),cardsDrained:total(row=>row.drained)};
}

/** Mean per-frame cost of each stage, for frames with and without the card grid. */
function stageMeans(rows:readonly {located:boolean;copyMs:number;acquireMs:number;detectMs:number;timing?:Record<string,number>}[]) {
  const mean=(group:typeof rows)=>{
    const keys=new Set<string>();for(const row of group)for(const key of Object.keys(row.timing??{}))keys.add(key);
    const out:Record<string,number>={frames:group.length,copyMs:0,acquireMs:0,detectMs:0};
    for(const row of group){out.copyMs+=row.copyMs;out.acquireMs+=row.acquireMs;out.detectMs+=row.detectMs;for(const key of keys)out[key]=(out[key]??0)+(row.timing?.[key]??0);}
    if(group.length)for(const key of Object.keys(out))if(key!=='frames')out[key]=Math.round(out[key]/group.length*10)/10;
    return out;
  };
  return {located:mean(rows.filter(row=>row.located)),other:mean(rows.filter(row=>!row.located))};
}

/** Compact summary of the recovery probe: the first frame where the skip proof held. */
function summarizeProbe(rows:readonly {frame:number;time:number;idle:boolean;completeProof:boolean;read:number;unresolved:number;finalExpected:number|null;tailFresh:boolean}[]) {
  const first=rows.find(row=>row.completeProof),last=rows[rows.length-1];
  return {frames:rows.length,firstProofFrame:first?.frame??null,firstProofTime:first?.time??null,
    idleFrames:rows.filter(row=>row.idle).length,finalExpected:last?.finalExpected??null,tailFresh:last?.tailFresh??null,
    lastRead:last?.read??null,lastUnresolved:last?.unresolved??null,
    samples:rows.filter((_row,index)=>index%20===0).map(row=>({frame:row.frame,idle:row.idle,proof:row.completeProof,read:row.read,unresolved:row.unresolved}))};
}

function busy(value:boolean):void {startButton.disabled=value||!picked;stopButton.disabled=!value;}

async function run():Promise<void> {
  if(!picked||controller)return;
  const recordingId=picked;
  controller=new AbortController();busy(true);progress.textContent='';statusLine.textContent='기록을 여는 중…';
  const signal=controller.signal;
  let input:RecordedShareInput|undefined,latest:ScannerState|undefined;
  const modeValue=$<HTMLSelectElement>('#mode').value;
  // `realtime`: the live path with recording off (what the deployed app runs).
  // `realtime-detailed`: the live path with the detailed input recording on (the
  // development default), which adds the post-share recovery phase.
  // `realtime-batch`: `realtime` with the frame-batch visual reading experiment on.
  const batch=modeValue==='realtime-batch';
  let visualBatch:RunReport['visualBatch'];
  // ?rescue=tile|verify: the earlier per-cell rescue feature read, or both reads compared (scanner debug.rescueFeature).
  const rescueParam=new URLSearchParams(location.search).get('rescue');
  const rescue=rescueParam==='tile'||rescueParam==='verify'?rescueParam:undefined;
  let rescueFeature:RunReport['rescueFeature'];
  let frameFlow:RunReport['frameFlow'];
  // ?native=1 (live-path modes with the detailed recording): the scanner's experimental native
  // acquisition, which hands the worker the video frame itself instead of a canvas copy.
  const nativeAcquisition=new URLSearchParams(location.search).get('native')==='1';
  const live=modeValue==='realtime'||modeValue==='realtime-detailed'||batch;
  const detailed=modeValue==='realtime-detailed';
  const sequential=!live;
  const timeline:LiveTimelinePoint[]=[];
  const timelineStarted=performance.now();
  let lastTimelineAt=-Infinity;
  let calibration:readonly unknown[]|undefined;
  let continuousRecording:ContinuousRecording|undefined;
  let frameTiming:RunReport['frameTiming'];
  const loops:{time:number;collectMs:number;drainMs:number;drained:number}[]=[];
  const readProfiles:{stage:string;identified:boolean;spans:Readonly<Record<string,number>>}[]=[];
  const recoveryProbe:{frame:number;time:number;idle:boolean;completeProof:boolean;read:number;unresolved:number;expected:number|null;finalExpected:number|null;tailFresh:boolean}[]=[];
  const profiles:{time:number;located:boolean;copyMs:number;acquireMs:number;detectMs:number;timing?:Record<string,number>}[]=[];
  const runStarted=performance.now();
  // ?peek=name1,name2 adds those cards (with preview and count diagnostics) to the report's countReview.
  const peek=new Set((new URLSearchParams(location.search).get('peek')??'').split(',').map(name=>name.trim()).filter(Boolean));
  const usedTimes:number[]=[],usedSeen=new Set<number>(),locatedTimes:number[]=[],locatedSeen=new Set<number>();
  let subsetOf:RunReport['subsetOf'];
  let delivery:RunDeliveryLike&{recordingId:string;recordingComplete:boolean;recordingSha256:string|null}|undefined;
  const startedAt=new Date().toISOString();
  // ?profile=1 (scripts/run-recording-replay.mjs --cpuprofile): a main-thread CPU profile of the
  // sharing phase only, from the first delivered frame until the scanner leaves the capture phase.
  // console.profile records only while a debugger has the profiler enabled; otherwise it does nothing.
  const cpuProfile=new URLSearchParams(location.search).has('profile');
  let profiling:'idle'|'on'|'done'='idle';
  const endProfile=()=>{if(profiling==='on'){profiling='done';console.profileEnd('share');}};
  const onState=(state:ScannerState)=>{
    latest=state;
    if(profiling==='on'&&state.workPhase&&state.workPhase!=='capture')endProfile();
    {
      const now=performance.now();
      if(now-lastTimelineAt>=1000||state.interrupted){
        lastTimelineAt=now;
        timeline.push({t:Math.round((now-timelineStarted)/100)/10,read:state.currentRunRead??0,cards:state.cards.length,queued:state.queued??0,
          status:(state.status??'').slice(0,60),active:state.activeReadings??0,sampled:state.sampled??0,phase:state.workPhase??'',interrupted:state.interrupted??null});
      }
    }
    progress.textContent=`${state.status}\n읽음 ${state.currentRunRead??0} / ${state.expected??'?'} · 카드 ${state.cards.length}`;
  };
  try{
    if(modeValue==='rowread'||modeValue==='rowlight'||modeValue==='rowlive'){
      // Prototype measurements of the row-centred reading, not scans (dev/row-read.ts, dev/row-light.ts).
      const query=new URLSearchParams(location.search);
      const result=modeValue==='rowlive'?await runRowLive({recordingId,target:share,signal,names:query.get('names')!=='0',backgroundNames:query.get('inline')!=='1',placeNames:query.get('place')!=='0',softwareFrame:query.get('soft')==='1',serial:query.get('serial')==='1',warmNames:query.get('warm')!=='0',zeroCheck:query.get('zero')!=='0',videoSource:query.get('source')==='video',evidence:query.get('evidence')!=='0',...(query.has('queue')?{queue:Number(query.get('queue'))}:{}),...(query.has('readers')?{readers:Number(query.get('readers'))}:{}),
          ...(query.has('hold')?{nameHoldSeconds:Number(query.get('hold'))}:{}),onProgress:text=>{progress.textContent=text;}})
        :modeValue==='rowlight'?await runRowLight({recordingId,signal,...(Number(new URLSearchParams(location.search).get('handover'))>0?{handOverAfter:Number(new URLSearchParams(location.search).get('handover'))}:{}),onProgress:text=>{progress.textContent=text;}})
        :await runRowRead({recordingId,signal,names:new URLSearchParams(location.search).get('names')==='1',
          ...(new URLSearchParams(location.search).has('hold')?{nameHoldSeconds:Number(new URLSearchParams(location.search).get('hold'))}:{}),onProgress:text=>{progress.textContent=text;}});
      const listed=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs`)).json() as {runs:{name:string;summary:RunSummary|null}[]};
      // Compare with the newest full sequential scanner run of this recording, if there is one.
      let baseline:{name:string;report:RunReport}|undefined;
      for(const run of listed.runs.filter(item=>item.summary?.mode==='sequential'&&!String(item.summary.build).startsWith('HEAD')).sort((a,b)=>b.name.localeCompare(a.name)).slice(0,8)){
        const report=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs/${run.name}`)).json() as RunReport;
        if(report.kind==='recording-replay'&&!report.subsetOf){baseline={name:run.name,report};break;}
      }
      const latestRead=(card:LeanCard,key:'awakening'|'extraCopies')=>[...card.observations].reverse().find(observation=>observation[key]!==null)?.[key]??null;
      const {cards:readCards,...measurement}=result;
      const reads=measurement.probeReads+measurement.neededReads;
      const status=`줄 중심 판독 · 카드 ${readCards.length} · 읽은 크롭 ${reads}/${measurement.usableCrops}`;
      const saved=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs`,{method:'POST',body:JSON.stringify({
        kind:modeValue==='rowlive'?'row-live':modeValue==='rowlight'?'row-light':'row-read',version:1,startedAt,finishedAt:new Date().toISOString(),recording:{id:recordingId},status,
        cards:readCards.map(card=>({id:card.id,name:card.name,awakening:latestRead(card,'awakening'),extraCopies:latestRead(card,'extraCopies'),observations:card.observations.length})),
        measurement,observations:readCards,
        comparison:baseline?{run:baseline.name,...compareLean(readCards,baseline.report.cards)}:null,
        sourceSignature:String(import.meta.env.VITE_REPLAY_SIGNATURE??'').slice(0,16),
        summary:{build:import.meta.env.VITE_BUILD_REVISION??'local',read:readCards.length,expected:null,unidentified:0,meanLateMs:0,maxLateMs:0,lateOver33Ms:0,deliveredRatio:1,mode:modeValue,faithful:true}})})).json() as {name:string};
      statusLine.textContent=`완료 · 저장됨 ${saved.name}`;
      await loadRuns();
      return;
    }
    if(modeValue==='artfail'){
      // Why the artwork matcher rejects the crops it rejects, not a scan (dev/art-fail.ts).
      const result=await runArtFail({recordingId,signal,onProgress:text=>{progress.textContent=text;}});
      const saved=await (await fetch(BASE+'/'+encodeURIComponent(recordingId)+'/runs',{method:'POST',body:JSON.stringify({
        kind:'art-fail',version:1,startedAt,finishedAt:new Date().toISOString(),recording:{id:recordingId},
        status:'원화 대조 실패 분석 · 크롭 '+result.crops+' · 수락 '+result.accepted,cards:[],measurement:result,
        sourceSignature:String(import.meta.env.VITE_REPLAY_SIGNATURE??'').slice(0,16),
        summary:{build:import.meta.env.VITE_BUILD_REVISION??'local',read:result.accepted,expected:null,unidentified:0,meanLateMs:0,maxLateMs:0,lateOver33Ms:0,deliveredRatio:1,mode:'artfail',faithful:true}})})).json() as {name:string};
      statusLine.textContent='완료 · 저장됨 '+saved.name;
      await loadRuns();
      return;
    }
    if(modeValue==='gridfit'){
      // Grid measurement from the border outline, not a scan (dev/grid-fit.ts).
      const result=await runGridFit({recordingId,signal,onProgress:text=>{progress.textContent=text;}});
      const saved=await (await fetch(BASE+'/'+encodeURIComponent(recordingId)+'/runs',{method:'POST',body:JSON.stringify({
        kind:'grid-fit',version:1,startedAt,finishedAt:new Date().toISOString(),recording:{id:recordingId},
        status:'격자 맞춤 측정 · 장면 '+result.sampledFrames,cards:[],measurement:result,
        sourceSignature:String(import.meta.env.VITE_REPLAY_SIGNATURE??'').slice(0,16),
        summary:{build:import.meta.env.VITE_BUILD_REVISION??'local',read:result.cellsMeasured,expected:null,unidentified:0,meanLateMs:0,maxLateMs:0,lateOver33Ms:0,deliveredRatio:1,mode:'gridfit',faithful:true}})})).json() as {name:string};
      statusLine.textContent='완료 · 저장됨 '+saved.name;
      await loadRuns();
      return;
    }
    if(modeValue==='cardmap'){
      // Card layout measurement, not a scan (dev/card-map.ts).
      const result=await runCardMap({recordingId,signal,onProgress:text=>{progress.textContent=text;}});
      const saved=await (await fetch(BASE+'/'+encodeURIComponent(recordingId)+'/runs',{method:'POST',body:JSON.stringify({
        kind:'card-map',version:1,startedAt,finishedAt:new Date().toISOString(),recording:{id:recordingId},
        status:'카드 배치 측정 · 크롭 '+result.crops,cards:[],measurement:result,
        sourceSignature:String(import.meta.env.VITE_REPLAY_SIGNATURE??'').slice(0,16),
        summary:{build:import.meta.env.VITE_BUILD_REVISION??'local',read:result.crops,expected:null,unidentified:0,meanLateMs:0,maxLateMs:0,lateOver33Ms:0,deliveredRatio:1,mode:'cardmap',faithful:true}})})).json() as {name:string};
      statusLine.textContent='완료 · 저장됨 '+saved.name;
      await loadRuns();
      return;
    }
    if(modeValue==='rows'){
      // Feasibility measurement for a row-centred design, not a scan (dev/row-scan.ts, dev/row-analysis.ts).
      const scan=await runRowScan({recordingId,signal,onProgress:text=>{progress.textContent=text;}});
      // 55 list rows (52 scroll positions): confirmed in the game by the user on 2026-11-12; it follows the game's card catalog.
      const analysis=analyzeRows(scan.observations,55);
      const status=`줄 관측 · 줄 ${analysis.listRows} · 한 번도 온전히 안 보인 줄 ${analysis.rowSummary.neverClean.length} · 스크롤바 정확 ${Math.round(analysis.scrollbar.exact*100)}%`;
      const saved=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs`,{method:'POST',body:JSON.stringify({
        kind:'row-scan',version:1,startedAt,finishedAt:new Date().toISOString(),recording:{id:recordingId},status,
        cards:scan.cards.map(card=>({id:card.id,name:card.name,awakening:null,extraCopies:null})),
        measurement:{frames:scan.frames,locatedFrames:scan.locatedFrames,wallMs:scan.wallMs},analysis,observations:scan.observations,
        sourceSignature:String(import.meta.env.VITE_REPLAY_SIGNATURE??'').slice(0,16),
        summary:{build:import.meta.env.VITE_BUILD_REVISION??'local',read:scan.cards.length,expected:null,unidentified:0,meanLateMs:0,maxLateMs:0,lateOver33Ms:0,deliveredRatio:1,mode:'rows',faithful:true}})})).json() as {name:string};
      statusLine.textContent=`완료 · 저장됨 ${saved.name}`;
      await loadRuns();
      return;
    }
    if(modeValue==='lean'){
      // Prototype measurement, not a scan (dev/lean-scan.ts).
      const lanes=Number(new URLSearchParams(location.search).get('lanes'))||2;
      const lean=await runLeanScan({recordingId,signal,lanes,onProgress:text=>{progress.textContent=text;}});
      // Compare with the newest full sequential scanner run of this recording, if there is one.
      const listed=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs`)).json() as {runs:{name:string;summary:RunSummary|null}[]};
      let baseline:{name:string;report:RunReport}|undefined;
      for(const run of listed.runs.filter(item=>item.summary?.mode==='sequential'&&!String(item.summary.build).startsWith('HEAD')).sort((a,b)=>b.name.localeCompare(a.name)).slice(0,8)){
        const report=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs/${run.name}`)).json() as RunReport;
        if(report.kind==='recording-replay'&&!report.subsetOf){baseline={name:run.name,report};break;}
      }
      const latestRead=(card:LeanCard,key:'awakening'|'extraCopies')=>[...card.observations].reverse().find(observation=>observation[key]!==null)?.[key]??null;
      const {cards:leanCards,...measurement}=lean;
      const status=`가벼운 경로 시제품 · 창 있는 프레임당 ${measurement.locatedFrame.totalMs}ms · 카드 ${leanCards.length}`;
      const saved=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs`,{method:'POST',body:JSON.stringify({
        kind:'lean-prototype',version:1,startedAt,finishedAt:new Date().toISOString(),recording:{id:recordingId},status,
        cards:leanCards.map(card=>({id:card.id,name:card.name,awakening:latestRead(card,'awakening'),extraCopies:latestRead(card,'extraCopies'),observations:card.observations.length})),
        measurement,observations:leanCards,
        comparison:baseline?{run:baseline.name,...compareLean(leanCards,baseline.report.cards)}:null,
        sourceSignature:String(import.meta.env.VITE_REPLAY_SIGNATURE??'').slice(0,16),
        summary:{build:import.meta.env.VITE_BUILD_REVISION??'local',read:leanCards.length,expected:null,unidentified:0,meanLateMs:0,maxLateMs:0,lateOver33Ms:0,deliveredRatio:1,mode:'lean',faithful:true}})})).json() as {name:string};
      statusLine.textContent=`완료 · 저장됨 ${saved.name}`;
      await loadRuns();
      return;
    }
    if(sequential){
      // Deterministic: the scanner's own sequential input, fed from the server recording.
      let only:Set<number>|undefined;
      if(modeValue.startsWith('stride')){
        // Experiment: feed only every k-th recorded frame (always the last one).
        const step=Math.max(2,Number(modeValue.slice(6))||2);
        const {lines}=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/lines`)).json() as {lines:{deliveredAtMs:number}[]};
        only=new Set<number>();
        lines.forEach((line,index)=>{if(index%step===0||index===lines.length-1)only!.add(line.deliveredAtMs/1000);});
        subsetOf={run:`every ${step}th frame`,frames:only.size,of:lines.length};
      }
      // `skip:mean=1,block=6,force=8`: sequential replay that leaves out frames similar to the last processed one.
      const skip=modeValue.startsWith('skip:')?parsePolicy(modeValue.slice(5)):undefined;
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
      const stream=await openRecordedShareStream({recordingId,signal,...(only?{only}:{}),...(skip?{skip}:{})});
      statusLine.textContent=only?`사용 프레임만 재실행 중… (${only.size}/${stream.frameCount})`:'순차 재실행 중…';
      await runScanner(document.createElement('video'),'screen',signal,onState,[],undefined,'all',undefined,false,
        {nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION,shareRecording:'off',
          onCountCalibration:rows=>{calibration=rows;},
          onFrameAdmitted:(captureTime:number)=>{if(!usedSeen.has(captureTime)){usedSeen.add(captureTime);usedTimes.push(captureTime);}},
          onFrameProfile:profile=>{profiles.push(profile);},
          onFrameLoop:loop=>{loops.push(loop);},
          ...(rescue?{rescueFeature:rescue,onRescueFeature:(stats:{calls:number;ms:number;compared:number;different:number})=>{rescueFeature={mode:rescue,...stats,ms:Math.round(stats.ms)};}}:{}),
          onRecoveryProbe:probe=>{recoveryProbe.push(probe);},
          onReadProfile:profile=>{readProfiles.push(profile);},
          onFrameLocated:(captureTime:number)=>{if(!locatedSeen.has(captureTime)){locatedSeen.add(captureTime);locatedTimes.push(captureTime);}},
          replay:{kind:'loacard-capture',version:1,createdAt:startedAt,source:'screen',rowMode:'all',captureOnly:false,seed:[],frames:[],truncated:false},
          replayInputs:stream.frames()});
      {
        const summary=(rows:readonly {consumeMs:number;prepMs:number}[])=>({frames:rows.length,
          consumeMs:Math.round(rows.reduce((total,row)=>total+row.consumeMs,0)),prepMs:Math.round(rows.reduce((total,row)=>total+row.prepMs,0))});
        const all=stream.timings();
        frameTiming={frames:all.length,located:summary(all.filter(row=>locatedSeen.has(row.time))),
          other:summary(all.filter(row=>!locatedSeen.has(row.time))),wallMs:Math.round(performance.now()-runStarted),
          stages:stageMeans(profiles),
          loop:{located:loopMeans(loops.filter(row=>locatedSeen.has(row.time))),other:loopMeans(loops.filter(row=>!locatedSeen.has(row.time)))}};
      }
      if(skip)subsetOf={run:`skip similar frames: ${modeValue.slice(5)}`,frames:stream.delivered(),of:stream.frameCount};
      delivery={meanLateMs:0,maxLateMs:0,lateOver33Ms:0,frames:stream.delivered(),declaredFrames:only?only.size:skip?stream.delivered():stream.frameCount,mode:'sequential',
        recordingId,recordingComplete:stream.meta.complete,recordingSha256:stream.meta.sha256};
    }else{
      const until=Number(new URLSearchParams(location.search).get('until'));
      input=await prepareRecordedShareInput({recordingId,target:share,signal,...(Number.isFinite(until)&&until>0?{untilSeconds:until}:{})});
      statusLine.textContent='실시간 재실행 중…';
      await runScanner(share,'screen',signal,onState,[],()=>{if(cpuProfile&&profiling==='idle'){profiling='on';console.profile('share');}void input!.start().catch(()=>{});},'all',undefined,false,
        {nameConfiguration:NORMAL_SCANNER_NAME_CONFIGURATION,shareRecording:'off',
          onRecoveryProbe:probe=>{recoveryProbe.push(probe);},
          onReadProfile:profile=>{readProfiles.push(profile);},
          ...(rescue?{rescueFeature:rescue,onRescueFeature:(stats:{calls:number;ms:number;compared:number;different:number})=>{rescueFeature={mode:rescue,...stats,ms:Math.round(stats.ms)};}}:{}),
          ...(nativeAcquisition?{nativeAcquisition:true}:{}),
          onFrameFlow:flow=>{frameFlow=flow;},
          ...(batch?{frameBatchVisual:true,onVisualBatch:(stats:NonNullable<RunReport['visualBatch']>)=>{visualBatch=stats;}}:{}),
          ...(detailed?{recordingMode:'detailed' as const,
            // The scanner hands over its continuous recording and still decodes it for the recovery
            // phase, so it must stay alive until the scan ends (the app keeps it for its archive
            // and releases it afterwards). Releasing it here made the recovery read a revoked blob
            // ("network error").
            continuous:(recording:ContinuousRecording)=>{continuousRecording=recording;}}:{})});
      delivery={...input.delivery(),mode:'realtime'};
      // A share ended early is a different input from the whole recording; say so in the report.
      if(input.recordedFrames>delivery.declaredFrames)subsetOf={run:`share ended at ${until}s`,frames:delivery.declaredFrames,of:input.recordedFrames};
    }
    if(!live&&new URLSearchParams(location.search).has('until'))throw Error('until은 실시간 재실행(realtime) 모드에서만 쓸 수 있습니다.');
    if(!latest)throw Error('결과가 없습니다.');
    const cards:RunCard[]=latest.cards.map(card=>({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,observations:card.observations}));
    if(!delivery)throw Error('전달 정보가 없습니다.');
    const report:RunReport={
      kind:'recording-replay',version:1,startedAt,finishedAt:new Date().toISOString(),
      recording:{id:recordingId,sha256:delivery.recordingSha256,complete:delivery.recordingComplete,frames:delivery.declaredFrames},
      delivery,status:latest.status,cards,usedFrameTimes:usedTimes,locatedFrameTimes:locatedTimes,...(live?{liveReplay:{recordingMode:detailed?'detailed':'off',timeline,recoveryProbe:summarizeProbe(recoveryProbe),
        inputPipeline:latest.liveInputPipeline??null,performance:latest.livePerformance??null}}:{}),...(frameTiming?{frameTiming}:{}),
      ...(calibration?{countCalibration:calibration}:{}),
      countReview:latest.cards.filter(card=>card.extraCopies===null||peek.has(card.name)).slice(0,12).map(card=>({name:card.name,awakening:card.awakening,
        review:card.review,countReliable:card.countReliable??null,time:card.time??null,observations:card.observations??null,diagnostics:card.countDiagnostics??null,
        ...(card.image?{image:card.image}:{})})),
      unresolved:{unidentified:summarizeUnresolved(latest.unidentified),discarded:summarizeUnresolved(latest.discardedObservations),
        recognitionNeeded:(latest.recognitionNeeded??[]).map(item=>({slot:item.slot,captureTime:item.captureTime,reason:item.reason}))},...(subsetOf?{subsetOf}:{}),
      // The build label is the commit at server start; the source signature also tells
      // uncommitted versions apart.
      ...(latest.ledger?.traces.length?{readAnalysis:analyzeReads(latest.ledger.traces)}:{}),
      rejectedSamples:(latest.captureDiagnostics?.samples??[]).filter(sample=>!sample.accepted).map(({image,time,slot,reason,sharpness})=>({image,time,slot,reason,sharpness})),
      ...(readProfiles.length?{readProfile:summarizeReadProfiles(readProfiles)}:{}),
      ...(visualBatch?{visualBatch}:{}),
      ...(rescueFeature?{rescueFeature}:{}),
      ...(frameFlow?{frameFlow:{...frameFlow,consumeMs:Math.round(frameFlow.consumeMs),idleMs:Math.round(frameFlow.idleMs),maxConsumeMs:Math.round(frameFlow.maxConsumeMs),
        maxCallbackGapMs:Math.round(frameFlow.maxCallbackGapMs),firstCallbackMs:frameFlow.firstCallbackMs===null?null:Math.round(frameFlow.firstCallbackMs),
        lastCallbackMs:frameFlow.lastCallbackMs===null?null:Math.round(frameFlow.lastCallbackMs)}}:{}),
      ...(nativeAcquisition?{nativeAcquisition:true}:{}),
      sourceSignature:String(import.meta.env.VITE_REPLAY_SIGNATURE??'').slice(0,16),
      summary:summarizeRun({build:import.meta.env.VITE_BUILD_REVISION??'local',read:latest.currentRunRead??0,expected:latest.expected,
        unidentified:latest.unidentified?.length??0,delivery}),
    };
    const saved=await (await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs`,{method:'POST',body:JSON.stringify(report)})).json() as {name:string};
    statusLine.textContent=`완료 · 저장됨 ${saved.name}`;
    await loadRuns();
  }catch(error){
    statusLine.textContent=signal.aborted?'중지됨':`실패: ${error instanceof Error?error.message:String(error)}`;
    if(!signal.aborted){
      // Save why it failed next to the recording, so an unattended run (headless runner)
      // reports the reason instead of timing out.
      try{
        await fetch(`${BASE}/${encodeURIComponent(recordingId)}/runs`,{method:'POST',body:JSON.stringify({
          kind:'recording-replay-failure',version:1,startedAt,finishedAt:new Date().toISOString(),recording:{id:recordingId},
          mode:modeValue,error:error instanceof Error?`${error.name}: ${error.message}`:String(error),stack:error instanceof Error?String(error.stack).slice(0,3000):null,status:statusLine.textContent,
          lastProgress:progress.textContent.slice(0,400),interrupted:latest?.interrupted??null,timeline,summary:null})});
      }catch{/* The failure is still shown on the page. */}
    }
  }finally{
    endProfile();
    input?.dispose();void continuousRecording?.dispose?.().catch(()=>undefined);controller=undefined;busy(false);
  }
}

$('#refresh').addEventListener('click',()=>{void loadRecordings();void loadRuns();});
startButton.addEventListener('click',()=>{void run();});
stopButton.addEventListener('click',()=>controller?.abort());
void loadRecordings();
// ?autorun=<recording id>&mode=<mode>: run at once (used by scripts/run-recording-replay.mjs,
// which opens this page in a headless browser and waits for the saved report).
{
  const params=new URLSearchParams(location.search),auto=params.get('autorun');
  if(auto){
    picked=auto;
    const mode=params.get('mode');
    if(mode){
      const select=$<HTMLSelectElement>('#mode');
      if(![...select.options].some(option=>option.value===mode))select.append(new Option(mode,mode));
      select.value=mode;
    }
    startButton.disabled=false;
    // With ?profile the runner enables the profiler first and then sets this flag.
    const ready=()=>(window as unknown as {__profilerReady?:boolean}).__profilerReady===true;
    const waitStarted=performance.now();
    const begin=()=>{if(!params.has('profile')||ready()||performance.now()-waitStarted>15000)void run();else setTimeout(begin,50);};
    begin();
  }
}
