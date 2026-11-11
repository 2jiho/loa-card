import {createReproductionBundle} from './scan-reproduction';
import type {ReproductionFile} from './scan-reproduction';
import {recordedCoverage} from './reproduction-coverage';
import {listReproductionSessions,loadReproductionArchiveCandidate,acknowledgeReproductionArchive,createReproductionArchiveAccess,createReproductionSessionAccess} from './scan-reproduction';
import type {ReproductionSessionStore} from './reproduction-session-store';
import {hashBlobList,hashReplayBlob} from './dev-blob-hash';
import {createRawSessionArchive} from './raw-session-archive';
import type {RawSessionSnapshot} from './raw-session-archive';
import {validateArchiveExactInWorker} from './archive-exact-validation-client';

export interface LocalReplayArchive {
  readonly created:boolean;
  readonly caseId:string;
  readonly input:{readonly sha256:string;readonly bytes:number};
  readonly recordedCoverage:'declared-complete'|'partial'|'unknown';
}

/** Local development endpoint only. A successful receipt proves that the
 * server archived the bytes it received, not that all physical input was
 * captured or that recognition results are correct. */
type ArchiveOptions={signal?:AbortSignal;send?:typeof fetch;hash?:(blob:Blob,signal:AbortSignal)=>Promise<string>;
  hashChunks?:(blobs:readonly Blob[],signal:AbortSignal)=>Promise<readonly string[]>};
async function expectedCorpusCaseId(kind:'replay'|'raw-session',sha256:string,signal:AbortSignal):Promise<string>{
  signal.throwIfAborted();
  const input=new TextEncoder().encode(JSON.stringify({version:1,kind,inputs:[sha256]}));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',input));signal.throwIfAborted();
  return Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function archiveBlobLocally(blob:Blob,path:'/__corpus/replay'|'/__corpus/raw-session',coverage:LocalReplayArchive['recordedCoverage'],
 options:ArchiveOptions):Promise<LocalReplayArchive> {
  const signal=options.signal??new AbortController().signal;
  signal.throwIfAborted();
  const expectedHash=await (options.hash??hashReplayBlob)(blob,signal);
  signal.throwIfAborted();
  if(!/^[a-f0-9]{64}$/.test(expectedHash))throw Error('기록 해시를 검증하지 못했습니다.');
  const expectedCase=await expectedCorpusCaseId(path==='/__corpus/replay'?'replay':'raw-session',expectedHash,signal);
  const response=await (options.send??fetch)(path,{
    method:'POST',headers:{'Content-Type':'application/octet-stream'},body:blob,
    credentials:'same-origin',redirect:'error',signal,
  });
  if(!response.ok)throw Error(`로컬 검증 사례 저장 실패 (${response.status})`);
  const value:unknown=await response.json();
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('로컬 저장 응답이 올바르지 않습니다.');
  const result=value as Record<string,unknown>,input=result.input;
  if(typeof result.created!=='boolean'||result.caseId!==expectedCase||
    !input||typeof input!=='object'||Array.isArray(input)||
    (input as Record<string,unknown>).sha256!==expectedHash||
    (input as Record<string,unknown>).bytes!==blob.size||result.recordedCoverage!==coverage)
    throw Error('로컬 저장 응답이 입력 기록과 일치하지 않습니다.');
  return {created:result.created,caseId:result.caseId,input:{sha256:(input as {sha256:string}).sha256,bytes:blob.size},
    recordedCoverage:result.recordedCoverage as LocalReplayArchive['recordedCoverage']};
}

export async function archiveReplayLocally(file:ReproductionFile,options:ArchiveOptions={}):Promise<LocalReplayArchive> {
  return archiveBlobLocally(createReproductionBundle(file),'/__corpus/replay',recordedCoverage(file.metadata),options);
}

/** Raw journal is a byte-preserving artifact, never a replay result. */
export async function archiveRawLocally(snapshot:RawSessionSnapshot,options:ArchiveOptions={}):Promise<LocalReplayArchive> {
  const signal=options.signal??new AbortController().signal;
  const blob=await createRawSessionArchive(snapshot,signal,{hashChunks:options.hashChunks??hashBlobList});
  return archiveBlobLocally(blob,'/__corpus/raw-session','partial',{...options,signal});
}

export type LocalArchiveProgress={id:string;state:'saving'|'stored'|'failed'|'waiting'|'unavailable';coverage?:LocalReplayArchive['recordedCoverage'];
  storage?:'replay'|'raw'|'raw-and-replay'};
export type ArchiveDependencies={list:typeof listReproductionSessions;load:typeof loadReproductionArchiveCandidate;
  acknowledge:typeof acknowledgeReproductionArchive;upload:typeof archiveReplayLocally;uploadRaw:typeof archiveRawLocally;
  validateExact?:(file:ReproductionFile,signal:AbortSignal)=>Promise<boolean>;exactTimeoutMs?:number};
const defaults:ArchiveDependencies={list:listReproductionSessions,load:loadReproductionArchiveCandidate,
  acknowledge:acknowledgeReproductionArchive,upload:archiveReplayLocally,uploadRaw:archiveRawLocally};

/** Use the same verified archive path with a separately scoped dev journal. */
export function createArchiveDependencies(store:ReproductionSessionStore):ArchiveDependencies {
  const archive=createReproductionArchiveAccess(store);
  return {list:createReproductionSessionAccess(store).list,load:archive.load,acknowledge:archive.acknowledge,
    upload:archiveReplayLocally,uploadRaw:archiveRawLocally};
}

/** A stuck exact verifier must not keep the fallback from preserving the raw
 * snapshot. The parent signal still interrupts every stage immediately. */
async function validateExactWithin(file:ReproductionFile,parent:AbortSignal,dependencies:ArchiveDependencies):Promise<boolean> {
  const limit=dependencies.exactTimeoutMs??60_000;
  if(!Number.isFinite(limit)||limit<1||limit>180_000)throw Error('기록 검증 시간 한도가 올바르지 않습니다.');
  const signal=AbortSignal.any([parent,AbortSignal.timeout(limit)]);signal.throwIfAborted();
  let abort:(()=>void)|undefined;
  try{
    const cancelled=new Promise<never>((_resolve,reject)=>{
      abort=()=>reject(signal.reason??new DOMException('Stopped','AbortError'));
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
    return await Promise.race([(dependencies.validateExact??validateArchiveExactInWorker)(file,signal),cancelled]);
  }finally{if(abort)signal.removeEventListener('abort',abort);}
}

/** Retry sealed, protected sessions sequentially only while the caller is
 * idle. Aborting leaves the current and remaining records protected. */
export async function archivePendingReplaySessions(signal:AbortSignal,onProgress:(progress:LocalArchiveProgress)=>void,
  dependencies:ArchiveDependencies=defaults):Promise<void> {
  const notify=(value:LocalArchiveProgress)=>{try{onProgress(value);}catch{/* UI must not affect archive protection. */}};
  const sessions=await dependencies.list(AbortSignal.any([signal,AbortSignal.timeout(15_000)]));
  for(const session of sessions){
    signal.throwIfAborted();
    // Older builds acknowledged only the recovered replay prefix. Upgrade
    // protected partial/unknown sessions to a full raw archive as well.
    const needsRawUpgrade=session.archive?.state==='stored'&&session.archive.kind!=='raw-session'&&
      (session.status!=='complete'||session.archive.coverage!=='declared-complete'||!session.archive.exactVerified);
    if(session.archive?.state!=='pending'&&!needsRawUpgrade)continue;
    // A different tab may still own the session, or an interrupted lease may
    // not yet have expired. The caller retries while idle rather than silently
    // forgetting this protected record.
    if(session.status==='open'){notify({id:session.id,state:'waiting'});continue;}
    if(!session.hasInput){notify({id:session.id,state:'unavailable'});continue;}
    try{
      const jobSignal=AbortSignal.any([signal,AbortSignal.timeout(600_000)]);
      notify({id:session.id,state:'saving'});
      const candidate=await dependencies.load(session.id,jobSignal);
      if(!candidate){notify({id:session.id,state:'waiting'});continue;} // Another tab may still be finalizing.
      jobSignal.throwIfAborted();
      // A complete declaration is not evidence that recorded events/pixels
      // were preserved. Validate the exact stream in an idle Worker; any error
      // or incomplete result keeps the verified raw snapshot protected.
      let exactVerified=false;
      if(candidate.file&&recordedCoverage(candidate.file.metadata)==='declared-complete'&&!candidate.raw){
        try{exactVerified=await validateExactWithin(candidate.file,jobSignal,dependencies);}
        catch(error){if(jobSignal.aborted)throw error;}
      }
      let replay:LocalReplayArchive|undefined,replayError:unknown;
      if(candidate.file)try{replay=await dependencies.upload(candidate.file,{signal:jobSignal});}
      catch(error){if(jobSignal.aborted)throw error;replayError=error;}
      // Re-uploading lets the local corpus verify the old case's actual
      // bytes; a missing or changed prefix cannot silently become a migration.
      if(needsRawUpgrade&&session.archive?.state==='stored'&&
        (!replay||replay.caseId!==session.archive.caseId))replayError??=Error('기존 재현 사례를 검증하지 못했습니다.');
      let raw:LocalReplayArchive|undefined;
      const rawSnapshot=candidate.raw??(!exactVerified?candidate.snapshot:undefined);
      if(rawSnapshot)raw=await dependencies.uploadRaw({...rawSnapshot,...(replay?{replayCaseId:replay.caseId}:{})},{signal:jobSignal});
      if(!exactVerified&&!rawSnapshot)throw Error('검증되지 않은 원시 기록을 보관할 수 없습니다.');
      if(replayError)throw replayError;
      const receipt=raw??replay;
      if(!receipt)throw Error('보관할 입력이 없습니다.');
      jobSignal.throwIfAborted();
      const acknowledged=await dependencies.acknowledge(session.id,{generation:candidate.generation,revision:candidate.revision},
        {caseId:receipt.caseId,sha256:receipt.input.sha256,bytes:receipt.input.bytes,
          ...(raw?{kind:'raw-session' as const,...(replay?{replayCaseId:replay.caseId}:{})}:
            exactVerified?{exactVerified:true as const}:{})},jobSignal);
      // The server reports the bundle's declared coverage. The session store
      // additionally checks the sealed session status and stored chunk sizes;
      // its result controls protection and must also control the UI.
      if(acknowledged.archive?.state!=='stored')throw Error('기록 보관 확인 상태가 올바르지 않습니다.');
      notify({id:session.id,state:'stored',coverage:acknowledged.archive.coverage,
        storage:raw?(replay?'raw-and-replay':'raw'):'replay'});
    }catch(error){
      if(signal.aborted)throw error;
      notify({id:session.id,state:'failed'});
    }
  }
}
