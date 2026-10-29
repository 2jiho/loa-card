import {decodedFrames} from './decoded-frames';
import {withMediaLineage} from './media-lineage';
import type {MediaLineageOptions} from './media-lineage';
import {recordingBitrate} from './capture-settings';
import {createRecordingSpool} from './recording-spool';
import type {RecordingSpool} from './recording-spool';
import {splitJournalBlob} from './recording-journal';
import type {RecordingJournal,RecordingJournalChunk,StreamJournalStats} from './recording-journal';

export interface ContinuousRecording {blob:Blob;duration:number;dispose?:()=>Promise<void>;finishJournal?:(timeoutMs?:number)=>Promise<StreamJournalStats>}
/** The encoder is independent of OCR. Chunks are written through a bounded
 * queue, not accumulated for the entire duration of the shared screen. */
export function recordContinuous(stream:MediaStream,report:(message:string)=>void,
  Recorder:typeof MediaRecorder=MediaRecorder,limit=256*1024*1024,stopTimeoutMs=10_000,
  spoolFactory:()=>Promise<RecordingSpool>=createRecordingSpool,backlogLimit=16*1024*1024,journal?:RecordingJournal) {
  const mimeType=['video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'].find(type=>Recorder.isTypeSupported(type));
  if(!mimeType)throw Error('연속 화면 기록을 지원하지 않는 브라우저입니다.');
  const track=stream.getVideoTracks?.()[0];
  if(track&&'contentHint' in track)track.contentHint='text';
  const recorder=new Recorder(stream,{mimeType,videoBitsPerSecond:recordingBitrate(track?.getSettings()??{})});
  const spool=spoolFactory();
  let writes=Promise.resolve(),bytes=0,backlog=0,peakBacklog=0,failed=false,settled=false,finishing=false,stoppedAt=0,stopped=false;
  let stopTimer:ReturnType<typeof setTimeout>|undefined;
  const startedAt=performance.now();
  let journalSequence=0,journalChunks=0,journalBytes=0,journalPending=0,journalPeak=0,journalError='';
  const journalAbort=new AbortController(),journalWrites=new Set<Promise<void>>();
  let journalTail=Promise.resolve();
  const journalFailure=(reason:unknown)=>{
    if(journalError)return;journalError=String(reason).slice(0,2000);
    try{void Promise.resolve(journal?.incomplete(journalError)).catch(()=>{});}catch{/* Journal reporting cannot stop capture. */}
  };
  const journalStats=():StreamJournalStats=>({enabled:!!journal,complete:!!journal&&stopped&&!failed&&!journalPending&&!journalError,
    chunks:journalChunks,bytes:journalBytes,peakPendingBytes:journalPeak,error:journalError});
  // A target normally aborts its IDB transaction itself. Racing its promise
  // also releases our event loop/Blob reservation if a target ignores abort.
  const writeJournalChunk=(chunk:RecordingJournalChunk)=>new Promise<void>((resolve,reject)=>{
    const signal=journalAbort.signal;
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    if(signal.aborted){reject(signal.reason);return;}
    signal.addEventListener('abort',abort,{once:true});
    try{Promise.resolve(journal!.write(chunk,signal)).then(()=>{
      signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve();
    },error=>{signal.removeEventListener('abort',abort);reject(error);});}
    catch(error){signal.removeEventListener('abort',abort);reject(error);}
  });
  const finishJournal=async(timeoutMs=15_000)=>{
    if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw Error('영상 저널 종료 시간 설정 오류');
    if(failed)journalFailure('영상 기록이 중단되었습니다.');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([Promise.allSettled([...journalWrites]),new Promise<void>(resolve=>{
        timer=setTimeout(()=>{journalFailure('영상 저널 저장 시간 초과');journalAbort.abort(Error(journalError));resolve();},timeoutMs);
      })]);
      // Every producer promise observes abort, so this join cannot be held by
      // a noncooperative sink after the deadline has already won the race.
      if(journalAbort.signal.aborted)await Promise.allSettled([...journalWrites]);
      return journalStats();
    }finally{clearTimeout(timer);}
  };
  const recordChunk=(blob:Blob)=>{
    if(!journal||journalError)return;
    // MediaRecorder may emit a >8MiB event even with a 500ms timeslice. Reserve
    // its shared encoded backing once (the same 16MiB event backlog as spool),
    // then offer one small slice at a time to the independent 8MiB common sink.
    // Count the complete event until its last slice settles: a Blob slice may
    // keep that event's backing alive, even after earlier slices were written.
    if(blob.size>backlogLimit||journalPending+blob.size>backlogLimit||journalWrites.size>=256){
      journalFailure('영상 저널 저장 대기 한도 초과');return;
    }
    journalPending+=blob.size;journalPeak=Math.max(journalPeak,journalPending);
    const write=journalTail.then(async()=>{
      for(const chunk of splitJournalBlob('video',blob,journalSequence)){
        if(journalError)throw Error(journalError);
        journalAbort.signal.throwIfAborted();
        await writeJournalChunk(chunk);
        journalSequence++;journalChunks++;journalBytes+=chunk.blob.size;
      }
    }).catch(journalFailure).finally(()=>{journalPending-=blob.size;journalWrites.delete(write);});
    journalWrites.add(write);journalTail=write;
  };
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
      settled=true;cleanup();resolve({blob,duration:((stoppedAt||performance.now())-startedAt)/1000,finishJournal,
        dispose:async()=>{
          journalAbort.abort(new DOMException('영상 저널 중단','AbortError'));
          await Promise.allSettled([...journalWrites]);await output.dispose();
        }});
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
    recordChunk(blob);
    writes=writes.then(async()=>{if(!failed)await (await spool).write(blob);})
      .catch(error=>{fail(`연속 기록 저장 실패: ${String(error)}`);void finish();})
      .finally(()=>{backlog-=blob.size;});
  };
  const onError=()=>{fail('연속 화면 기록에 실패했습니다. 수집된 카드는 유지됩니다.');void finish();};
  void spool.catch(error=>{fail(`연속 기록 준비 실패: ${String(error)}`);void finish();});
  recorder.addEventListener('dataavailable',onData);recorder.addEventListener('error',onError);recorder.addEventListener('stop',onStop,{once:true});
  try{recorder.start(500);}catch(error){void spool.then(value=>value.dispose()).catch(()=>{});throw error;}
  return {finish,finishJournal,startedAt,get journalStats(){return journalStats();},get bufferedBytes(){return backlog;},get peakBufferedBytes(){return peakBacklog;},
    get journalBufferedBytes(){return journalPending;},get journalPendingEvents(){return journalWrites.size;}};
}
/** The explicit RGBA recipe is a development experiment. Keep the existing
 * recovery decoder as the default until paced field/completion checks pass. */
export async function* recordedFrames(recording:ContinuousRecording,signal:AbortSignal,options:{explicitRgba?:boolean;nativePrepared?:boolean;lineage?:MediaLineageOptions}={}){
  if(options.nativePrepared&&options.explicitRgba)throw Error('영상 복원 방식은 하나만 선택할 수 있습니다.');
  async function* decoded(){
    if(options.nativePrepared){
      const {preparedDecodedFrames}=await import('./prepared-decoded-frames');
      yield* preparedDecodedFrames(recording.blob,signal);
    }else if(options.explicitRgba){
      const {decodedRgbaFrames}=await import('./decoded-rgba-client');
      for await(const frame of decodedRgbaFrames(recording.blob,signal))
        yield {...frame,decodeSample:{trackId:frame.decoded.trackId,duration:frame.decoded.duration}};
    }else yield* decodedFrames(recording.blob,signal);
  }
  if(options.lineage)yield* withMediaLineage(decoded(),recording.blob,signal,options.lineage);
  else yield* decoded();
}
