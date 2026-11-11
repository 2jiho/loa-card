/** An encoded-stream journal. Raw pixels and full replay files never enter this
 * queue. The target must abort its write transaction when signal is aborted. */
export interface RecordingJournalChunk {
  readonly kind:'exact'|'video';
  readonly sequence:number;
  readonly blob:Blob;
}
export interface RecordingJournal {
  write(chunk:RecordingJournalChunk,signal?:AbortSignal):Promise<void>;
  /** Producer loss marks the session partial; the producer stops its own
   * stream. Another independent stream can still persist usable input. */
  incomplete(reason:string):void|Promise<void>;
}
export interface RecordingJournalStats {
  readonly offered:number;readonly written:number;readonly dropped:number;
  readonly writtenBytes:number;readonly pendingBytes:number;readonly peakPendingBytes:number;
  readonly complete:boolean;readonly error:string;
}
export interface StreamJournalStats {enabled:boolean;complete:boolean;chunks:number;bytes:number;peakPendingBytes:number;error:string}
export const MAX_JOURNAL_CHUNK_BYTES=4*1024*1024;
export const JOURNAL_CHUNK_BYTES=256*1024;
export const JOURNAL_PENDING_BYTES=8*1024*1024;
interface Entry {chunk:RecordingJournalChunk;signal?:AbortSignal;resolve:()=>void;reject:(reason:unknown)=>void}

/** One target-owned queue can accept both streams. Admission is synchronous;
 * callers attach a rejection handler but never await it on the capture path.
 * An overload seals the already accepted prefix and refuses future chunks. */
export function createBoundedJournal(target:RecordingJournal,
  options:{maxPendingBytes?:number;timeoutMs?:number}={}) {
  const limit=options.maxPendingBytes??JOURNAL_PENDING_BYTES,timeoutMs=options.timeoutMs??15_000;
  if(!Number.isSafeInteger(limit)||limit<1||limit>64*1024*1024||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60_000)
    throw new TypeError('Invalid recording journal limits');
  const queue:Entry[]=[],nextSequence={exact:0,video:0};
  let pendingBytes=0,peakPendingBytes=0,offered=0,written=0,dropped=0,writtenBytes=0,error='',closed=false,finished=false;
  let processing:Promise<void>|undefined,active:AbortController|undefined;
  const notify=(reason:string)=>{try{void Promise.resolve(target.incomplete(reason)).catch(()=>{});}catch{/* Optional reporting cannot stop scanning. */}};
  const markIncomplete=(reason:unknown)=>{
    const message=(reason instanceof Error?reason.message:String(reason)).trim().slice(0,2000)||'기록 일부가 누락되었습니다.';
    if(!error){error=message;notify(error);}
  };
  const fail=(reason:unknown,dropWaiting=false)=>{
    markIncomplete(reason);closed=true;
    if(dropWaiting)while(queue.length){const entry=queue.shift()!;pendingBytes-=entry.chunk.blob.size;dropped++;entry.reject(Error(error));}
  };
  const snapshot=():RecordingJournalStats=>Object.freeze({offered,written,dropped,writtenBytes,pendingBytes,peakPendingBytes,
    complete:!error&&!pendingBytes,error});
  const perform=async(entry:Entry)=>{
    active=new AbortController();const controller=active;
    let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{},cancel:()=>void=()=>{};
    try{
      await new Promise<void>((resolve,reject)=>{
        cancel=()=>reject(controller.signal.reason);
        controller.signal.addEventListener('abort',cancel,{once:true});
        abort=()=>{controller.abort(entry.signal?.reason??new DOMException('기록 쓰기 취소','AbortError'));reject(controller.signal.reason);};
        entry.signal?.addEventListener('abort',abort,{once:true});
        if(entry.signal?.aborted){abort();return;}
        timer=setTimeout(()=>{controller.abort(Error('기록 청크 저장 시간 초과'));reject(controller.signal.reason);},timeoutMs);
        // Observe rejection even if timeout/cancel wins first. The target owns
        // transaction cancellation and must not commit after controller.abort.
        try{void Promise.resolve(target.write(entry.chunk,controller.signal)).then(resolve,reject);}catch(reason){reject(reason);}
      });
      written++;writtenBytes+=entry.chunk.blob.size;entry.resolve();
    }catch(reason){dropped++;entry.reject(reason);fail(reason,true);}
    finally{clearTimeout(timer);entry.signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',cancel);pendingBytes-=entry.chunk.blob.size;active=undefined;}
  };
  const pump=()=>{
    if(processing)return;
    processing=Promise.resolve().then(async()=>{while(queue.length)await perform(queue.shift()!);})
      .finally(()=>{processing=undefined;if(queue.length)pump();});
  };
  return {
    write(chunk:RecordingJournalChunk,signal?:AbortSignal):Promise<void>{
      if(closed)return Promise.reject(Error(error||'기록 저널이 종료되었습니다.'));
      if(!chunk||!['exact','video'].includes(chunk.kind)||!Number.isSafeInteger(chunk.sequence)||chunk.sequence<0||
        !(chunk.blob instanceof Blob)||!chunk.blob.size||chunk.blob.size>MAX_JOURNAL_CHUNK_BYTES||
        chunk.sequence!==nextSequence[chunk.kind]){
        fail('기록 청크 순서 또는 크기가 올바르지 않습니다.');return Promise.reject(Error(error));
      }
      if(signal?.aborted){fail(signal.reason);return Promise.reject(signal.reason);}
      offered++;
      if(pendingBytes+chunk.blob.size>limit||queue.length>=256){dropped++;fail('기록 청크 저장 대기 한도 초과');return Promise.reject(Error(error));}
      nextSequence[chunk.kind]++;pendingBytes+=chunk.blob.size;peakPendingBytes=Math.max(peakPendingBytes,pendingBytes);
      const owned=Object.freeze({kind:chunk.kind,sequence:chunk.sequence,blob:chunk.blob});
      const result=new Promise<void>((resolve,reject)=>queue.push({chunk:owned,signal,resolve,reject}));pump();return result;
    },
    incomplete(reason:string){markIncomplete(reason);},
    async finish(){closed=true;while(processing)await processing;finished=true;return snapshot();},
    dispose(){
      // Releasing an already joined journal is normal cleanup. Cancellation
      // during an unfinished write still marks loss and aborts that write.
      if(finished)return;
      fail('기록 저널이 중단되었습니다.',true);active?.abort(Error(error));
    },
    get stats(){return snapshot();},
  } satisfies RecordingJournal & {finish():Promise<RecordingJournalStats>;dispose():void;readonly stats:RecordingJournalStats};
}

/** Blob slices share backing storage. No full-file ArrayBuffer or base64 copy. */
export function* splitJournalBlob(kind:RecordingJournalChunk['kind'],blob:Blob,firstSequence=0):Generator<RecordingJournalChunk> {
  if(!Number.isSafeInteger(firstSequence)||firstSequence<0)throw new TypeError('Invalid journal sequence');
  let sequence=firstSequence;
  for(let offset=0;offset<blob.size;offset+=JOURNAL_CHUNK_BYTES)
    yield Object.freeze({kind,sequence:sequence++,blob:blob.slice(offset,Math.min(blob.size,offset+JOURNAL_CHUNK_BYTES))});
}
