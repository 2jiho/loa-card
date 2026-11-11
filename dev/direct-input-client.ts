const MAX_FILE_BYTES=1024*1024*1024;
const MAX_TOTAL_BYTES=2*1024*1024*1024;
const MAX_INPUTS=1000;
const MAX_HEADER_BYTES=256*1024;
const MAX_RESPONSE_BYTES=512*1024;
const HASH=/^[a-f0-9]{64}$/;
const VIDEOS=new Set(['.mp4','.webm','.mov','.m4v','.mkv']);
const IMAGES=new Set(['.png','.jpg','.jpeg','.webp','.bmp','.gif']);

export type DirectInputKind='video'|'images'|'replay';
export interface DirectInputDescriptor {index:number;extension:string;bytes:number;sha256:string}
export interface DirectInputReceipt {created:boolean;caseId:string;kind:DirectInputKind;inputs:readonly DirectInputDescriptor[];
  selection:Readonly<{id:string;sha256:string}>}
export type DirectInputProgress={phase:'hashing';index:number;count:number;fileBytes:number;processedBytes:number;totalBytes:number}
  |{phase:'uploading';count:number;totalBytes:number};
type HashWorker=Pick<Worker,'postMessage'|'terminate'|'addEventListener'|'removeEventListener'>;
type WorkerFactory=()=>HashWorker;
const workerFactory:WorkerFactory=()=>new Worker(new URL('./direct-input-hash-worker.ts',import.meta.url),{type:'module'});

/** One sequential worker; File backing-store copying and RSS depend on the
 * browser, but no full source file is read into a JavaScript buffer. */
export function hashDirectFiles(files:readonly Blob[],signal:AbortSignal,options:{workerFactory?:WorkerFactory;
  onProgress?:(index:number,bytes:number)=>void}={}):Promise<readonly string[]> {
  signal.throwIfAborted();
  if(!Array.isArray(files)||!files.length||files.length>MAX_INPUTS)throw Error('입력 파일 수가 올바르지 않습니다.');
  let total=0;for(const file of files){
    if(!(file instanceof Blob)||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_FILE_BYTES)throw Error('입력 파일 크기가 올바르지 않습니다.');
    total+=file.size;if(!Number.isSafeInteger(total)||total>MAX_TOTAL_BYTES)throw Error('입력 파일 합계가 한도를 초과했습니다.');
  }
  const worker=(options.workerFactory??workerFactory)();
  return new Promise((resolve,reject)=>{
    let done=false,index=0,progress=0;const hashes:string[]=[];
    const cleanup=()=>{
      signal.removeEventListener('abort',onAbort);worker.removeEventListener('message',onMessage);
      worker.removeEventListener('error',onError);worker.removeEventListener('messageerror',onError);worker.terminate();
    };
    const finish=(error?:unknown)=>{if(done)return;done=true;try{cleanup();}catch(e){error??=e;}
      if(error!==undefined)reject(error);else resolve(Object.freeze(hashes));};
    const onAbort=()=>finish(signal.reason??new DOMException('Stopped','AbortError'));
    const onError=()=>finish(Error('입력 해시 Worker 오류'));
    const send=()=>worker.postMessage({index,blob:files[index]});
    const onMessage=(event:Event)=>{
      try{
        const value=(event as MessageEvent<unknown>).data;
        if(!value||typeof value!=='object'||Array.isArray(value))throw Error('입력 해시 Worker 응답 오류');
        const row=value as Record<string,unknown>;
        if(row.index!==index||!Number.isSafeInteger(row.bytes)||(row.bytes as number)<progress||(row.bytes as number)>files[index].size)
          throw Error('입력 해시 Worker 진행 상태 오류');
        if(row.kind==='progress'){
          progress=row.bytes as number;try{options.onProgress?.(index,progress);}catch{/* UI is not part of hashing. */}
        }else if(row.kind==='done'){
          if(row.bytes!==files[index].size||typeof row.sha256!=='string'||!HASH.test(row.sha256))throw Error('입력 해시 Worker 결과 오류');
          hashes.push(row.sha256);index++;progress=0;
          if(index===files.length)finish();else send();
        }else throw Error('입력 해시 Worker 응답 오류');
      }catch(error){finish(error);}
    };
    try{
      worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);worker.addEventListener('messageerror',onError);
      signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted){onAbort();return;}send();
    }catch(error){finish(error);}
  });
}

/** Shared by scanner selection and archival so missing/incorrect browser MIME
 * types cannot make valid extensions follow a different input path. */
export function classifyDirectInputs(files:readonly File[]):{kind:DirectInputKind;extensions:string[];totalBytes:number} {
  if(!Array.isArray(files)||files.length<1||files.length>MAX_INPUTS)throw Error('입력 파일 수가 올바르지 않습니다.');
  let totalBytes=0;
  const extensions=files.map(file=>{
    const name=file.name;
    if(!(file instanceof Blob)||typeof name!=='string'||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_FILE_BYTES)
      throw Error('입력 파일 크기 또는 이름이 올바르지 않습니다.');
    totalBytes+=file.size;if(!Number.isSafeInteger(totalBytes)||totalBytes>MAX_TOTAL_BYTES)throw Error('입력 파일 합계가 한도를 초과했습니다.');
    const match=/\.([a-z0-9]+)$/i.exec(name);if(!match)throw Error('지원하는 파일 확장자가 필요합니다.');
    return `.${match[1].toLowerCase()}`;
  });
  if(extensions.every(extension=>IMAGES.has(extension)))return {kind:'images',extensions,totalBytes};
  if(extensions.length===1&&VIDEOS.has(extensions[0]))return {kind:'video',extensions,totalBytes};
  if(extensions.length===1&&extensions[0]==='.loareplay')return {kind:'replay',extensions,totalBytes};
  throw Error('영상 또는 재현 파일 한 개, 혹은 이미지 파일만 선택하세요.');
}

function timestamp(value:unknown):value is string {
  if(typeof value!=='string')return false;
  try{return new Date(value).toISOString()===value;}catch{return false;}
}
/** One FileList selection, with a registration time assigned on its first
 * upload attempt. Keep the object for retry; a new change event needs a new
 * selection. File modification times are not capture-time evidence. */
export class DirectInputSelection {
  readonly id:string;readonly selectedAt:string|null;readonly lastModifiedMs:readonly (number|null)[];
  readonly #kind:DirectInputKind;readonly #extensions:readonly string[];readonly #sizes:readonly number[];
  #registrationStartedAt:string|null=null;
  #hashes:readonly string[]|undefined;
  constructor(files:readonly File[],selectedAt:string|null=null){
    const description=classifyDirectInputs(files);
    if(selectedAt!==null&&!timestamp(selectedAt))throw Error('입력 선택 시각이 올바르지 않습니다.');
    this.id=crypto.randomUUID();this.selectedAt=selectedAt;this.#kind=description.kind;
    this.#extensions=Object.freeze([...description.extensions]);this.#sizes=Object.freeze(files.map(file=>file.size));
    this.lastModifiedMs=Object.freeze(files.map(file=>Number.isSafeInteger(file.lastModified)&&file.lastModified>=0?file.lastModified:null));
  }
  forRegistration(files:readonly File[]){
    const description=classifyDirectInputs(files);
    if(description.kind!==this.#kind||files.length!==this.#sizes.length||files.some((file,index)=>
      file.size!==this.#sizes[index]||description.extensions[index]!==this.#extensions[index]||
      (Number.isSafeInteger(file.lastModified)&&file.lastModified>=0?file.lastModified:null)!==this.lastModifiedMs[index]))
      throw Error('선택한 파일이 변경되어 새 선택이 필요합니다.');
    this.#registrationStartedAt??=new Date().toISOString();
    return {id:this.id,selectedAt:this.selectedAt,registrationStartedAt:this.#registrationStartedAt,lastModifiedMs:[...this.lastModifiedMs]};
  }
  bindHashes(hashes:readonly string[]){
    if(this.#hashes&&this.#hashes.some((hash,index)=>hash!==hashes[index]))throw Error('선택한 파일의 내용이 변경되어 새 선택이 필요합니다.');
    this.#hashes??=Object.freeze([...hashes]);
  }
}
export function createDirectInputSelection(files:readonly File[],selectedAt:string|null=null):DirectInputSelection {
  return new DirectInputSelection(files,selectedAt);
}

async function expectedCaseId(kind:DirectInputKind,hashes:readonly string[]):Promise<string> {
  const encoded=new TextEncoder().encode(JSON.stringify({version:1,kind,inputs:hashes}));
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',encoded));
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}

async function boundedResponse(response:Response,signal:AbortSignal):Promise<unknown> {
  if(!response.body)throw Error('로컬 보관 응답이 없습니다.');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  const abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
    while(true){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;
      total+=part.value.length;if(total>MAX_RESPONSE_BYTES){await reader.cancel();throw Error('로컬 보관 응답이 너무 큽니다.');}chunks.push(part.value);
    }
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}

/** Archive before scanning and use the returned case as the scanner source.
 * The receipt proves the server accepted matching bytes, not that a later
 * range request or OCR result is independently verified. */
export async function archiveDirectInputs(files:readonly File[],options:{signal:AbortSignal;onProgress?:(value:DirectInputProgress)=>void;
  send?:typeof fetch;hashFiles?:(files:readonly Blob[],signal:AbortSignal,onProgress:(index:number,bytes:number)=>void)=>Promise<readonly string[]>;
  selection?:DirectInputSelection;timeoutMs?:number}):Promise<DirectInputReceipt> {
  const {kind,extensions,totalBytes}=classifyDirectInputs(files),timeoutMs=options.timeoutMs??600_000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>600_000)throw Error('입력 보관 제한 시간이 올바르지 않습니다.');
  const signal=AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)]);signal.throwIfAborted();
  const selectionState=options.selection??createDirectInputSelection(files),selection=selectionState.forRegistration(files);
  const notify=(value:DirectInputProgress)=>{try{options.onProgress?.(value);}catch{/* UI is not part of archival. */}};
  const progress=(index:number,processedBytes:number)=>notify({phase:'hashing',index,count:files.length,
    fileBytes:files[index].size,processedBytes,totalBytes});
  const hashes=await (options.hashFiles??((items,s,onProgress)=>hashDirectFiles(items,s,{onProgress})))(files,signal,progress);
  signal.throwIfAborted();
  if(!Array.isArray(hashes)||hashes.length!==files.length||hashes.some(hash=>typeof hash!=='string'||!HASH.test(hash)))throw Error('입력 해시 결과가 올바르지 않습니다.');
  selectionState.bindHashes(hashes);
  const inputs=files.map((file,index)=>({index,extension:extensions[index],bytes:file.size,sha256:hashes[index]}));
  const header=new TextEncoder().encode(JSON.stringify({version:2,kind,inputs,selection}));
  if(header.length>MAX_HEADER_BYTES)throw Error('입력 목록이 너무 큽니다.');
  const prefix=new Uint8Array(12);prefix.set(new TextEncoder().encode('LOAINP1\0'));new DataView(prefix.buffer).setUint32(8,header.length,true);
  const caseId=await expectedCaseId(kind,hashes);signal.throwIfAborted();
  const selectionRecord=new TextEncoder().encode(`${JSON.stringify({version:1,caseId,kind,selection,inputs,captureTime:null})}\n`);
  const selectionDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',selectionRecord)),byte=>byte.toString(16).padStart(2,'0')).join('');
  signal.throwIfAborted();
  const body=new Blob([prefix,header,...files],{type:'application/octet-stream'});
  notify({phase:'uploading',count:files.length,totalBytes});
  const response=await (options.send??fetch)('/__corpus/direct-input',{method:'POST',headers:{'Content-Type':'application/octet-stream'},
    body,credentials:'same-origin',redirect:'error',signal});
  if(!response.ok)throw Error(`로컬 입력 보관 실패 (${response.status})`);
  const value=await boundedResponse(response,signal);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('로컬 입력 보관 응답이 올바르지 않습니다.');
  const row=value as Record<string,unknown>;
  const selected=row.selection as Record<string,unknown>|undefined;
  const allowed=(extension:unknown)=>typeof extension==='string'&&
    (kind==='video'?VIDEOS.has(extension):kind==='images'?IMAGES.has(extension):extension==='.loareplay');
  if(typeof row.created!=='boolean'||row.caseId!==caseId||row.kind!==kind||!selected||typeof selected!=='object'||Array.isArray(selected)||
    Object.keys(selected).sort().join(',')!=='id,sha256'||selected.id!==selection.id||selected.sha256!==selectionDigest||
    !Array.isArray(row.inputs)||row.inputs.length!==inputs.length||
    row.inputs.some((item,index)=>!item||typeof item!=='object'||Array.isArray(item)||
      Object.keys(item).sort().join(',')!=='bytes,extension,index,sha256'||
      (item as DirectInputDescriptor).index!==index||!allowed((item as DirectInputDescriptor).extension)||
      row.created===true&&(item as DirectInputDescriptor).extension!==inputs[index].extension||
      (item as DirectInputDescriptor).bytes!==inputs[index].bytes||(item as DirectInputDescriptor).sha256!==inputs[index].sha256))
    throw Error('로컬 입력 보관 응답이 원본 파일과 일치하지 않습니다.');
  // The corpus identity is based on ordered content hashes. A prior case may
  // already own the same bytes under another allowed extension; return the
  // canonical descriptors so the scanner uses the stored representation.
  return {created:row.created,caseId,kind,inputs:Object.freeze((row.inputs as DirectInputDescriptor[]).map(input=>Object.freeze({...input}))),
    selection:Object.freeze({id:selection.id,sha256:selectionDigest})};
}
