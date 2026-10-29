/** Append-only browser journal. Pixels stay in Blob-backed chunks; listing a
 * session never reads chunks, seed images or diagnostic crops. */
export const REPRODUCTION_DATABASE='loacard-reproduction';
export const REPRODUCTION_DATABASE_VERSION=2;
export const MAX_SESSION_CHUNK_BYTES=4*1024*1024;
export const MAX_SESSION_DETAILS_BYTES=16*1024*1024;
export const SESSION_LEASE_MS=120_000;
export interface SessionLimits {maxSessions:number;maxBytes:number;maxChunkBytes:number;detailsReserveBytes:number}
export const DEFAULT_SESSION_LIMITS:Readonly<SessionLimits>=Object.freeze({maxSessions:8,maxBytes:512*1024*1024,
  maxChunkBytes:MAX_SESSION_CHUNK_BYTES,detailsReserveBytes:MAX_SESSION_DETAILS_BYTES});
export type SessionStatus='open'|'complete'|'partial'|'failed';
export type SessionChunkKind='video'|'exact';
export interface SessionEnvironment {browser:string;catalog:string;build:string}
export interface SessionStorageFailure {
  version:1;kind:'storage-capacity'|'storage-quota';nonce:string;at:string;operation:'append';
  chunkKind:SessionChunkKind;sequence:number;attemptedBytes:number;limitBytes:number;reason:string;
}
export interface ReproductionSessionIndex {
  version:1;id:string;createdAt:string;updatedAt:string;environment:SessionEnvironment;record:boolean;
  status:SessionStatus;sealed:boolean;pinned:boolean;ownerId:string;leaseUntil:number|null;
  bytes:number;detailsBytes:number;chunkCounts:Record<SessionChunkKind,number>;chunkBytes:Record<SessionChunkKind,number>;
  hasInput:boolean;read:number|null;expected:number|null;cards:number|null;reason?:string;
  generation?:string;failure?:SessionStorageFailure;
}
export interface SessionStart {id:string;createdAt:string;environment:SessionEnvironment;record:boolean;initial?:unknown}
export interface SessionSeal {status:Exclude<SessionStatus,'open'>;summary?:unknown;metadata?:unknown;reason?:string}
export interface SessionOperation {signal?:AbortSignal}
export interface SessionDeleteOptions extends SessionOperation {cancelOwned?:boolean}
export interface SessionChunkOptions extends SessionOperation {sha256?:string}
export interface ExactFinalizationReceipt {
  version:1;kind:'producer-exact-byte-reconciliation';preparedAt:string;verifiedAt:string;
  storedExactBytes:number;producerBytes:number;tailBytes:number;verifiedPrefixChunks:number;appendedTailChunks:number;omittedVideoBytes:number;
  originalCapacityFailure?:SessionStorageFailure;originalReason?:string;
}
const EXACT_FINALIZATION_PLAN=Symbol('exact-finalization-plan');
export interface ExactFinalizationPlan {
  readonly [EXACT_FINALIZATION_PLAN]:true;readonly id:string;readonly storedExactBytes:number;readonly producerBytes:number;
  readonly tailBytes:number;readonly retainedVideoBytes:number;readonly finalDetailsBytes:number;
}
export interface ExactFinalizationInput {producer:Blob;seal:SessionSeal;omitVideo:boolean}
export interface ReproductionSessionDetails {index:ReproductionSessionIndex;initial?:unknown;summary?:unknown;metadata?:unknown;exactFinalization?:ExactFinalizationReceipt}
export interface ReproductionSession extends ReproductionSessionDetails {video:Blob;exact?:Blob}
export interface SessionStoreOptions {
  dbName?:string;ownerId?:string;now?:()=>number;limits?:Partial<SessionLimits>;openTimeoutMs?:number;transactionTimeoutMs?:number;
}
interface SessionDetails {id:string;initial?:unknown;summary?:unknown;metadata?:unknown;exactFinalization?:ExactFinalizationReceipt}
interface SessionChunk {sessionId:string;kind:SessionChunkKind;seq:number;bytes:number;sha256:string;blob:Blob}
const SESSION_STORE='sessions',CHUNK_STORE='chunks',DETAIL_STORE='session-details';

export class SessionStorageLimitError extends Error {
  constructor(message:string){super(message);this.name='SessionStorageLimitError';}
}
function plain(value:unknown):value is Record<string,unknown> {
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
}
function identifier(value:unknown):asserts value is string {
  if(typeof value!=='string'||!value.length||value.length>160)throw Error('잘못된 기록 식별자');
}
function timestamp(value:number){if(!Number.isSafeInteger(value)||value<0)throw Error('잘못된 기록 시각');return value;}
function count(value:unknown):number|null{return Number.isSafeInteger(value)&&(value as number)>=0?value as number:null;}
function environment(value:SessionEnvironment):SessionEnvironment {
  if(!plain(value)||['browser','catalog','build'].some(key=>typeof value[key]!=='string'||(value[key] as string).length>4096))throw Error('잘못된 기록 환경');
  return {browser:value.browser,catalog:value.catalog,build:value.build};
}
function details(input:SessionDetails):{value:SessionDetails;bytes:number} {
  let nodes=0;
  const json=JSON.stringify(input,(_key,value)=>{
    if(++nodes>250_000)throw Error('기록 정보 항목 한도 초과');
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='number'){if(!Number.isFinite(value))throw Error('잘못된 기록 정보 숫자');return value;}
    if(typeof value==='string'){if(value.length>MAX_SESSION_DETAILS_BYTES)throw Error('기록 정보 용량 한도 초과');return value;}
    if(value===undefined)return value;
    if(Array.isArray(value)||plain(value))return value;
    throw Error('기록 정보는 JSON 형식이어야 합니다.');
  });
  if(json.length>MAX_SESSION_DETAILS_BYTES)throw Error('기록 정보 용량 한도 초과');
  const bytes=new TextEncoder().encode(json).byteLength;
  if(bytes>MAX_SESSION_DETAILS_BYTES)throw Error('기록 정보 용량 한도 초과');
  return {value:JSON.parse(json) as SessionDetails,bytes};
}
function copyIndex(value:ReproductionSessionIndex):ReproductionSessionIndex {
  return {...value,environment:{...value.environment},chunkCounts:{...value.chunkCounts},chunkBytes:{...value.chunkBytes},
    ...(value.failure?{failure:{...value.failure}}:{})};
}
function request<T>(value:IDBRequest<T>):Promise<T> {
  return new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error??Error('기록 저장 요청 실패'));});
}
function bytes(value:number){if(!Number.isSafeInteger(value)||value<0)throw Error('잘못된 기록 용량');return value;}
function storageFailure(value:unknown):asserts value is SessionStorageFailure {
  if(!plain(value)||value.version!==1||!['storage-capacity','storage-quota'].includes(value.kind as string)||
    typeof value.at!=='string'||value.at.length>64||!Number.isFinite(Date.parse(value.at))||value.operation!=='append'||
    !['video','exact'].includes(value.chunkKind as string)||!Number.isSafeInteger(value.sequence)||(value.sequence as number)<0||(value.sequence as number)>=100_000||
    !Number.isSafeInteger(value.attemptedBytes)||(value.attemptedBytes as number)<1||(value.attemptedBytes as number)>MAX_SESSION_CHUNK_BYTES||
    !Number.isSafeInteger(value.limitBytes)||(value.limitBytes as number)<1||(value.limitBytes as number)>4*1024*1024*1024||
    typeof value.reason!=='string'||value.reason.length>2000)throw Error('기록 저장 실패 정보가 손상되었습니다.');
  identifier(value.nonce);
}
function sessionRows(value:unknown):ReproductionSessionIndex[] {
  if(!Array.isArray(value)||value.length>100_000)throw Error('기록 색인 한도 초과');
  return value.map(row=>{
    if(!plain(row)||row.version!==1||!['open','complete','partial','failed'].includes(row.status as string)||
      typeof row.sealed!=='boolean'||typeof row.pinned!=='boolean'||typeof row.record!=='boolean'||typeof row.hasInput!=='boolean'||
      typeof row.createdAt!=='string'||typeof row.updatedAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))||!Number.isFinite(Date.parse(row.updatedAt))||
      !plain(row.chunkCounts)||!plain(row.chunkBytes))throw Error('기록 색인이 손상되었습니다.');
    identifier(row.id);identifier(row.ownerId);bytes(row.bytes as number);bytes(row.detailsBytes as number);
    for(const kind of ['video','exact']){bytes(row.chunkCounts[kind] as number);bytes(row.chunkBytes[kind] as number);}
    if(row.bytes!==(row.detailsBytes as number)+(row.chunkBytes.video as number)+(row.chunkBytes.exact as number)||
      row.hasInput!==((row.chunkCounts.video as number)+(row.chunkCounts.exact as number)>0)||
      [row.read,row.expected,row.cards].some(value=>value!==null&&count(value)===null)||
      row.sealed&&row.leaseUntil!==null||!row.sealed&&(!Number.isSafeInteger(row.leaseUntil)||(row.leaseUntil as number)<0))throw Error('기록 색인 수량이나 용량이 일치하지 않습니다.');
    environment(row.environment as unknown as SessionEnvironment);
    if(row.generation!==undefined)identifier(row.generation);
    if(row.failure!==undefined)storageFailure(row.failure);
    return row as unknown as ReproductionSessionIndex;
  });
}

export function createReproductionSessionStore(options:SessionStoreOptions={}) {
  const dbName=options.dbName??REPRODUCTION_DATABASE,ownerId=options.ownerId??crypto.randomUUID(),now=options.now??Date.now;
  identifier(dbName);identifier(ownerId);
  const limits={...DEFAULT_SESSION_LIMITS,...options.limits};
  // A deliberately tiny custom budget cannot reserve more than its entire
  // capacity. Tests/callers wanting raw byte-limit behavior may opt out with 0.
  if(options.limits?.detailsReserveBytes===undefined)limits.detailsReserveBytes=Math.min(limits.detailsReserveBytes,limits.maxBytes);
  if(!Number.isSafeInteger(limits.maxSessions)||limits.maxSessions<1||limits.maxSessions>1000||
    !Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1||limits.maxBytes>4*1024*1024*1024||
    !Number.isSafeInteger(limits.detailsReserveBytes)||limits.detailsReserveBytes<0||limits.detailsReserveBytes>limits.maxBytes||
    !Number.isSafeInteger(limits.maxChunkBytes)||limits.maxChunkBytes<1||limits.maxChunkBytes>MAX_SESSION_CHUNK_BYTES)throw Error('잘못된 기록 보관 한도');
  const openTimeoutMs=options.openTimeoutMs??10_000,transactionTimeoutMs=options.transactionTimeoutMs??15_000;
  for(const timeout of [openTimeoutMs,transactionTimeoutMs])if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60_000)throw Error('잘못된 기록 저장 제한 시간');
  const clock=()=>timestamp(now());
  const iso=(at:number)=>new Date(at).toISOString();
  // Only this live instance can authorize repair of a capacity-only append
  // failure. Imported JSON/reason strings cannot manufacture that authority.
  const capacityFailures=new Map<string,string>(),disqualifiedFinalization=new Set<string>();
  interface PreparedFinalization {
    id:string;fingerprint:string;detailsFingerprint:string;chunkFingerprint:string;
    nextDetails:{value:SessionDetails;bytes:number};seal:SessionSeal;omitVideo:boolean;
    producerBytes:number;tail:SessionChunk[];
  }
  const exactFinalizations=new WeakMap<ExactFinalizationPlan,PreparedFinalization>();
  async function database(signal?:AbortSignal):Promise<IDBDatabase> {
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      let settled=false;
      const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      const fail=(error:unknown)=>{if(settled)return;settled=true;clean();reject(error);};
      const abort=()=>fail(signal?.reason??new DOMException('취소됨','AbortError'));
      const timer=setTimeout(()=>fail(Error('기록 저장소 응답 시간 초과')),openTimeoutMs);
      signal?.addEventListener('abort',abort,{once:true});
      let opening:IDBOpenDBRequest;
      try{opening=indexedDB.open(dbName,REPRODUCTION_DATABASE_VERSION);}catch(error){fail(error);return;}
      opening.onupgradeneeded=()=>{
        if(settled){opening.transaction?.abort();return;}
        const db=opening.result;
        // A v1 recent recording remains available for explicit import/removal.
        if(!db.objectStoreNames.contains('recent'))db.createObjectStore('recent');
        if(!db.objectStoreNames.contains(SESSION_STORE)){
          const store=db.createObjectStore(SESSION_STORE,{keyPath:'id'});store.createIndex('createdAt','createdAt');
        }
        if(!db.objectStoreNames.contains(CHUNK_STORE)){
          const store=db.createObjectStore(CHUNK_STORE,{keyPath:['sessionId','kind','seq']});
          store.createIndex('sessionId','sessionId');store.createIndex('session-kind',['sessionId','kind']);
        }
        if(!db.objectStoreNames.contains(DETAIL_STORE))db.createObjectStore(DETAIL_STORE,{keyPath:'id'});
      };
      opening.onsuccess=()=>{
        const db=opening.result;db.onversionchange=()=>db.close();
        if(settled){db.close();return;}settled=true;clean();resolve(db);
      };
      opening.onerror=()=>fail(opening.error??Error('기록 저장소 열기 실패'));
      opening.onblocked=()=>fail(Error('다른 탭이 이전 기록 저장소를 사용 중입니다. 해당 탭을 닫고 다시 시도해 주세요.'));
    });
  }
  async function transaction<T>(mode:IDBTransactionMode,work:(tx:IDBTransaction)=>Promise<T>|T,signal?:AbortSignal):Promise<T> {
    const db=await database(signal);
    try{return await new Promise<T>((resolve,reject)=>{
      signal?.throwIfAborted();
      const tx=db.transaction([SESSION_STORE,CHUNK_STORE,DETAIL_STORE],mode);let result:T,finished=false,workDone=false,failure:unknown;
      const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
      const abort=(reason:unknown)=>{if(finished)return;failure=reason;try{tx.abort();}catch{}clean();finished=true;reject(reason);};
      const cancel=()=>abort(signal?.reason??new DOMException('취소됨','AbortError'));
      const timer=setTimeout(()=>abort(Error('기록 저장 시간 초과')),transactionTimeoutMs);
      signal?.addEventListener('abort',cancel,{once:true});
      tx.oncomplete=()=>{if(finished)return;finished=true;clean();if(!workDone)reject(Error('기록 저장 작업이 완료되기 전에 트랜잭션이 닫혔습니다.'));else resolve(result);};
      tx.onabort=tx.onerror=()=>{if(finished)return;finished=true;clean();reject(failure??tx.error??Error('기록 저장 실패'));};
      try{Promise.resolve(work(tx)).then(value=>{result=value;workDone=true;},abort);}catch(error){abort(error);}
    });}finally{db.close();}
  }
  async function getIndex(tx:IDBTransaction,id:string):Promise<ReproductionSessionIndex|undefined> {
    const row=await request(tx.objectStore(SESSION_STORE).get(id));
    return row===undefined?undefined:sessionRows([row])[0];
  }
  function owns(index:ReproductionSessionIndex,at:number,allowSealed=false) {
    if(index.ownerId!==ownerId)throw Error('다른 창이 소유한 기록입니다.');
    if(!allowSealed&&(index.sealed||index.leaseUntil===null||index.leaseUntil<=at))throw Error('닫혔거나 만료된 기록입니다.');
  }
  async function remove(tx:IDBTransaction,id:string):Promise<void> {
    const cursor=tx.objectStore(CHUNK_STORE).index('sessionId').openKeyCursor(IDBKeyRange.only(id));
    await new Promise<void>((resolve,reject)=>{
      cursor.onerror=()=>reject(cursor.error);
      cursor.onsuccess=()=>{const row=cursor.result;if(!row){resolve();return;}tx.objectStore(CHUNK_STORE).delete(row.primaryKey);row.continue();};
    });
    tx.objectStore(DETAIL_STORE).delete(id);tx.objectStore(SESSION_STORE).delete(id);
  }
  const reserved=(index:ReproductionSessionIndex)=>index.sealed?0:Math.max(0,limits.detailsReserveBytes-index.detailsBytes);
  /** All removals and the new payload commit in one transaction. Active and
   * pinned sessions are never chosen; a failed write rolls removals back too. */
  async function capacity(tx:IDBTransaction,currentId:string,addedBytes:number,addedSessions:number,reserveDelta=0):Promise<boolean> {
    const rows=sessionRows(await request(tx.objectStore(SESSION_STORE).getAll()));
    // Reserved bytes are admission headroom, not stored payload. Protect each
    // unsealed session's final summary so media cannot consume that space.
    let total=rows.reduce((sum,row)=>sum+row.bytes+reserved(row),0)+addedBytes+reserveDelta,n=rows.length+addedSessions;
    const candidates=rows.filter(row=>row.id!==currentId&&row.sealed&&!row.pinned)
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    const selected:ReproductionSessionIndex[]=[];
    for(const candidate of candidates){
      if(total<=limits.maxBytes&&n<=limits.maxSessions)break;
      selected.push(candidate);total-=candidate.bytes;n--;
    }
    // Do not discard useful old inputs merely to discover that protected
    // sessions still make the new payload impossible to retain.
    if(total>limits.maxBytes||n>limits.maxSessions)return false;
    for(const candidate of selected)await remove(tx,candidate.id);
    return true;
  }
  function failure(kind:SessionStorageFailure['kind'],chunkKind:SessionChunkKind,sequence:number,attemptedBytes:number,at:number,reason:string):SessionStorageFailure {
    return {version:1,kind,nonce:crypto.randomUUID(),at:iso(at),operation:'append',chunkKind,sequence,attemptedBytes,limitBytes:limits.maxBytes,reason};
  }
  async function markPartial(id:string,reason:string,marker?:SessionStorageFailure):Promise<void> {
    try{await transaction('readwrite',async tx=>{
      const index=await getIndex(tx,id);if(!index||index.ownerId!==ownerId||index.sealed)return;
      tx.objectStore(SESSION_STORE).put({...index,status:'partial',reason:reason.slice(0,2000),updatedAt:iso(clock()),...(marker?{failure:marker}:{})});
    });}catch{/* Storage exhaustion may also prevent saving a loss marker. The original error is still returned. */}
  }
  async function beginSession(input:SessionStart,operation:SessionOperation={}):Promise<ReproductionSessionIndex> {
    identifier(input.id);
    if(typeof input.createdAt!=='string'||!Number.isFinite(Date.parse(input.createdAt))||input.createdAt.length>64||typeof input.record!=='boolean')throw Error('잘못된 기록 시작 정보');
    const env=environment(input.environment),initial=details({id:input.id,...(input.initial===undefined?{}:{initial:input.initial})});
    const at=clock();operation.signal?.throwIfAborted();
    const result=await transaction('readwrite',async tx=>{
      if(await getIndex(tx,input.id))throw Error('같은 기록 식별자가 이미 있습니다.');
      const fits=await capacity(tx,input.id,initial.bytes,1,Math.max(0,limits.detailsReserveBytes-initial.bytes));
      if(!fits){
        // One small failure marker may exceed the payload session-count limit.
        // Replace only an earlier empty failure marker, never useful input.
        for(const previous of sessionRows(await request(tx.objectStore(SESSION_STORE).getAll())))
          if(previous.sealed&&!previous.pinned&&previous.status==='partial'&&previous.bytes===0)await remove(tx,previous.id);
      }
      const index:ReproductionSessionIndex={version:1,id:input.id,generation:crypto.randomUUID(),createdAt:new Date(input.createdAt).toISOString(),updatedAt:iso(at),environment:env,record:input.record,
        status:fits?'open':'partial',sealed:!fits,pinned:false,ownerId,leaseUntil:fits?at+SESSION_LEASE_MS:null,
        bytes:fits?initial.bytes:0,detailsBytes:fits?initial.bytes:0,chunkCounts:{video:0,exact:0},chunkBytes:{video:0,exact:0},hasInput:false,
        read:null,expected:null,cards:null,...(!fits?{reason:'보관 한도에 도달했습니다. 고정하거나 진행 중인 기록은 자동 삭제하지 않습니다.'}:{})};
      tx.objectStore(SESSION_STORE).add(index);
      if(fits)tx.objectStore(DETAIL_STORE).add(initial.value);
      return {index,fits};
    },operation.signal);
    if(!result.fits)throw new SessionStorageLimitError(result.index.reason!);
    capacityFailures.delete(input.id);disqualifiedFinalization.delete(input.id);
    return copyIndex(result.index);
  }
  async function appendChunk(id:string,kind:SessionChunkKind,seq:number,blob:Blob,chunkOptions:SessionChunkOptions={}):Promise<ReproductionSessionIndex> {
    identifier(id);
    if(!['video','exact'].includes(kind)||!Number.isSafeInteger(seq)||seq<0||seq>=100_000||!(blob instanceof Blob)||blob.size<1||blob.size>limits.maxChunkBytes)
      throw Error('잘못된 기록 청크 또는 청크 용량 한도 초과');
    if(chunkOptions.sha256!==undefined&&(typeof chunkOptions.sha256!=='string'||!/^[a-f0-9]{64}$/.test(chunkOptions.sha256)))throw Error('잘못된 기록 청크 해시');
    chunkOptions.signal?.throwIfAborted();
    // Only this bounded <=4MiB chunk is materialized, never a composed video.
    const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),value=>value.toString(16).padStart(2,'0')).join('');
    chunkOptions.signal?.throwIfAborted();
    if(chunkOptions.sha256!==undefined&&chunkOptions.sha256!==sha256)throw Error('기록 청크 해시가 일치하지 않습니다.');
    try{
      const result=await transaction('readwrite',async tx=>{
        const index=await getIndex(tx,id);if(!index)throw Error('기록을 찾을 수 없습니다.');
        const at=clock();owns(index,at);if(index.status!=='open')throw Error('손실이 발생한 기록에는 청크를 추가할 수 없습니다.');
        const existing=await request<SessionChunk|undefined>(tx.objectStore(CHUNK_STORE).get([id,kind,seq]));
        if(existing){
          if(existing.sha256!==sha256||existing.bytes!==blob.size)throw Error('같은 순번에 다른 기록 청크가 있습니다.');
          const refreshed={...index,updatedAt:iso(at),leaseUntil:at+SESSION_LEASE_MS};
          tx.objectStore(SESSION_STORE).put(refreshed);return {index:refreshed,limited:false};
        }
        if(seq!==index.chunkCounts[kind])throw Error('기록 청크 순서가 연속되지 않습니다.');
        if(!await capacity(tx,id,blob.size,0)){
          const reason='기록 보관 용량 한도를 초과해 이후 입력을 저장하지 못했습니다.';
          const partial={...index,status:'partial' as const,updatedAt:iso(at),reason,
            failure:failure('storage-capacity',kind,seq,blob.size,at,reason)};
          tx.objectStore(SESSION_STORE).put(partial);return {index:partial,limited:true};
        }
        const next={...index,updatedAt:iso(at),leaseUntil:at+SESSION_LEASE_MS,bytes:index.bytes+blob.size,hasInput:true,
          chunkCounts:{...index.chunkCounts,[kind]:seq+1},chunkBytes:{...index.chunkBytes,[kind]:index.chunkBytes[kind]+blob.size}};
        tx.objectStore(CHUNK_STORE).add({sessionId:id,kind,seq,bytes:blob.size,sha256,blob} satisfies SessionChunk);
        tx.objectStore(SESSION_STORE).put(next);return {index:next,limited:false};
      },chunkOptions.signal);
      if(result.limited){capacityFailures.set(id,result.index.failure!.nonce);throw new SessionStorageLimitError(result.index.reason!);}
      return copyIndex(result.index);
    }catch(error){
      if(error instanceof DOMException&&error.name==='QuotaExceededError'){
        capacityFailures.delete(id);disqualifiedFinalization.add(id);
        const reason='브라우저 저장 공간이 부족해 이후 입력을 저장하지 못했습니다.';
        await markPartial(id,reason,failure('storage-quota',kind,seq,blob.size,clock(),reason));
      }
      throw error;
    }
  }
  async function heartbeat(id:string,operation:SessionOperation={}):Promise<ReproductionSessionIndex> {
    identifier(id);
    return transaction('readwrite',async tx=>{
      const index=await getIndex(tx,id);if(!index)throw Error('기록을 찾을 수 없습니다.');
      const at=clock();owns(index,at);
      const next={...index,updatedAt:iso(at),leaseUntil:at+SESSION_LEASE_MS};tx.objectStore(SESSION_STORE).put(next);return copyIndex(next);
    },operation.signal);
  }
  function finalizationEligible(index:ReproductionSessionIndex,at:number) {
    owns(index,at);
    if(disqualifiedFinalization.has(index.id))throw Error('저장 용량 이외의 실패가 있는 기록입니다.');
    if(index.status==='open'&&index.failure===undefined)return;
    if(index.status==='partial'&&index.failure?.kind==='storage-capacity'&&
      capacityFailures.get(index.id)===index.failure.nonce)return;
    throw Error('용량 실패만 있는 열린 소유 기록만 정산할 수 있습니다.');
  }
  const finalizationFingerprint=(index:ReproductionSessionIndex)=>{
    // A normal heartbeat and a pin toggle do not mutate source bytes/details.
    const {updatedAt:_updatedAt,leaseUntil:_leaseUntil,pinned:_pinned,...stable}=index;
    return JSON.stringify(stable);
  };
  async function chunkSnapshot(tx:IDBTransaction,index:ReproductionSessionIndex) {
    const all=await request<SessionChunk[]>(tx.objectStore(CHUNK_STORE).index('sessionId').getAll(IDBKeyRange.only(index.id)));
    if(all.length!==index.chunkCounts.video+index.chunkCounts.exact)throw Error('기록 청크 종류 또는 전체 수량이 일치하지 않습니다.');
    const ordered:SessionChunk[]=[];
    for(const kind of ['video','exact'] as const){
      const rows=all.filter(chunk=>chunk.kind===kind).sort((a,b)=>a.seq-b.seq);let total=0;
      if(rows.length!==index.chunkCounts[kind])throw Error('기록 청크 수가 일치하지 않습니다.');
      rows.forEach((chunk,seq)=>{
        if(chunk.sessionId!==index.id||chunk.seq!==seq||!(chunk.blob instanceof Blob)||chunk.blob.size!==chunk.bytes||
          chunk.bytes<1||chunk.bytes>limits.maxChunkBytes||typeof chunk.sha256!=='string'||!/^[a-f0-9]{64}$/.test(chunk.sha256))
          throw Error('기록 청크 정보가 손상되었습니다.');
        total+=chunk.bytes;ordered.push(chunk);
      });
      if(total!==index.chunkBytes[kind])throw Error('기록 청크 용량이 일치하지 않습니다.');
    }
    return ordered;
  }
  const chunkFingerprint=(chunks:readonly SessionChunk[])=>JSON.stringify(chunks.map(({kind,seq,bytes,sha256})=>[kind,seq,bytes,sha256]));
  async function finalizationSnapshot(tx:IDBTransaction,id:string) {
    const index=await getIndex(tx,id);if(!index)throw Error('기록을 찾을 수 없습니다.');
    finalizationEligible(index,clock());
    const old=await request<SessionDetails|undefined>(tx.objectStore(DETAIL_STORE).get(id));
    const oldDetails=old?details(old):undefined;
    if(oldDetails?(oldDetails.value.id!==id||oldDetails.bytes!==index.detailsBytes):index.detailsBytes!==0)
      throw Error('기록 정보 용량이나 식별자가 일치하지 않습니다.');
    const chunks=await chunkSnapshot(tx,index);
    return {index,oldDetails,chunks,fingerprint:finalizationFingerprint(index),
      detailsFingerprint:oldDetails?JSON.stringify(oldDetails.value):'',chunkFingerprint:chunkFingerprint(chunks)};
  }
  async function abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T> {
    signal?.throwIfAborted();if(!signal)return promise;
    return new Promise<T>((resolve,reject)=>{
      let settled=false;
      const clean=()=>signal.removeEventListener('abort',abort);
      const abort=()=>{if(settled)return;settled=true;clean();reject(signal.reason);};
      signal.addEventListener('abort',abort,{once:true});
      promise.then(value=>{if(settled)return;settled=true;clean();resolve(value);},error=>{if(settled)return;settled=true;clean();reject(error);});
      if(signal.aborted)abort();
    });
  }
  async function boundedHash(blob:Blob,signal?:AbortSignal) {
    signal?.throwIfAborted();
    if(blob.size<1||blob.size>limits.maxChunkBytes)throw Error('정산 청크 용량 한도 초과');
    const data=await abortable(blob.arrayBuffer(),signal);signal?.throwIfAborted();
    if(data.byteLength!==blob.size||data.byteLength>limits.maxChunkBytes)throw Error('정산 청크 읽기 길이 불일치');
    const digest=await abortable(crypto.subtle.digest('SHA-256',data),signal);signal?.throwIfAborted();
    return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
  }
  /** Generic byte reconciliation, not a decoder or a trust gate for imported
   * metadata.complete. The caller must independently verify its whole producer
   * and execution/source evidence before requesting a complete seal. Hashes run
   * outside IDB transactions; only <=4MiB chunks are materialized. */
  async function prepareExactFinalization(id:string,input:ExactFinalizationInput,operation:SessionOperation={}):Promise<ExactFinalizationPlan> {
    identifier(id);operation.signal?.throwIfAborted();
    if(!input||!(input.producer instanceof Blob)||typeof input.omitVideo!=='boolean'||!input.seal||
      !['complete','partial','failed'].includes(input.seal.status)||input.seal.reason!==undefined&&
      (typeof input.seal.reason!=='string'||input.seal.reason.length>2000))throw Error('잘못된 기록 정산 정보');
    // Blob composition retains immutable backing, not one large ArrayBuffer.
    const producer=new Blob([input.producer]);
    if(!producer.size||producer.size>limits.maxBytes)throw new SessionStorageLimitError('완성 원본이 기록 보관 용량 한도를 초과합니다.');
    const seal:SessionSeal={status:input.seal.status,...(input.seal.reason===undefined?{}:{reason:input.seal.reason})};
    const incoming=details({id,...(input.seal.summary===undefined?{}:{summary:input.seal.summary}),
      ...(input.seal.metadata===undefined?{}:{metadata:input.seal.metadata})});
    const omitVideo=input.omitVideo,preparedAt=iso(clock());
    const snapshot=await transaction('readonly',tx=>finalizationSnapshot(tx,id),operation.signal);
    if(producer.size<snapshot.index.chunkBytes.exact)throw Error('완성 원본이 저장된 접두 구간보다 짧습니다.');
    let offset=0;const exact=snapshot.chunks.filter(chunk=>chunk.kind==='exact');
    for(const chunk of exact){
      const storedHash=await boundedHash(chunk.blob,operation.signal);
      if(storedHash!==chunk.sha256)throw Error('저장된 접두 청크의 실제 해시가 일치하지 않습니다.');
      const sourceHash=await boundedHash(producer.slice(offset,offset+chunk.bytes),operation.signal);
      if(sourceHash!==storedHash)throw Error('완성 원본과 저장된 접두 구간이 다릅니다.');
      offset+=chunk.bytes;
    }
    if(offset!==snapshot.index.chunkBytes.exact)throw Error('접두 구간 오프셋이 일치하지 않습니다.');
    const tail:SessionChunk[]=[];
    for(let from=offset;from<producer.size;from+=limits.maxChunkBytes){
      const blob=producer.slice(from,Math.min(from+limits.maxChunkBytes,producer.size)),seq=exact.length+tail.length;
      if(seq>=100_000)throw Error('정산 청크 수 한도 초과');
      tail.push({sessionId:id,kind:'exact',seq,bytes:blob.size,sha256:await boundedHash(blob,operation.signal),blob});
    }
    const current=await transaction('readonly',tx=>finalizationSnapshot(tx,id),operation.signal);
    if(current.fingerprint!==snapshot.fingerprint||current.detailsFingerprint!==snapshot.detailsFingerprint||
      current.chunkFingerprint!==snapshot.chunkFingerprint)throw Error('검증 중 기록 접두 구간이 변경되었습니다.');
    const receipt:ExactFinalizationReceipt={version:1,kind:'producer-exact-byte-reconciliation',preparedAt,verifiedAt:iso(clock()),
      storedExactBytes:offset,producerBytes:producer.size,tailBytes:producer.size-offset,verifiedPrefixChunks:exact.length,
      appendedTailChunks:tail.length,omittedVideoBytes:omitVideo?snapshot.index.chunkBytes.video:0,
      ...(snapshot.index.failure?{originalCapacityFailure:{...snapshot.index.failure}}:{}),
      ...(typeof snapshot.index.reason==='string'?{originalReason:snapshot.index.reason}:{})};
    const nextDetails=details({...snapshot.oldDetails?.value,...incoming.value,id,exactFinalization:receipt});
    const plan:ExactFinalizationPlan=Object.freeze({[EXACT_FINALIZATION_PLAN]:true as const,id,storedExactBytes:offset,
      producerBytes:producer.size,tailBytes:producer.size-offset,retainedVideoBytes:omitVideo?0:snapshot.index.chunkBytes.video,finalDetailsBytes:nextDetails.bytes});
    exactFinalizations.set(plan,{id,fingerprint:snapshot.fingerprint,detailsFingerprint:snapshot.detailsFingerprint,
      chunkFingerprint:snapshot.chunkFingerprint,nextDetails,seal,omitVideo,producerBytes:producer.size,tail});
    return plan;
  }
  /** One-use, same-instance opaque plan. Failure/abort/quota rolls back tail,
   * video removal, eviction, details and the sealed index together. */
  async function commitExactFinalization(token:ExactFinalizationPlan,operation:SessionOperation={}):Promise<ReproductionSessionIndex> {
    const plan=exactFinalizations.get(token);
    if(!plan)throw Error('유효한 소유 기록 정산 계획이 아닙니다.');
    exactFinalizations.delete(token);operation.signal?.throwIfAborted();
    const result=await transaction('readwrite',async tx=>{
      const current=await finalizationSnapshot(tx,plan.id),index=current.index;
      if(current.fingerprint!==plan.fingerprint||current.detailsFingerprint!==plan.detailsFingerprint||
        current.chunkFingerprint!==plan.chunkFingerprint)throw Error('준비 후 기록 접두 구간이 변경되었습니다.');
      const retainedVideo=plan.omitVideo?0:index.chunkBytes.video,nextBytes=retainedVideo+plan.producerBytes+plan.nextDetails.bytes;
      if(!await capacity(tx,plan.id,nextBytes-index.bytes,0,-reserved(index)))
        throw new SessionStorageLimitError('정산한 원본과 최종 정보를 보관할 공간이 부족합니다. 고정·진행 중 기록은 유지했습니다.');
      if(plan.omitVideo)for(const chunk of current.chunks)if(chunk.kind==='video')tx.objectStore(CHUNK_STORE).delete([plan.id,'video',chunk.seq]);
      for(const chunk of plan.tail)tx.objectStore(CHUNK_STORE).add(chunk);
      tx.objectStore(DETAIL_STORE).put(plan.nextDetails.value);
      const summary=plan.nextDetails.value.summary,result=plain(summary)&&plain(summary.result)?summary.result:undefined;
      const next:ReproductionSessionIndex={...index,status:plan.seal.status,sealed:true,leaseUntil:null,updatedAt:iso(clock()),
        bytes:nextBytes,detailsBytes:plan.nextDetails.bytes,hasInput:true,
        chunkCounts:{video:plan.omitVideo?0:index.chunkCounts.video,exact:index.chunkCounts.exact+plan.tail.length},
        chunkBytes:{video:retainedVideo,exact:plan.producerBytes},
        read:result?count(result.read):index.read,expected:result?count(result.expected):index.expected,
        cards:result&&Array.isArray(result.cards)?result.cards.length:index.cards};
      delete next.reason;delete next.failure;if(plan.seal.reason)next.reason=plan.seal.reason;
      tx.objectStore(SESSION_STORE).put(next);return copyIndex(next);
    },operation.signal);
    capacityFailures.delete(plan.id);disqualifiedFinalization.delete(plan.id);return result;
  }
  async function sealSession(id:string,input:SessionSeal,operation:SessionOperation={}):Promise<ReproductionSessionIndex|undefined> {
    identifier(id);
    if(!['complete','partial','failed'].includes(input.status)||input.reason!==undefined&&(typeof input.reason!=='string'||input.reason.length>2000))throw Error('잘못된 기록 종료 정보');
    // Detach caller-owned objects before the first storage await.
    const incoming=details({id,...(input.summary===undefined?{}:{summary:input.summary}),...(input.metadata===undefined?{}:{metadata:input.metadata})});
    return transaction('readwrite',async tx=>{
      const index=await getIndex(tx,id);if(!index)return undefined;
      owns(index,clock(),true);
      if(index.sealed&&index.status==='complete')throw Error('이미 봉인된 기록입니다.');
      const oldDetails=await request<SessionDetails|undefined>(tx.objectStore(DETAIL_STORE).get(id));
      const nextDetails=details({...oldDetails,...incoming.value,id});
      const result=plain(incoming.value.summary)&&plain(incoming.value.summary.result)?incoming.value.summary.result:undefined;
      // Sealing exchanges this session's reservation for actual final details;
      // other active sessions keep their independent reservations intact.
      const fits=await capacity(tx,id,nextDetails.bytes-index.detailsBytes,0,-reserved(index));
      const status=index.status==='partial'||index.status==='failed'?index.status:fits?input.status:'partial';
      const reason=!fits?'기록 정보를 보관할 공간이 부족합니다. 저장된 입력 접두 구간은 유지했습니다.':index.reason??input.reason;
      const next:ReproductionSessionIndex={...index,status,sealed:true,leaseUntil:null,updatedAt:iso(clock()),
        ...(fits?{detailsBytes:nextDetails.bytes,bytes:index.bytes-index.detailsBytes+nextDetails.bytes}:{}),
        read:result?count(result.read):index.read,expected:result?count(result.expected):index.expected,
        cards:result&&Array.isArray(result.cards)?result.cards.length:index.cards,...(reason?{reason}:{})};
      if(fits)tx.objectStore(DETAIL_STORE).put(nextDetails.value);
      tx.objectStore(SESSION_STORE).put(next);return copyIndex(next);
    },operation.signal);
  }
  async function listSessions(operation:SessionOperation={}):Promise<ReproductionSessionIndex[]> {
    return transaction('readonly',async tx=>sessionRows(await request(tx.objectStore(SESSION_STORE).getAll()))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)).map(copyIndex),operation.signal);
  }
  async function loadDetails(tx:IDBTransaction,index:ReproductionSessionIndex):Promise<ReproductionSessionDetails> {
    const stored=await request<SessionDetails|undefined>(tx.objectStore(DETAIL_STORE).get(index.id));
    if(!stored){if(index.detailsBytes!==0)throw Error('기록 정보가 누락되었습니다.');return {index:copyIndex(index)};}
    const payload=details(stored);
    if(payload.value.id!==index.id||payload.bytes!==index.detailsBytes)throw Error('기록 정보 용량이나 식별자가 일치하지 않습니다.');
    return {index:copyIndex(index),...(payload.value.initial===undefined?{}:{initial:payload.value.initial}),
      ...(payload.value.summary===undefined?{}:{summary:payload.value.summary}),
      ...(payload.value.metadata===undefined?{}:{metadata:payload.value.metadata}),
      ...(payload.value.exactFinalization===undefined?{}:{exactFinalization:payload.value.exactFinalization})};
  }
  async function getSessionDetails(id:string,operation:SessionOperation={}):Promise<ReproductionSessionDetails|undefined> {
    identifier(id);
    return transaction('readonly',async tx=>{
      const index=await getIndex(tx,id);return index?loadDetails(tx,index):undefined;
    },operation.signal);
  }
  async function getSession(id:string,operation:SessionOperation={}):Promise<ReproductionSession|undefined> {
    identifier(id);
    return transaction('readonly',async tx=>{
      const index=await getIndex(tx,id);if(!index)return undefined;
      const payload=await loadDetails(tx,index);
      const chunks=await request<SessionChunk[]>(tx.objectStore(CHUNK_STORE).index('sessionId').getAll(IDBKeyRange.only(id)));
      if(chunks.length!==index.chunkCounts.video+index.chunkCounts.exact)throw Error('기록 청크 종류 또는 전체 수량이 일치하지 않습니다.');
      const parts:Record<SessionChunkKind,Blob[]>={video:[],exact:[]};
      for(const kind of ['video','exact'] as const){
        const selected=chunks.filter(chunk=>chunk.kind===kind).sort((a,b)=>a.seq-b.seq);let total=0;
        if(selected.length!==index.chunkCounts[kind])throw Error('기록 청크 수가 일치하지 않습니다.');
        selected.forEach((chunk,seq)=>{
          if(chunk.seq!==seq||!(chunk.blob instanceof Blob)||chunk.blob.size!==chunk.bytes||chunk.bytes<1||chunk.bytes>limits.maxChunkBytes||!/^[a-f0-9]{64}$/.test(chunk.sha256))throw Error('기록 청크 정보가 손상되었습니다.');
          total+=chunk.bytes;parts[kind].push(chunk.blob);
        });
        if(total!==index.chunkBytes[kind])throw Error('기록 청크 용량이 일치하지 않습니다.');
      }
      const type=plain(payload?.metadata)&&typeof payload.metadata.type==='string'?payload.metadata.type:'video/webm';
      return {...payload,video:new Blob(parts.video,{type}),...(parts.exact.length?{exact:new Blob(parts.exact)}:{})};
    },operation.signal);
  }
  async function pinSession(id:string,pinned:boolean,operation:SessionOperation={}):Promise<ReproductionSessionIndex|undefined> {
    identifier(id);if(typeof pinned!=='boolean')throw Error('잘못된 기록 고정 값');
    return transaction('readwrite',async tx=>{
      const index=await getIndex(tx,id);if(!index)return undefined;
      const next={...index,pinned};tx.objectStore(SESSION_STORE).put(next);return copyIndex(next);
    },operation.signal);
  }
  async function deleteSession(id:string,operation:SessionDeleteOptions={}):Promise<boolean> {
    identifier(id);
    return transaction('readwrite',async tx=>{
      const index=await getIndex(tx,id);if(!index)return false;
      if(!index.sealed&&!(operation.cancelOwned===true&&index.ownerId===ownerId))throw Error('진행 중인 기록은 삭제할 수 없습니다. 먼저 스캔을 종료해 주세요.');
      await remove(tx,id);return true;
    },operation.signal);
  }
  async function recoverInterrupted(operation:SessionOperation={}):Promise<ReproductionSessionIndex[]> {
    const at=clock();
    return transaction('readwrite',async tx=>{
      const recovered:ReproductionSessionIndex[]=[];
      for(const index of sessionRows(await request(tx.objectStore(SESSION_STORE).getAll()))) {
        if(index.sealed||index.leaseUntil!==null&&index.leaseUntil>at)continue;
        const next:ReproductionSessionIndex={...index,status:'partial',sealed:true,leaseUntil:null,updatedAt:iso(at),
          reason:index.reason??'기록 도중 페이지가 닫히거나 응답이 중단되었습니다. 저장된 입력 접두 구간만 남아 있습니다.'};
        tx.objectStore(SESSION_STORE).put(next);recovered.push(copyIndex(next));
      }
      return recovered;
    },operation.signal);
  }
  return {beginSession,appendChunk,heartbeat,sealSession,prepareExactFinalization,commitExactFinalization,listSessions,getSession,getSessionDetails,pinSession,deleteSession,recoverInterrupted,
    ownerId,limits:Object.freeze({...limits})};
}
export type ReproductionSessionStore=ReturnType<typeof createReproductionSessionStore>;
