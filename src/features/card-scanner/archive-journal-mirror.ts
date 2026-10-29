import {JOURNAL_PENDING_BYTES} from './recording-journal';

// Drain already encoded disk ranges in larger writes to amortize IndexedDB
// transactions. This is a maximum, not a batching threshold: a small available
// range is sent immediately. Total unacknowledged bytes remain bounded at 8MiB.
export const ARCHIVE_JOURNAL_CHUNK_BYTES=1024*1024;

/** Reads only acknowledged producer-file ranges. A slow journal grows two
 * offsets on disk, not a JavaScript queue of encoded frames. */
export function createArchiveJournalMirror(options:{
  read(offset:number,length:number):Blob|undefined|Promise<Blob|undefined>;
  send(sequence:number,blob:Blob):void;
  incomplete(reason:string):void;
  complete():void;
  maxPendingBytes?:number;chunkBytes?:number;
}) {
  const limit=options.maxPendingBytes??JOURNAL_PENDING_BYTES,
    chunkBytes=options.chunkBytes??Math.min(ARCHIVE_JOURNAL_CHUNK_BYTES,limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>64*1024*1024||!Number.isSafeInteger(chunkBytes)||chunkBytes<1||chunkBytes>4*1024*1024||chunkBytes>limit)
    throw Error('Invalid archive journal mirror bounds');
  const pending=new Map<number,number>();
  let available=0,sent=0,sequence=0,pendingBytes=0,peakPendingBytes=0,ackedBytes=0,running=false,sealed=false,done=false,error='',wakeRequested=false;
  const fail=(reason:unknown)=>{
    if(error||done)return;error=String(reason).slice(0,2000);
    try{options.incomplete(error);}catch{/* Reporting is independent of capture. */}
  };
  const finish=()=>{
    if(!done&&!error&&sealed&&!running&&sent===available&&!pending.size){
      done=true;
      try{options.complete();}catch(reason){done=false;fail(reason);}
    }
  };
  const pump=()=>{
    if(done||error)return;
    if(running){wakeRequested=true;return;}
    running=true;
    wakeRequested=false;
    void Promise.resolve().then(async()=>{
      while(!error&&!done&&sent<available){
        // The current available range and credits consume earlier wakes. Only a
        // request arriving during this attempt can justify retrying undefined.
        wakeRequested=false;
        const length=Math.min(chunkBytes,available-sent);
        if(pendingBytes+length>limit||pending.size>=256)break;
        const blob=await options.read(sent,length);
        if(!blob)break; // Async OPFS fallback becomes readable after close.
        if(error||done)break;
        if(!(blob instanceof Blob)||blob.size!==length)throw Error('기록 저널 읽기 범위 불일치');
        const id=sequence++;pending.set(id,length);pendingBytes+=length;peakPendingBytes=Math.max(peakPendingBytes,pendingBytes);
        sent+=length;options.send(id,blob);
      }
    }).catch(fail).finally(()=>{
      running=false;
      const wake=wakeRequested;wakeRequested=false;
      if(wake&&!done&&!error&&sent<available)pump();
      finish();
    });
  };
  return {
    update(bytes:number){
      if(done||error)return;
      if(!Number.isSafeInteger(bytes)||bytes<available||sealed){fail('기록 저널 생산 순서 오류');return;}
      available=bytes;pump();
    },
    acknowledge(id:number,bytes:number){
      if(error||done)return;
      if(!pending.has(id)||pending.get(id)!==bytes){fail('기록 저널 확인 응답 불일치');return;}
      pending.delete(id);pendingBytes-=bytes;ackedBytes+=bytes;pump();finish();
    },
    seal(bytes:number){
      if(done||error)return;
      if(!Number.isSafeInteger(bytes)||bytes<available){fail('기록 저널 종료 범위 오류');return;}
      available=bytes;sealed=true;pump();finish();
    },
    stop(reason='기록 저널이 중단되었습니다.') {fail(reason);pending.clear();pendingBytes=0;},
    get stats(){return Object.freeze({availableBytes:available,sentBytes:sent,acknowledgedBytes:ackedBytes,pendingBytes,peakPendingBytes,
      chunks:sequence,complete:done,error});},
  };
}
export type ArchiveJournalMirror=ReturnType<typeof createArchiveJournalMirror>;
