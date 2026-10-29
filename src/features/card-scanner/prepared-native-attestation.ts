import {parseNativeYuvMetadata,type NativeStorage} from './native-frame-storage';
import {NATIVE_YUV_RECIPES,nativeYuvDescriptorJson,planNativeYuvFrame} from './native-yuv-recipe';
import {MAX_FRAME_BYTES,pixelHash} from './recording-frame-integrity';

export interface PreparedNativeAttestation {
  readonly version:1;
  readonly kind:'prepared-native-conversion';
  readonly sessionId:string;
  readonly producerId:string;
  readonly requestId:number;
  readonly sourceFrameId:number;
  readonly captureTime:number;
  readonly width:number;
  readonly height:number;
  readonly nativeByteLength:number;
  readonly rgbaByteLength:number;
  readonly descriptorSha256:string;
  readonly recipeId:string;
  readonly recipeSha256:string;
  readonly nativeSha256:string;
  readonly generatedRgbaSha256:string;
  readonly ticketId:string;
}

declare const authorization:unique symbol;
/** Only take() on the private producer-port inbox grants this authority.
 * Parsing, cloning or importing the same JSON never grants it. */
export type AuthorizedPreparedNativeAttestation=PreparedNativeAttestation&{readonly [authorization]:true};

export interface PreparedNativeSourceBinding {readonly sourceFrameId:number;readonly captureTime:number}
export type PreparedNativeAttestationPort=Pick<MessagePort,'onmessage'|'onmessageerror'|'start'|'close'>;
export interface PreparedNativeAttestationInboxOptions {
  readonly sessionId:string;
  readonly producerId:string;
  readonly timeoutMs?:number;
  readonly maxPendingTuples?:number;
}

const KEYS=['version','kind','sessionId','producerId','requestId','sourceFrameId','captureTime','width','height',
  'nativeByteLength','rgbaByteLength','descriptorSha256','recipeId','recipeSha256','nativeSha256','generatedRgbaSha256','ticketId'] as const;
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RECIPES=new Set(Object.values(NATIVE_YUV_RECIPES).map(recipe=>recipe.id));
const MAX_PENDING=128,MAX_ISSUED=10_000,MAX_WAIT_MS=30_000;
type Epoch={active:boolean};
// Weak keys retain no source buffers and cannot be populated by the public parser.
const authorities=new WeakMap<object,{epoch:Epoch;consumed:boolean}>();

function fail(detail:string):never {throw Error(`Invalid prepared native attestation: ${detail}`);}
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('plain object required');
  const own=Reflect.ownKeys(value);
  if(own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))fail('unexpected or missing field');
  for(const key of keys){const property=Object.getOwnPropertyDescriptor(value,key);
    if(!property||!property.enumerable||!Object.hasOwn(property,'value'))fail('enumerable data fields required');}
  return value as Record<string,unknown>;
}
function positive(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<1)fail('positive safe integer required');return value as number;}
function time(value:unknown):number {if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail('finite capture time required');return value;}
function identity(value:unknown):string {
  if(typeof value!=='string'||value.length<1||value.length>128||/\s/.test(value)||
    Array.from(value).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))fail('bounded identity required');return value;
}
function hash(value:unknown):string {if(typeof value!=='string'||!HASH.test(value))fail('lowercase SHA-256 required');return value;}
function ticket(value:unknown):string {if(typeof value!=='string'||!UUID.test(value))fail('canonical UUID ticket required');return value;}
function dimensions(widthValue:unknown,heightValue:unknown){
  const width=positive(widthValue),height=positive(heightValue),rgbaByteLength=width*height*4;
  if(width%2||height%2||!Number.isSafeInteger(rgbaByteLength)||rgbaByteLength>MAX_FRAME_BYTES)fail('native dimensions/byte limit');
  return {width,height,rgbaByteLength,nativeByteLength:width*height*3/2};
}
function binding(value:unknown):PreparedNativeSourceBinding {
  const source=object(value,['sourceFrameId','captureTime']);
  return Object.freeze({sourceFrameId:positive(source.sourceFrameId),captureTime:time(source.captureTime)});
}

/** Shape/profile-name validation only. This function is NOT an issuer and its
 * return value cannot authorize the writer's deferred-conversion path. */
export function parsePreparedNativeAttestation(value:unknown):PreparedNativeAttestation {
  const receipt=object(value,KEYS),size=dimensions(receipt.width,receipt.height);
  if(receipt.version!==1||receipt.kind!=='prepared-native-conversion')fail('version/kind');
  if(receipt.nativeByteLength!==size.nativeByteLength||receipt.rgbaByteLength!==size.rgbaByteLength)fail('native/RGBA byte length');
  if(typeof receipt.recipeId!=='string'||!RECIPES.has(receipt.recipeId))fail('unsupported recipe');
  return Object.freeze({version:1,kind:'prepared-native-conversion',sessionId:identity(receipt.sessionId),producerId:identity(receipt.producerId),
    requestId:positive(receipt.requestId),sourceFrameId:positive(receipt.sourceFrameId),captureTime:time(receipt.captureTime),...size,
    descriptorSha256:hash(receipt.descriptorSha256),recipeId:receipt.recipeId,recipeSha256:hash(receipt.recipeSha256),
    nativeSha256:hash(receipt.nativeSha256),generatedRgbaSha256:hash(receipt.generatedRgbaSha256),ticketId:ticket(receipt.ticketId)});
}

/** Owns an endpoint transferred directly from the trusted preparation producer.
 * Only messages on this private capability port may issue authority. An ordinary
 * writer input, diagnostic callback, JSON parser or imported receipt may not.
 * Protocol faults, abort and timeout close the inbox; no pending source bytes
 * are retained here. Request IDs increase, but may skip raw-fallback requests. */
export function createPreparedNativeAttestationInbox(port:PreparedNativeAttestationPort,options:PreparedNativeAttestationInboxOptions) {
  const sessionId=identity(options.sessionId),producerId=identity(options.producerId),timeoutMs=options.timeoutMs??MAX_WAIT_MS,
    limit=options.maxPendingTuples??MAX_PENDING;
  if(typeof timeoutMs!=='number'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>MAX_WAIT_MS||
    !Number.isSafeInteger(limit)||limit<1||limit>MAX_PENDING)fail('inbox limits');
  if(!port||typeof port.start!=='function'||typeof port.close!=='function'||port.onmessage!=null||port.onmessageerror!=null)fail('unused private port required');
  const epoch:Epoch={active:true},pending=new Map<string,PreparedNativeAttestation>(),seen=new Set<string>();
  let received=0,issued=0,peakPending=0,lastRequestId=0,closed=false,failed=false,failure:Error|undefined;
  type Waiter={ticketId:string;expected:PreparedNativeSourceBinding;width:number;height:number;signal?:AbortSignal;
    resolve:(receipt:AuthorizedPreparedNativeAttestation)=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>;abort:()=>void};
  let waiter:Waiter|undefined;
  const releaseWaiter=()=>{const current=waiter;if(!current)return;waiter=undefined;clearTimeout(current.timer);
    current.signal?.removeEventListener('abort',current.abort);return current;};
  function stop(reason:unknown,protocolFailure:boolean){
    if(closed)return;closed=true;failed=protocolFailure;epoch.active=false;
    failure=reason instanceof Error?reason:Error(String(reason??'Prepared native attestation inbox disposed'));
    const current=releaseWaiter();pending.clear();seen.clear();port.onmessage=port.onmessageerror=null;
    try{port.close();}catch{/* The private endpoint is already unusable. */}
    current?.reject(failure);
  }
  function grant(receipt:PreparedNativeAttestation,expected:PreparedNativeSourceBinding,width:number,height:number){
    if(receipt.sourceFrameId!==expected.sourceFrameId||receipt.captureTime!==expected.captureTime||receipt.width!==width||receipt.height!==height)
      fail('ticket source binding/dimensions mismatch');
    pending.delete(receipt.ticketId);issued++;
    authorities.set(receipt,{epoch,consumed:false});return receipt as AuthorizedPreparedNativeAttestation;
  }
  port.onmessage=event=>{
    if(closed)return;
    try{
      const receipt=parsePreparedNativeAttestation(event.data);
      if(receipt.sessionId!==sessionId||receipt.producerId!==producerId)fail('producer/session mismatch');
      if(receipt.requestId<=lastRequestId)fail('non-increasing producer request');
      if(seen.has(receipt.ticketId))fail('duplicate or replayed ticket');
      if(received>=MAX_ISSUED)fail('issued ticket limit');
      if(waiter?.ticketId!==receipt.ticketId&&pending.size>=limit)fail('pending tuple limit');
      lastRequestId=receipt.requestId;seen.add(receipt.ticketId);received++;
      if(waiter?.ticketId===receipt.ticketId){
        const current=waiter,result=grant(receipt,current.expected,current.width,current.height);
        releaseWaiter();current.resolve(result);
      }else{pending.set(receipt.ticketId,receipt);peakPending=Math.max(peakPending,pending.size);}
    }catch(error){stop(error,true);}
  };
  port.onmessageerror=()=>stop(Error('Prepared native attestation private port message error'),true);
  try{port.start();}catch(error){stop(error,true);throw error;}
  return {
    take(ticketId:string,expectedValue:PreparedNativeSourceBinding,widthValue:number,heightValue:number,signal?:AbortSignal):Promise<AuthorizedPreparedNativeAttestation>{
      try{
        if(closed)throw failure??Error('Prepared native attestation inbox closed');
        const key=ticket(ticketId),expected=binding(expectedValue),{width,height}=dimensions(widthValue,heightValue);
        if(signal?.aborted){stop(signal.reason,false);throw failure;}
        if(waiter)fail('only one attestation waiter is allowed');
        const ready=pending.get(key);
        if(ready){
          try{return Promise.resolve(grant(ready,expected,width,height));}
          catch(error){stop(error,true);throw error;}
        }
        if(seen.has(key))fail('ticket already taken');
        return new Promise<AuthorizedPreparedNativeAttestation>((resolve,reject)=>{
          const abort=()=>stop(signal?.reason??new DOMException('Attestation wait aborted','AbortError'),false);
          const timer=setTimeout(()=>stop(Error('Prepared native attestation wait timeout'),true),timeoutMs);
          waiter={ticketId:key,expected,width,height,signal,resolve,reject,timer,abort};
          signal?.addEventListener('abort',abort,{once:true});
          if(signal?.aborted)abort();
        });
      }catch(error){return Promise.reject(error);}
    },
    dispose(reason:unknown=Error('Prepared native attestation inbox disposed')){stop(reason,false);},
    get stats(){return Object.freeze({received,issued,spent:issued,pending:pending.size,peakPending,waiting:waiter?1:0,
      lastRequestId,closed,failed,error:failure?.message??''});},
  };
}

export interface VerifiedAttestedPreparedNative {
  readonly attestation:AuthorizedPreparedNativeAttestation;
  readonly pixels:Uint8Array<ArrayBuffer>;
  readonly storage:NativeStorage;
  /** Authenticated producer output hash; not a writer RGBA measurement. */
  readonly hash:string;
}

/** Consumes an inbox-issued authority once. The writer rehashes all received
 * native bytes and the canonical descriptor/recipe, without converting RGBA.
 * Its generated-RGBA hash is trusted ONLY because the private producer already
 * computed that conversion. This is neither a full-raster measured receipt nor
 * independent field/count evidence. The caller must store the RETURNED pixels:
 * transfer-cloning before the first await detaches every caller buffer alias. */
export async function verifyAttestedPreparedNative(attestation:AuthorizedPreparedNativeAttestation,input:{descriptor:unknown;pixels:Uint8Array},signal?:AbortSignal):Promise<VerifiedAttestedPreparedNative> {
  const authority=attestation&&typeof attestation==='object'?authorities.get(attestation):undefined;
  if(!authority||authority.consumed||!authority.epoch.active)fail('private-port one-shot authority required');
  authority.consumed=true;signal?.throwIfAborted();
  const payload=object(input,['descriptor','pixels']),metadata=object(payload.descriptor,
    ['format','codedWidth','codedHeight','displayWidth','displayHeight','visibleRect','rotation','flip','colorSpace']);
  object(metadata.visibleRect,['x','y','width','height']);object(metadata.colorSpace,['primaries','transfer','matrix','fullRange']);
  const descriptor=parseNativeYuvMetadata(metadata),plan=planNativeYuvFrame(descriptor),pixels=payload.pixels;
  if(plan.width!==attestation.width||plan.height!==attestation.height||plan.nativeByteLength!==attestation.nativeByteLength||
    plan.rgbaByteLength!==attestation.rgbaByteLength||plan.recipe.id!==attestation.recipeId)fail('native dimensions/recipe binding mismatch');
  if(!(pixels instanceof Uint8Array)||!(pixels.buffer instanceof ArrayBuffer)||pixels.byteOffset!==0||
    pixels.byteLength!==plan.nativeByteLength||pixels.buffer.byteLength!==plan.nativeByteLength||
    (pixels.buffer as ArrayBuffer&{resizable?:boolean}).resizable===true)fail('owned fixed whole native ArrayBuffer required');
  try{new Uint8Array(pixels.buffer,0,plan.nativeByteLength);}catch{fail('detached native buffer');}
  const owned=structuredClone(pixels,{transfer:[pixels.buffer]}) as Uint8Array<ArrayBuffer>;
  const [nativeSha256,descriptorSha256,recipeSha256]=await Promise.all([pixelHash(owned),
    pixelHash(new TextEncoder().encode(nativeYuvDescriptorJson(descriptor,plan.layout))),
    pixelHash(new TextEncoder().encode(JSON.stringify(plan.recipe)))]);
  signal?.throwIfAborted();
  if(!authority.epoch.active)fail('attestation authority disposed during verification');
  if(nativeSha256!==attestation.nativeSha256||descriptorSha256!==attestation.descriptorSha256||recipeSha256!==attestation.recipeSha256)
    fail('native/descriptor/recipe hash mismatch');
  const storage:NativeStorage=Object.freeze({version:1,kind:'native-yuv420',descriptor,recipeId:plan.recipe.id,recipeSha256,descriptorSha256,nativeSha256,byteLength:plan.nativeByteLength});
  return Object.freeze({attestation,pixels:owned,storage,hash:attestation.generatedRgbaSha256});
}
