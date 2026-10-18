import {decodedFrames} from './decoded-frames';
import {recordingBitrate} from './capture-settings';
import {createRecordingSpool} from './recording-spool';
import type {RecordingSpool} from './recording-spool';

export interface ContinuousRecording {blob:Blob;duration:number;dispose?:()=>Promise<void>}
/** The encoder is independent of OCR. Chunks are written through a bounded
 * queue, not accumulated for the entire duration of the shared screen. */
export function recordContinuous(stream:MediaStream,report:(message:string)=>void,
  Recorder:typeof MediaRecorder=MediaRecorder,limit=256*1024*1024,stopTimeoutMs=10_000,
  spoolFactory:()=>Promise<RecordingSpool>=createRecordingSpool,backlogLimit=16*1024*1024) {
  const mimeType=['video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'].find(type=>Recorder.isTypeSupported(type));
  if(!mimeType)throw Error('연속 화면 기록을 지원하지 않는 브라우저입니다.');
  const track=stream.getVideoTracks?.()[0];
  if(track&&'contentHint' in track)track.contentHint='text';
  const recorder=new Recorder(stream,{mimeType,videoBitsPerSecond:recordingBitrate(track?.getSettings()??{})});
  const spool=spoolFactory();
  let writes=Promise.resolve(),bytes=0,backlog=0,peakBacklog=0,failed=false,settled=false,finishing=false,stoppedAt=0,stopped=false;
  let stopTimer:ReturnType<typeof setTimeout>|undefined;
  const startedAt=performance.now();
  let resolve!:(value:ContinuousRecording|undefined)=>void;
  const completed=new Promise<ContinuousRecording|undefined>(done=>{resolve=done;});
  const fail=(message:string)=>{if(failed)return;failed=true;report(message);};
  const cleanup=()=>{
    clearTimeout(stopTimer);
    recorder.removeEventListener('dataavailable',onData);recorder.removeEventListener('error',onError);recorder.removeEventListener('stop',onStop);
  };
  const abandon=()=>{
    if(settled)return;
    settled=true;cleanup();resolve(undefined);
    void writes.then(()=>spool).then(value=>value.dispose()).catch(()=>{});
  };
  const onStop=()=>{
    if(settled||stopped)return;
    stopped=true;
    // Keep the deadline active while pending disk writes/close finish.
    void writes.then(async()=>{
      if(settled)return;
      if(failed||!bytes){abandon();return;}
      const output=await spool;
      const blob=await output.finish(recorder.mimeType||mimeType);
      if(settled){await output.dispose();return;}
      settled=true;cleanup();resolve({blob,duration:((stoppedAt||performance.now())-startedAt)/1000,dispose:()=>output.dispose()});
    }).catch(error=>{fail(`연속 기록 저장 실패: ${String(error)}`);abandon();});
  };
  const finish=()=>{
    if(finishing||settled)return completed;
    finishing=true;stoppedAt=performance.now();
    stopTimer=setTimeout(()=>{fail('녹화 종료 시간 초과 · 수집된 카드는 유지됩니다.');abandon();},stopTimeoutMs);
    try{if(recorder.state!=='inactive')recorder.stop();else onStop();}
    catch{fail('녹화 종료 실패 · 수집된 카드는 유지됩니다.');abandon();}
    return completed;
  };
  const onData=(event:BlobEvent)=>{
    if(failed||settled||stopped||!event.data.size)return;
    bytes+=event.data.size;
    if(bytes>limit||backlog+event.data.size>backlogLimit){
      fail('연속 기록 용량 또는 저장 대기 한도 초과 · 재현 기록을 저장하지 못했습니다. 수집된 카드는 유지됩니다.');void finish();return;
    }
    const blob=event.data;backlog+=blob.size;peakBacklog=Math.max(peakBacklog,backlog);
    writes=writes.then(async()=>{if(!failed)await (await spool).write(blob);})
      .catch(error=>{fail(`연속 기록 저장 실패: ${String(error)}`);void finish();})
      .finally(()=>{backlog-=blob.size;});
  };
  const onError=()=>{fail('연속 화면 기록에 실패했습니다. 수집된 카드는 유지됩니다.');void finish();};
  void spool.catch(error=>{fail(`연속 기록 준비 실패: ${String(error)}`);void finish();});
  recorder.addEventListener('dataavailable',onData);recorder.addEventListener('error',onError);recorder.addEventListener('stop',onStop,{once:true});
  try{recorder.start(500);}catch(error){void spool.then(value=>value.dispose()).catch(()=>{});throw error;}
  return {finish,startedAt,get bufferedBytes(){return backlog;},get peakBufferedBytes(){return peakBacklog;}};
}
export async function* recordedFrames(recording:ContinuousRecording,signal:AbortSignal){yield* decodedFrames(recording.blob,signal);}
