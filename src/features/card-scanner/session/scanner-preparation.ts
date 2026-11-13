import { createRecognizer } from '../recognition/recognizer';
import { createAcquisitionClient } from '../acquisition/acquisition-client';
import { createVisualClient } from '../recognition/visual-client';
import {onceDisposer,settleDisposals} from '../capture/resource-cleanup';
import {NORMAL_SCANNER_NAME_CONFIGURATION,parseScannerNameConfiguration,sameScannerNameConfiguration} from './scanner-name-configuration';
import type {ScannerNameConfiguration} from './scanner-name-configuration';

export interface PreparedScanner {
  readonly readers:readonly Awaited<ReturnType<typeof createRecognizer>>[];
  readonly acquisition:ReturnType<typeof createAcquisitionClient>;
  readonly visuals:readonly ReturnType<typeof createVisualClient>[];
  readonly cancel:()=>void;
  readonly dispose:()=>Promise<void>;
}
type Shape={value:object;prototype:object|null;properties:readonly (readonly [PropertyKey,PropertyDescriptor])[]};
type Owner={configuration:ScannerNameConfiguration;claimed:boolean;closed:()=>boolean;
  readers:PreparedScanner['readers'];acquisition:PreparedScanner['acquisition'];visuals:PreparedScanner['visuals'];
  cancel:()=>void;dispose:()=>Promise<void>;resources:readonly Shape[];views:WeakMap<object,readonly Shape[]>};
const owners=new WeakMap<object,Owner>();

function shape(value:object):Shape {
  return {value,prototype:Object.getPrototypeOf(value),properties:Reflect.ownKeys(value).map(key=>
    [key,Object.getOwnPropertyDescriptor(value,key)!] as const)};
}
function unchanged(saved:Shape):boolean {
  const keys=Reflect.ownKeys(saved.value);
  if(Object.getPrototypeOf(saved.value)!==saved.prototype||keys.length!==saved.properties.length)return false;
  return saved.properties.every(([key,prior],index)=>{
    if(keys[index]!==key)return false;
    const current=Object.getOwnPropertyDescriptor(saved.value,key);
    return !!current&&(['value','get','set','writable','enumerable','configurable'] as const)
      .every(field=>Object.is(current[field],prior[field]));
  });
}
function owner(pool:unknown):Owner|undefined {
  return pool!==null&&typeof pool==='object'?owners.get(pool):undefined;
}
function valid(owner:Owner,pool:object):boolean {
  try{return !owner.closed()&&!!owner.views.get(pool)?.every(unchanged)&&owner.resources.every(unchanged);}
  catch{return false;}
}
function register(owner:Owner,pool:PreparedScanner):PreparedScanner {
  owner.views.set(pool,[shape(pool),shape(pool.readers),shape(pool.visuals)]);owners.set(pool,owner);return pool;
}

/** Unknown objects are never inspected, including caller-supplied getters. */
export function preparedScannerConfiguration(pool:unknown):ScannerNameConfiguration|null {
  const known=owner(pool);return known&&valid(known,pool as object)?known.configuration:null;
}
/** Transfer a factory-owned pool once; caller container mutations cannot alter
 * the issued view or the captured cleanup closures. Resource internals remain
 * the same owned sessions, not reconstructed or shared reader instances. */
export function claimPreparedScanner(pool:unknown,configuration:unknown):PreparedScanner {
  const config=parseScannerNameConfiguration(configuration),known=owner(pool);
  if(!known||!valid(known,pool as object))throw Error('준비된 인식 엔진의 출처 또는 상태를 확인할 수 없습니다.');
  if(known.claimed)throw Error('준비된 인식 엔진은 한 번만 사용할 수 있습니다.');
  if(!sameScannerNameConfiguration(known.configuration,config))throw Error('준비된 인식 엔진의 이름 판독 설정이 일치하지 않습니다.');
  const claimed=Object.freeze({readers:Object.freeze([...known.readers]),
    acquisition:known.acquisition,visuals:Object.freeze([...known.visuals]),cancel:known.cancel,dispose:known.dispose});
  register(known,claimed);known.claimed=true;return claimed;
}
export function cancelPreparedScanner(pool:unknown):void {owner(pool)?.cancel();}
export function disposePreparedScanner(pool:unknown):Promise<void> {return owner(pool)?.dispose()??Promise.resolve();}
/** A rejected competing consumer owns no transferred sessions. Preflight
 * cleanup may release only a still-unclaimed handle, never an active owner. */
export function cancelUnclaimedPreparedScanner(pool:unknown):void {
  const known=owner(pool);if(known&&!known.claimed)known.cancel();
}
export function disposeUnclaimedPreparedScanner(pool:unknown):Promise<void> {
  const known=owner(pool);return known&&!known.claimed?known.dispose():Promise.resolve();
}

/** What the row-centred scan reads with (row-scan.ts): one name reader, the acquisition worker
 * and two visual reading workers. */
export const PREPARED_VISUALS=2;

/** Fresh, unused sessions are transferred to one scan, never shared across scans. The name
 * reader is warmed once (its first reading loads the text model, seconds), so the scan starts
 * reading as soon as the share does. */
export async function prepareScanner(status: (message: string) => void, signal: AbortSignal,
  configuration:ScannerNameConfiguration=NORMAL_SCANNER_NAME_CONFIGURATION,
  options:{onCleanupUncertain?:(error:unknown)=>void}={}):Promise<PreparedScanner> {
  const config=parseScannerNameConfiguration(configuration);signal.throwIfAborted();
  const cleanupUncertain=(error:unknown)=>{try{options.onCleanupUncertain?.(error);}catch{/* Diagnostic observers cannot replace the original failure. */}};
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const readers: Awaited<ReturnType<typeof createRecognizer>>[] = [];
  const visuals: ReturnType<typeof createVisualClient>[] = [];
  let acquisition: ReturnType<typeof createAcquisitionClient> | undefined;
  let acquisitionDisposal:(()=>unknown)|undefined,disposed=false;
  const readerDisposals:(()=>unknown)[]=[],visualDisposals:(()=>unknown)[]=[];
  const disposeOwner=onceDisposer(async()=>{
    const errors=await settleDisposals([()=>signal.removeEventListener('abort',abort),()=>lifetime.abort(),
      ()=>acquisitionDisposal?.(),...visualDisposals,...readerDisposals]);
    if(errors.length){const error=new AggregateError(errors,'인식 엔진 준비 자원 종료 실패');cleanupUncertain(error);throw error;}
  });
  function dispose() {
    disposed=true;return disposeOwner(lifetime);
  }
  try {
    lifetime.signal.throwIfAborted();
    status('인식 엔진 준비 중');
    const reader=await createRecognizer(status, lifetime.signal,
      {nameRawResultPolicy:config.rawResultPolicy,...(config.contrastNameFallback?{contrastNameFallback:true}:{}),
        ...(options.onCleanupUncertain?{onInitializationCleanupError:cleanupUncertain}:{})});
    readers.push(reader);const release=reader.dispose;readerDisposals.push(()=>release.call(reader));
    acquisition = createAcquisitionClient(lifetime.signal);
    const ownedAcquisition=acquisition,releaseAcquisition=acquisition.dispose;acquisitionDisposal=()=>releaseAcquisition.call(ownedAcquisition);
    for (let i = 0; i < PREPARED_VISUALS; i++) {
      const visual=createVisualClient(lifetime.signal);visuals.push(visual);
      if(visual){const releaseVisual=visual.dispose;visualDisposals.push(()=>releaseVisual.call(visual));}
    }
    await Promise.all([acquisition.ready(), ...visuals.map(worker => worker?.ready())]);
    lifetime.signal.throwIfAborted();
    // The first name reading loads the text model: run it once on a blank card (browser only).
    if(typeof document!=='undefined'){
      status('이름 판독 준비 중');
      const blank=Object.assign(document.createElement('canvas'),{width:140,height:210});
      blank.getContext('2d',{willReadFrequently:true})!.fillRect(0,0,140,210);
      try{await reader.identify(blank,true,true);}catch{/* Warm-up only. */}
      blank.width=0;
      lifetime.signal.throwIfAborted();
    }
    // Cancellation stops Worker requests immediately; the scan that claims this pool joins its
    // in-flight work before dispose.
    const cancel=()=>lifetime.abort(),ownedReaders=Object.freeze([...readers]),ownedVisuals=Object.freeze([...visuals]);
    const resources=[acquisition,...readers,...visuals.filter((visual):visual is NonNullable<typeof visual>=>!!visual)].map(shape);
    const known:Owner={configuration:config,claimed:false,closed:()=>disposed||lifetime.signal.aborted,
      readers:ownedReaders,acquisition,visuals:ownedVisuals,cancel,dispose,resources,views:new WeakMap()};
    return register(known,{readers:[...readers],acquisition,visuals:[...visuals],cancel,dispose});
  } catch (error) {
    try{await dispose();}catch{try{status('인식 엔진 준비 실패 · 자원 종료 오류');}catch{/* Keep the original preparation failure. */}}
    throw error;
  }
}
