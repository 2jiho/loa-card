import {requestWindowShare,stopShareStream} from '../src/app/share-commands';
import {startShareRecorder} from '../src/features/card-scanner/reproduction/share-recorder';
import {runRowLive} from './row-live';

/** Development page: the row-centred prototype on a real screen share.
 *
 * It is the prototype of dev/row-live.ts, not a scan: it names cards and confirms their values
 * with the scanner's acceptance and merge, and runs the end-of-share zero check, but has no header
 * total, freshness proof or completion decision, and changes no saved card list. The share is
 * recorded on the development server like a scanner share (docs/dev-recording.md), and the result
 * is saved next to that recording. */
const BASE='/__rec';
const $=<T extends HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
const startButton=$<HTMLButtonElement>('#start'),stopButton=$<HTMLButtonElement>('#stop');
const statusLine=$('#status'),progress=$('#progress'),countsLine=$('#counts'),resultBox=$('#result'),video=$<HTMLVideoElement>('#share');

function cell(row:HTMLTableRowElement,text:string):void {row.insertCell().textContent=text;}

async function run():Promise<void> {
  startButton.disabled=true;resultBox.replaceChildren();countsLine.textContent='';progress.textContent='';
  const startedAt=new Date().toISOString();
  let stream:MediaStream|undefined;
  const controller=new AbortController();
  try{
    statusLine.textContent='공유할 창을 고르세요…';
    stream=(await requestWindowShare()).stream;
    const shared=stream,track=shared.getVideoTracks()[0];
    video.srcObject=shared;await video.play().catch(()=>{});
    let recorderFailure:string|null=null;
    // ?rec=0: do not record this share (to see whether the recorder changes what the track delivers).
    const recorder=new URLSearchParams(location.search).get('rec')==='0'?null:startShareRecorder(shared,{environment:{userAgent:navigator.userAgent,build:import.meta.env.VITE_BUILD_REVISION,path:'row-share'},
      onFailure:message=>{recorderFailure=message;}});
    let finish!:()=>void;
    const ended=new Promise<void>(resolve=>{finish=resolve;});
    track.addEventListener('ended',()=>finish(),{once:true});
    stopButton.onclick=()=>finish();
    statusLine.textContent='판독기를 준비하는 중… (준비가 끝난 뒤 카드 목록을 넘겨 주세요)';
    const shareStarted=performance.now();
    const result=await runRowLive({target:video,signal:controller.signal,relativeTime:true,
      // ?source=main: read the track on the main thread (as the first version did), for comparison.
      mainReader:new URLSearchParams(location.search).get('source')==='main',
      // Stopping the tracks ends the frame source, so the frames taken before the end are read and the run finishes.
      input:{start:()=>ended.then(()=>{stopShareStream(shared);}),dispose:()=>{}},
      onReady:()=>{
        stopButton.disabled=false;
        statusLine.textContent='읽는 중 · 준비 '+((performance.now()-shareStarted)/1000).toFixed(1)+'초'+(recorder?' · 기록 '+recorder.id:' · 기록 없음');
      },
      onLocated:()=>recorder?.located(),
      onCounts:counts=>{countsLine.textContent='이름 붙인 카드 '+counts.cards+' · 확정 '+(counts.confirmed??counts.complete);},
      onProgress:text=>{progress.textContent=text;}});
    stopButton.disabled=true;
    stopShareStream(shared);video.srcObject=null;
    statusLine.textContent='기록을 닫는 중…';
    const stats=recorder?.stats();
    await recorder?.stop();
    const live=result.live,evidence=live.evidence,left=(evidence?.cards??[]).filter(card=>!card.confirmed);
    countsLine.textContent='이름 붙인 카드 '+result.cards.length+' · 공유 종료 시 확정 '+(live.atShareEnd.confirmed??live.atShareEnd.complete)+' · 0장 확인 뒤 확정 '+(live.afterZeroCheck?.confirmed??'-');
    progress.textContent=[
      '공유 '+live.shareSeconds+'초 · 받은 프레임 '+live.presentedFrames+' · 읽은 프레임 '+live.readFrames+' · 줄에서 버린 프레임 '+live.line.dropped+' · 트랙이 먼저 버린 프레임 '+(live.sourceDiscarded??'-')+' / 트랙이 본 프레임 '+(live.sourceTotal??'-'),
      '트랙 설정 '+(live.track?.frameRate??'-')+'fps · 브라우저 집계(전달/버림/전체) '+(live.track?.stats?live.track.stats.deliveredFrames+'/'+live.track.stats.discardedFrames+'/'+live.track.stats.totalFrames:'-'),
      '트랙 읽기 '+(live.reader==='worker'?'워커':'메인 스레드')+' · 메인 스레드가 멈춘 가장 긴 시간 '+live.mainThread.maxGapMs+'ms (100ms 넘은 횟수 '+live.mainThread.gapsOver100Ms+')',
      '공유 종료 뒤 남은 프레임 처리 '+live.line.catchUpMs+'ms · 0장 확인 '+(live.afterZeroCheck?live.afterZeroCheck.ms+'ms ('+(live.afterZeroCheck.resolved.join(', ')||'확정 없음')+')':'안 함'),
    ].join('\n');
    if(left.length){
      const table=document.createElement('table'),head=table.createTHead().insertRow();
      for(const title of ['확정되지 않은 카드','각성','장수','이유','관측']){const th=document.createElement('th');th.textContent=title;head.append(th);}
      const body=table.createTBody();
      for(const card of left){const row=body.insertRow();cell(row,card.name);cell(row,String(card.awakening??'?'));cell(row,String(card.extraCopies??'?'));cell(row,card.review.join(' · '));cell(row,String(card.observations));}
      resultBox.append(table);
    }
    let saved='저장 안 함(기록 없음)';
    if(recorder){
      const {cards,...measurement}=result;
      const latestRead=(card:typeof cards[number],key:'awakening'|'extraCopies')=>[...card.observations].reverse().find(observation=>observation[key]!==null)?.[key]??null;
      try{
        const response=await fetch(BASE+'/'+encodeURIComponent(recorder.id)+'/runs',{method:'POST',body:JSON.stringify({
          kind:'row-live',version:1,startedAt,finishedAt:new Date().toISOString(),recording:{id:recorder.id},
          status:'줄 중심 실제 공유 · 카드 '+cards.length,
          cards:cards.map(card=>({id:card.id,name:card.name,awakening:latestRead(card,'awakening'),extraCopies:latestRead(card,'extraCopies'),observations:card.observations.length})),
          measurement,observations:cards,comparison:null,recorder:{...stats,failure:recorderFailure??stats?.failure??null},
          sourceSignature:String(import.meta.env.VITE_REPLAY_SIGNATURE??'').slice(0,16),
          summary:{build:import.meta.env.VITE_BUILD_REVISION??'local',read:cards.length,expected:null,unidentified:0,meanLateMs:0,maxLateMs:0,lateOver33Ms:0,deliveredRatio:1,mode:'rowlive-share',faithful:true}})});
        saved=response.ok?'저장됨 '+((await response.json()) as {name:string}).name+' (기록 '+recorder.id+')':'저장 실패 '+response.status+' (카드 창이 잡히지 않아 기록이 없을 수 있음)';
      }catch(error){saved='저장 실패: '+(error instanceof Error?error.message:String(error));}
    }
    statusLine.textContent='끝 · '+saved+(recorderFailure?' · 기록 오류: '+recorderFailure:'');
  }catch(error){
    statusLine.textContent='실패: '+(error instanceof Error?error.message:String(error));
  }finally{
    controller.abort();
    stopShareStream(stream);video.srcObject=null;
    startButton.disabled=false;stopButton.disabled=true;
  }
}

startButton.addEventListener('click',()=>{void run();});
