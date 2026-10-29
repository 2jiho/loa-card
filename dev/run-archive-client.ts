const MAX_REPORT_BYTES=16*1024*1024;
const HASH=/^[a-f0-9]{64}$/;

export interface ArchivedRun {
  created:boolean;sha256:string;file:string;
  classification:'completed'|'partial'|'cancelled'|'failed'|'interrupted'|'source-changed'|'source-unverified';
}

async function readReply(response:Response,signal:AbortSignal) {
  const reader=response.body?.getReader();
  if(!reader)throw Error('로컬 검사 기록 저장 응답이 없습니다.');
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='',complete=false;
  try {
    while(true) {
      signal.throwIfAborted();
      const next=await reader.read();
      signal.throwIfAborted();
      if(next.done){complete=true;break;}
      bytes+=next.value.byteLength;
      if(bytes>4096)throw Error('로컬 검사 기록 저장 응답이 너무 큽니다.');
      text+=decoder.decode(next.value,{stream:true});
    }
    return text+decoder.decode();
  } finally {
    signal.removeEventListener('abort',abort);
    if(!complete)await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

/** Only this loopback development server receives the report. Archiving is
 * separate from scanner completion and never promotes a run to ground truth. */
export async function archiveCorpusRun(id:string,report:Blob,signal:AbortSignal,
  request:typeof fetch=fetch,timeoutMs=10_000):Promise<ArchivedRun> {
  if(!HASH.test(id)||report.size<1||report.size>MAX_REPORT_BYTES)
    throw Error('로컬 검사 기록의 사례 또는 용량이 올바르지 않습니다.');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>10_000)throw Error('Invalid archive timeout.');
  signal.throwIfAborted();
  const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const timeout=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{
        const error=Error('로컬 검사 기록 저장 시간이 초과됐습니다. 다시 저장할 수 있습니다.');
        controller.abort(error);reject(error);
      },timeoutMs);
    });
    const operation=(async()=>{
      const response=await request(`/__corpus/cases/${id}/runs`,{
        method:'POST',headers:{'Content-Type':'application/json;charset=utf-8'},body:report,signal:controller.signal,
      });
      if(!response.ok)throw Error(`로컬 검사 기록을 저장하지 못했습니다 (${response.status}).`);
      const text=await readReply(response,controller.signal);
      const value:unknown=JSON.parse(text);
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('로컬 검사 기록 저장 응답이 올바르지 않습니다.');
      const item=value as Record<string,unknown>,summary=item.summary as Record<string,unknown>|undefined;
      if(typeof item.created!=='boolean'||item.id!==id||typeof item.sha256!=='string'||!HASH.test(item.sha256)||
        item.file!==`cases/${id}/runs/run-${item.sha256}.json`||!summary||summary.verification!=='unverified'||
        !['completed','partial','cancelled','failed','interrupted','source-changed','source-unverified'].includes(String(summary.classification)))
        throw Error('로컬 검사 기록 저장 응답이 올바르지 않습니다.');
      controller.signal.throwIfAborted();
      return {created:item.created,sha256:item.sha256,file:item.file,
        classification:summary.classification} as ArchivedRun;
    })();
    return await Promise.race([operation,timeout]);
  } finally {
    if(timer)clearTimeout(timer);
    signal.removeEventListener('abort',abort);
  }
}
