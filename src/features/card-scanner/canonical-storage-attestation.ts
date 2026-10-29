import type {ExactEntry,ExactFrame} from './exact-recording-codec';
import {parseFrameStorage,type FrameStorage,type NativeStorage} from './native-frame-storage';
import {nativeYuvDescriptorJson,planNativeYuvFrame} from './native-yuv-recipe';
import {parsePreparedNativeAttestation,type PreparedNativeAttestation} from './prepared-native-attestation';
import {MAX_FRAME_BYTES,pixelHash} from './recording-frame-integrity';

export interface CanonicalStorageAttestationContract {
  readonly version:1;
  /** Every native physical source in this declared recording requires exactly
   * one receipt. Canonical RGBA fallback frames are outside this native scope. */
  readonly mode:'prepared-native-attestation-v1';
  readonly sessionId:string;
  readonly producerId:string;
}

export interface CanonicalStorageAttestationSummary {
  readonly supported:boolean;
  readonly complete:boolean;
  readonly matches:true|null;
  readonly nativeFrames:number;
  readonly rgbaFrames:number;
  readonly attestations:number;
  readonly verified:number;
  readonly missingAttestations:number;
  readonly missingSources:number;
  readonly scope:'metadata-only';
  readonly payloadIntegrityVerified:false;
  readonly privatePortAuthorityRecreated:false;
}

const LIMIT=10_000,HASH=/^[a-f0-9]{64}$/;
function fail(detail:string):never {throw Error(`Invalid canonical storage attestation: ${detail}`);}
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('plain object required');
  const own=Reflect.ownKeys(value);
  if(own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))fail('unexpected or missing field');
  for(const key of keys){const property=Object.getOwnPropertyDescriptor(value,key);
    if(!property||!property.enumerable||!Object.hasOwn(property,'value'))fail('enumerable data fields required');}
  return value as Record<string,unknown>;
}
function identity(value:unknown):string {
  if(typeof value!=='string'||!value.length||value.length>128||/\s/.test(value)||
    Array.from(value).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))fail('bounded identity required');
  return value;
}

export function parseCanonicalStorageAttestationContract(value:unknown):CanonicalStorageAttestationContract {
  const contract=object(value,['version','mode','sessionId','producerId']);
  if(contract.version!==1||contract.mode!=='prepared-native-attestation-v1')fail('contract version/mode');
  return Object.freeze({version:1,mode:'prepared-native-attestation-v1',sessionId:identity(contract.sessionId),producerId:identity(contract.producerId)});
}

type SourceHeader=Readonly<Pick<ExactFrame,'id'|'width'|'height'|'time'|'hash'|'canonical'>&{storage?:FrameStorage}>;
function sourceHeader(frame:ExactFrame):SourceHeader {
  const bytes=frame.width*frame.height*4;
  if(!Number.isSafeInteger(frame.id)||frame.id<1||!Number.isSafeInteger(frame.width)||frame.width<1||
    !Number.isSafeInteger(frame.height)||frame.height<1||!Number.isSafeInteger(bytes)||bytes>MAX_FRAME_BYTES||
    !Number.isFinite(frame.time)||frame.time<0||typeof frame.hash!=='string'||!HASH.test(frame.hash))fail('source header');
  const storage=frame.storage===undefined?undefined:parseFrameStorage(frame.storage,frame.width,frame.height);
  return Object.freeze({id:frame.id,width:frame.width,height:frame.height,time:frame.time,hash:frame.hash,
    ...(frame.canonical===undefined?{}:{canonical:frame.canonical}),...(storage?{storage}:{})});
}

/** Archived metadata validator, NOT a private-port authority issuer. Event/header
 * arrivals may interleave; joins happen at finalization. Parsing an archived
 * receipt never creates AuthorizedPreparedNativeAttestation and does not replay
 * the original worker-port authentication. Native payload SHA and generated
 * RGBA integrity still require exactPixels/readCanonicalFrame independently.
 * Existing canonical-raster-contract v1 and measured raster receipts are separate.
 */
export class CanonicalStorageAttestationReplay {
  private contract:CanonicalStorageAttestationContract|undefined;
  private deferredFailure:string|undefined;
  private frames=new Map<number,SourceHeader>();
  private receipts=new Map<number,PreparedNativeAttestation>();
  private tickets=new Set<string>();
  private lastFrameId=0;
  private lastRequestId=0;
  private finishing:{recordingComplete:boolean;promise:Promise<CanonicalStorageAttestationSummary>}|undefined;
  private signal:AbortSignal|undefined;
  constructor(signal?:AbortSignal){this.signal=signal;}

  private invalid(detail:string){if(this.contract)fail(detail);this.deferredFailure??=detail;}

  accept(entry:ExactEntry):void {
    if(this.finishing)fail('already finalizing');
    this.signal?.throwIfAborted();
    if(entry.kind==='frame'){
      try{
        const frame=sourceHeader(entry);
        if(frame.id<=this.lastFrameId||this.frames.has(frame.id))fail('duplicate or non-increasing physical source');
        if(this.frames.size>=LIMIT)fail('source metadata limit');
        this.lastFrameId=frame.id;this.frames.set(frame.id,frame);
      }catch(error){this.invalid(error instanceof Error?error.message:String(error));}
      return;
    }
    if(entry.type==='canonical-storage-contract'){
      if(this.contract)fail('duplicate contract');
      this.contract=parseCanonicalStorageAttestationContract(entry.value);
      if(this.deferredFailure)fail(this.deferredFailure);
    }else if(entry.type==='canonical-storage-attestation'){
      const receipt=parsePreparedNativeAttestation(entry.value);
      if(this.receipts.size>=LIMIT)fail('receipt metadata limit');
      if(this.receipts.has(receipt.sourceFrameId))fail('duplicate attested source');
      if(this.tickets.has(receipt.ticketId))fail('duplicate or replayed ticket');
      if(receipt.requestId<=this.lastRequestId)fail('non-increasing producer request');
      if(this.contract&&(receipt.sessionId!==this.contract.sessionId||receipt.producerId!==this.contract.producerId))fail('producer/session mismatch');
      this.lastRequestId=receipt.requestId;this.receipts.set(receipt.sourceFrameId,receipt);this.tickets.add(receipt.ticketId);
    }
  }

  finalize(recordingComplete:boolean):Promise<CanonicalStorageAttestationSummary> {
    if(typeof recordingComplete!=='boolean')return Promise.reject(Error('Invalid canonical storage attestation: recording completion flag'));
    if(this.finishing){
      if(this.finishing.recordingComplete!==recordingComplete)return Promise.reject(Error('Invalid canonical storage attestation: completion flag changed after finalization'));
      return this.finishing.promise;
    }
    const promise=this.validate(recordingComplete);this.finishing={recordingComplete,promise};return promise;
  }

  /** Async because canonical descriptor/recipe hashes are recomputed; no full
   * native/RGBA payload is read, allocated, converted or retained here. */
  summary(recordingComplete:boolean):Promise<CanonicalStorageAttestationSummary> {return this.finalize(recordingComplete);}

  private async validate(recordingComplete:boolean):Promise<CanonicalStorageAttestationSummary> {
    this.signal?.throwIfAborted();
    let nativeFrames=0,rgbaFrames=0;
    for(const frame of this.frames.values()){
      if(frame.storage?.kind==='native-yuv420')nativeFrames++;else rgbaFrames++;
    }
    const base={nativeFrames,rgbaFrames,attestations:this.receipts.size,scope:'metadata-only' as const,
      payloadIntegrityVerified:false as const,privatePortAuthorityRecreated:false as const};
    if(!this.contract){
      if(this.receipts.size)fail('receipt without declared contract');
      return Object.freeze({...base,supported:false,complete:false,matches:null,verified:0,missingAttestations:0,missingSources:0});
    }
    if(this.deferredFailure)fail(this.deferredFailure);
    for(const frame of this.frames.values())
      if(frame.canonical!==true||!frame.storage)fail('contract requires canonical stored source headers');

    let verified=0,missingSources=0;
    const descriptorHashes=new Map<string,Promise<{descriptorSha256:string;recipeSha256:string}>>();
    for(const receipt of this.receipts.values()){
      this.signal?.throwIfAborted();
      if(receipt.sessionId!==this.contract.sessionId||receipt.producerId!==this.contract.producerId)fail('producer/session mismatch');
      const frame=this.frames.get(receipt.sourceFrameId);
      if(!frame){missingSources++;continue;}
      const storage=frame.storage;
      if(storage?.kind!=='native-yuv420')fail('receipt requires native storage');
      if(frame.time!==receipt.captureTime||frame.width!==receipt.width||frame.height!==receipt.height||frame.hash!==receipt.generatedRgbaSha256||
        storage.byteLength!==receipt.nativeByteLength||frame.width*frame.height*4!==receipt.rgbaByteLength||
        storage.nativeSha256!==receipt.nativeSha256||storage.descriptorSha256!==receipt.descriptorSha256||
        storage.recipeId!==receipt.recipeId||storage.recipeSha256!==receipt.recipeSha256)fail('source/attestation metadata mismatch');
      const hashes=await this.canonicalHashes(storage,descriptorHashes);this.signal?.throwIfAborted();
      if(hashes.descriptorSha256!==receipt.descriptorSha256||hashes.recipeSha256!==receipt.recipeSha256)fail('canonical descriptor/recipe hash mismatch');
      verified++;
    }
    let missingAttestations=0;
    for(const frame of this.frames.values())
      if(frame.storage?.kind==='native-yuv420'&&!this.receipts.has(frame.id))missingAttestations++;
    if(recordingComplete&&(missingAttestations||missingSources))fail('complete recording is missing source attestations or source headers');
    const complete=recordingComplete&&!missingAttestations&&!missingSources;
    return Object.freeze({...base,supported:true,complete,matches:complete&&nativeFrames>0?true:null,
      verified,missingAttestations,missingSources});
  }

  private canonicalHashes(storage:NativeStorage,cache:Map<string,Promise<{descriptorSha256:string;recipeSha256:string}>>){
    const plan=planNativeYuvFrame(storage.descriptor),descriptorJson=nativeYuvDescriptorJson(storage.descriptor,plan.layout);
    let hashes=cache.get(descriptorJson);
    if(!hashes){
      hashes=Promise.all([pixelHash(new TextEncoder().encode(descriptorJson)),pixelHash(new TextEncoder().encode(JSON.stringify(plan.recipe)))])
        .then(([descriptorSha256,recipeSha256])=>({descriptorSha256,recipeSha256}));
      cache.set(descriptorJson,hashes);
    }
    return hashes;
  }

  get stats(){return Object.freeze({contractDeclared:!!this.contract,frames:this.frames.size,receipts:this.receipts.size,
    tickets:this.tickets.size,lastFrameId:this.lastFrameId,lastRequestId:this.lastRequestId,finalizing:!!this.finishing});}
}
