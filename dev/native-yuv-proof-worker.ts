import {ALL_FORMATS,BlobSource,Input,VideoSampleSink} from 'mediabunny';
import type {InputVideoTrack} from 'mediabunny';
import {planNativeYuvFrame,convertNativeYuvToRgba,nativeYuvDescriptorJson,UnsupportedNativeYuvError} from './native-yuv-recipe';
import type {NativeYuvFrameMetadata} from './native-yuv-recipe';

export const MAX_NATIVE_YUV_SOURCE_BYTES=256*1024*1024;
export interface NativeYuvProofLimits {maxFramesPerPass:number;maxMetadataBytes:number;deadlineMs:number}
export const NATIVE_YUV_PROOF_LIMITS:Readonly<NativeYuvProofLimits>=Object.freeze({maxFramesPerPass:10_000,maxMetadataBytes:8*1024*1024,deadlineMs:120_000});
const MAX_FRAME_BYTES=64*1024*1024,MAX_DIFFERENCES=64;
type Color=NativeYuvFrameMetadata['colorSpace'];
type Plane={offset:number;stride:number};
type Recipe=ReturnType<typeof planNativeYuvFrame>['recipe'];
export interface NativeYuvProofSource {caseId:string;index:number;sha256:string;bytes:number;type:string}
export interface NativeYuvProofSample {
 timestamp:number;duration:number;rotation:number;flip:boolean;pixelAspectRatio:{num:number;den:number};
 colorSpace:{toJSON():VideoColorSpaceInit};toVideoFrame():NativeYuvProofFrame;close():void;
}
export interface NativeYuvProofFrame {
 format:string|null;codedWidth:number;codedHeight:number;displayWidth:number;displayHeight:number;
 visibleRect:{x:number;y:number;width:number;height:number}|null;timestamp:number;duration:number|null;
 /** New WebCodecs attributes are absent from some TypeScript/browser builds.
  * Absence is unsupported, never an assumed unrotated source. */
 rotation?:number;flip?:boolean;
 colorSpace:{toJSON():VideoColorSpaceInit};allocationSize(options:VideoFrameCopyToOptions):number;
 copyTo(pixels:Uint8Array<ArrayBuffer>,options:VideoFrameCopyToOptions):Promise<PlaneLayout[]>;close():void;
}
export interface NativeYuvProofTrack {
 id:number;canDecode():Promise<boolean>;computeDuration():Promise<number>;getDisplayWidth():Promise<number>;getDisplayHeight():Promise<number>;
}
export interface NativeYuvProofInput {getPrimaryVideoTrack():Promise<NativeYuvProofTrack|null>;dispose():void}
export interface NativeYuvProofPlatform {
 createInput(blob:Blob):NativeYuvProofInput;
 createSamples(track:NativeYuvProofTrack):AsyncIterator<NativeYuvProofSample>;
 hash(bytes:Uint8Array<ArrayBuffer>):Promise<string>;
 now():number;
 /** Tests may tighten bounds; they cannot relax the production caps. */
 limits?:Partial<NativeYuvProofLimits>;
}
export interface NativeYuvProofScope {postMessage(value:unknown):void}
export interface NativeYuvProofRecord {
 ordinal:number;trackId:number;
 sample:{pts:number;duration:number;rotation:number;flip:boolean;pixelAspectRatio:{num:number;den:number};colorSpace:Color};
 native:NativeYuvFrameMetadata&{timestampMicroseconds:number;durationMicroseconds:number|null};
 planes:Plane[];packedBytes:number;rgbaBytes:number;profile:Recipe;nativeSha256:string;generatedRgbaSha256:string;descriptorSha256:string;
}
export interface NativeYuvProofPass {
 pass:number;timingPolicy:string;track:{id:number;duration:number;width:number;height:number}|null;
 frames:NativeYuvProofRecord[];
 stats:{samplesClosed:number;nativeFramesClosed:number;frames:number;packedBytes:number;rgbaBytes:number;
  maxPackedBytes:number;maxRgbaBytes:number;maxApplicationPixelBytes:number;metadataBytes:number;
  nativeCopyMs:number;nativeHashMs:number;conversionMs:number;rgbaHashMs:number;descriptorHashMs:number;elapsedMs:number;jitterCount:number;pixelBufferPairAllocations:number};
 cleanup:{inputDisposed:boolean;iteratorReturnJoined:boolean;errors:string[]};
}
export interface NativeYuvProofReport {
 complete:boolean;source:NativeYuvProofSource|null;sourceVerified:boolean;passes:NativeYuvProofPass[];
 comparison:(ReturnType<typeof compareNativeYuvPasses>&{trackMetadataMatch:boolean})|null;elapsedMs:number;
 limits:{sourceBytes:number;encodedDigestArrayBufferCapBytes:number;frameBytes:number;framesPerPass:number;retainedMetadataBytes:number};
 boundaries:string[];
}
type Code='protocol'|'unsupported'|'runtime'|'cancelled'|'timeout'|'integrity'|'cleanup';
class ProofError extends Error {readonly code:Code;constructor(code:Code,message:string){super(message);this.code=code;}}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const natural=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const positive=(value:unknown):value is number=>natural(value)&&value>0;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function keys(value:Record<string,unknown>,expected:string[]){if(Object.keys(value).some(key=>!expected.includes(key))||expected.some(key=>!Object.hasOwn(value,key)))throw new ProofError('protocol','Unexpected or missing request properties.');}
const color=(value:VideoColorSpaceInit):Color=>({primaries:value.primaries??null,transfer:value.transfer??null,matrix:value.matrix??null,fullRange:value.fullRange??null});
function sourceFrom(value:unknown,blob:unknown):NativeYuvProofSource {
 if(!object(value))throw new ProofError('protocol','A source content reference is required.');
 keys(value,['caseId','index','sha256','bytes','type']);
 if(!sha(value.caseId)||!natural(value.index)||value.index>9999||!sha(value.sha256)||!positive(value.bytes)||value.bytes>MAX_NATIVE_YUV_SOURCE_BYTES||
  typeof value.type!=='string'||value.type.length>128||!/^video\/(?:mp4|webm)(?:;codecs=[a-zA-Z0-9.," -]{1,96})?$/.test(value.type)||
  !(blob instanceof Blob)||blob.size!==value.bytes||blob.type!==''&&blob.type!==value.type)
  throw new ProofError('protocol','Invalid encoded Blob size, media type or source identity.');
 return Object.freeze({caseId:value.caseId,index:value.index,sha256:value.sha256,bytes:value.bytes,type:value.type});
}
const defaultPlatform:NativeYuvProofPlatform={
 createInput:blob=>new Input({formats:ALL_FORMATS,source:new BlobSource(blob)}),
 createSamples:track=>new VideoSampleSink(track as InputVideoTrack,{hardwareAcceleration:'no-preference'}).samples(),
 hash:async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join(''),
 now:()=>performance.now(),
};
function validLimits(supplied:NativeYuvProofPlatform['limits']){
 const limits={...NATIVE_YUV_PROOF_LIMITS,...supplied};
 for(const key of ['maxFramesPerPass','maxMetadataBytes','deadlineMs'] as const)
  if(!positive(limits[key])||limits[key]>NATIVE_YUV_PROOF_LIMITS[key])throw new ProofError('protocol','Invalid tightened proof bounds.');
 return limits;
}
function blankPass(pass:number):NativeYuvProofPass {return {pass,timingPolicy:pass===1?'sequential; no seek or dropped samples':'sequential; cooperative 1-3ms jitter every five samples',track:null,frames:[],
 stats:{samplesClosed:0,nativeFramesClosed:0,frames:0,packedBytes:0,rgbaBytes:0,maxPackedBytes:0,maxRgbaBytes:0,maxApplicationPixelBytes:0,
  metadataBytes:0,nativeCopyMs:0,nativeHashMs:0,conversionMs:0,rgbaHashMs:0,descriptorHashMs:0,elapsedMs:0,jitterCount:0,pixelBufferPairAllocations:0},
 cleanup:{inputDisposed:false,iteratorReturnJoined:false,errors:[]}};}
function metadata(record:NativeYuvProofRecord){const {nativeSha256:_native,generatedRgbaSha256:_rgba,descriptorSha256:_descriptor,...rest}=record;return rest;}
/** Exact packed native bytes, generated RGBA and metadata are separate checks.
 * They establish repeatability for these two visits, not equivalence to Canvas. */
export function compareNativeYuvPasses(first:readonly NativeYuvProofRecord[],second:readonly NativeYuvProofRecord[]){
 if(!first.length||!second.length)throw new ProofError('unsupported','No decoded native frames.');
 let nativeDifferences=0,rgbaDifferences=0,descriptorDifferences=0,metadataDifferences=0,changed=0;
 const differences:{ordinal:number;reasons:string[]}[]=[];
 for(let index=0;index<Math.max(first.length,second.length);index++){
  const a=first[index],b=second[index],reasons:string[]=[];
  if(!a||!b)reasons.push('missing-frame');
  else{
   if(a.nativeSha256!==b.nativeSha256){nativeDifferences++;reasons.push('packed-native-bytes');}
   if(a.generatedRgbaSha256!==b.generatedRgbaSha256){rgbaDifferences++;reasons.push('generated-rgba-bytes');}
   if(a.descriptorSha256!==b.descriptorSha256){descriptorDifferences++;reasons.push('native-descriptor');}
   if(JSON.stringify(metadata(a))!==JSON.stringify(metadata(b))){metadataDifferences++;reasons.push('metadata-profile-or-layout');}
  }
  if(reasons.length){changed++;if(differences.length<MAX_DIFFERENCES)differences.push({ordinal:index+1,reasons});}
 }
 return {framesFirst:first.length,framesSecond:second.length,sameFrameCount:first.length===second.length,
  matchedFrames:Math.max(first.length,second.length)-changed,nativeDifferences,rgbaDifferences,descriptorDifferences,metadataDifferences,
  matchedAll:changed===0,differences,differencesOmitted:Math.max(0,changed-differences.length)};
}

/** One owned job, two sequential passes. Buffers never leave this Worker and
 * both native/sample owners close before any per-frame metadata is published. */
export function createNativeYuvProofRuntime(scope:NativeYuvProofScope,platform:NativeYuvProofPlatform=defaultPlatform){
 const limits=validLimits(platform.limits);
 let active:{id:number;controller:AbortController;work:Promise<void>;disposeCurrent?:()=>void}|undefined;
 const post=(value:unknown)=>{try{scope.postMessage(value);}catch{/* Parent owns termination even if its channel is gone. */}};
 function check(signal:AbortSignal){signal.throwIfAborted();}
 async function decodePass(blob:Blob,pass:NativeYuvProofPass,signal:AbortSignal,job:{disposeCurrent?:()=>void},progress:(value:Record<string,unknown>)=>void,budget:{bytes:number}){
  const started=platform.now();let input:NativeYuvProofInput|undefined,iterator:AsyncIterator<NativeYuvProofSample>|undefined,disposed=false,failed=false,reason:unknown;
  const dispose=()=>{if(disposed||!input)return;disposed=true;try{input.dispose();pass.cleanup.inputDisposed=true;}catch(error){pass.cleanup.errors.push(String(error).slice(0,500));}};
  job.disposeCurrent=dispose;signal.addEventListener('abort',dispose,{once:true});
  try{
   check(signal);input=platform.createInput(blob);check(signal);
   const track=await input.getPrimaryVideoTrack();check(signal);
   if(!track||!positive(track.id)||!await track.canDecode())throw new ProofError('unsupported','Native video decoding is unavailable.');check(signal);
   const [duration,width,height]=await Promise.all([track.computeDuration(),track.getDisplayWidth(),track.getDisplayHeight()]);check(signal);
   if(!time(duration)||!positive(width)||!positive(height)||width*height*4>MAX_FRAME_BYTES)throw new ProofError('unsupported','Unsupported track size or duration.');
   pass.track={id:track.id,duration,width,height};iterator=platform.createSamples(track);
   let lastPts=-Infinity,packed:Uint8Array<ArrayBuffer>|undefined,rgba:Uint8Array<ArrayBuffer>|undefined;
   while(true){
    check(signal);const next=await iterator.next();
    if(next.done){check(signal);break;}
    const sample=next.value;let frame:NativeYuvProofFrame|undefined,record:NativeYuvProofRecord|undefined,frameFailed=false,frameReason:unknown;
    try{
     check(signal);
     if(pass.frames.length>=limits.maxFramesPerPass)throw new ProofError('unsupported','Frame record bound exceeded.');
     if(!time(sample.timestamp)||sample.timestamp<lastPts||!time(sample.duration)||sample.pixelAspectRatio.num!==1||sample.pixelAspectRatio.den!==1||
      sample.rotation!==0||sample.flip!==false)throw new ProofError('unsupported','Unsupported sample timing, orientation or pixel aspect ratio.');
     frame=sample.toVideoFrame();
     if(!natural(frame.timestamp)||frame.duration!==null&&!natural(frame.duration))throw new ProofError('unsupported','Unsupported native frame timing.');
     if(frame.rotation!==0||frame.flip!==false)throw new ProofError('unsupported','Native orientation is unknown or outside rotation=0/flip=false.');
     const native:NativeYuvProofRecord['native']={format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
      displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,visibleRect:frame.visibleRect?
       {x:frame.visibleRect.x,y:frame.visibleRect.y,width:frame.visibleRect.width,height:frame.visibleRect.height}:null,
      rotation:frame.rotation,flip:frame.flip,colorSpace:color(frame.colorSpace.toJSON()),
      timestampMicroseconds:frame.timestamp,durationMicroseconds:frame.duration};
     const plan=planNativeYuvFrame(native);
     if(!positive(plan.nativeByteLength)||!positive(plan.rgbaByteLength)||plan.nativeByteLength>MAX_FRAME_BYTES||plan.rgbaByteLength>MAX_FRAME_BYTES)
      throw new ProofError('unsupported','Pixel payload bound exceeded.');
     // No format/colorSpace request: copy only the native planes into our
     // explicitly packed layout. There are no unspecified padding bytes.
     const options:VideoFrameCopyToOptions={layout:plan.layout.map(plane=>({...plane}))};
     if(frame.allocationSize(options)!==plan.nativeByteLength)throw new ProofError('unsupported','Packed native allocationSize mismatch.');
     // Reuse only after copy/hash/conversion of the previous sample settled.
     // A native buffer and a distinct RGBA target are owned by this pass.
     if(!packed||!rgba||packed.byteLength!==plan.nativeByteLength||rgba.byteLength!==plan.rgbaByteLength){
      packed=new Uint8Array(plan.nativeByteLength);rgba=new Uint8Array(plan.rgbaByteLength);pass.stats.pixelBufferPairAllocations++;
     }
     packed.fill(0);
     pass.stats.maxPackedBytes=Math.max(pass.stats.maxPackedBytes,packed.byteLength);pass.stats.maxRgbaBytes=Math.max(pass.stats.maxRgbaBytes,rgba.byteLength);
     pass.stats.maxApplicationPixelBytes=Math.max(pass.stats.maxApplicationPixelBytes,packed.byteLength+rgba.byteLength);
     let at=platform.now();const returned=await frame.copyTo(packed,options);pass.stats.nativeCopyMs+=platform.now()-at;check(signal);
     if(!Array.isArray(returned)||returned.length!==plan.layout.length||returned.some((plane,index)=>!plane||
      plane.offset!==plan.layout[index].offset||plane.stride!==plan.layout[index].stride))throw new ProofError('unsupported','Native copy returned a different packed layout.');
     at=platform.now();const nativeSha256=await platform.hash(packed);pass.stats.nativeHashMs+=platform.now()-at;check(signal);
     at=platform.now();const converted=convertNativeYuvToRgba(native,packed,returned,rgba);pass.stats.conversionMs+=platform.now()-at;check(signal);
     if(converted.rgba!==rgba||JSON.stringify(converted.plan)!==JSON.stringify(plan))throw new ProofError('runtime','Converter did not use the validated owned target and plan.');
     at=platform.now();const generatedRgbaSha256=await platform.hash(rgba);pass.stats.rgbaHashMs+=platform.now()-at;check(signal);
     at=platform.now();const descriptorSha256=await platform.hash(new TextEncoder().encode(nativeYuvDescriptorJson(native,returned)));
     pass.stats.descriptorHashMs+=platform.now()-at;check(signal);
     if(!sha(nativeSha256)||!sha(generatedRgbaSha256)||!sha(descriptorSha256))throw new ProofError('integrity','Invalid generated frame SHA receipt.');
     record={ordinal:pass.frames.length+1,trackId:track.id,
      sample:{pts:sample.timestamp,duration:sample.duration,rotation:sample.rotation,flip:sample.flip,
       pixelAspectRatio:{num:sample.pixelAspectRatio.num,den:sample.pixelAspectRatio.den},colorSpace:color(sample.colorSpace.toJSON())},
      native,planes:returned.map(plane=>({offset:plane.offset,stride:plane.stride})),packedBytes:packed.byteLength,rgbaBytes:rgba.byteLength,
      profile:plan.recipe,nativeSha256,generatedRgbaSha256,descriptorSha256};
    }catch(error){frameFailed=true;frameReason=error;}
    finally{
     try{if(frame){frame.close();pass.stats.nativeFramesClosed++;}}catch(error){pass.cleanup.errors.push(`frame.close: ${String(error).slice(0,300)}`);}
     try{sample.close();pass.stats.samplesClosed++;}catch(error){pass.cleanup.errors.push(`sample.close: ${String(error).slice(0,300)}`);}
    }
    if(pass.cleanup.errors.length)throw new ProofError('cleanup',pass.cleanup.errors.join(' · '));
    if(frameFailed)throw frameReason;check(signal);
    const bytes=new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if(budget.bytes+bytes>limits.maxMetadataBytes)throw new ProofError('unsupported','Retained metadata bound exceeded.');
    budget.bytes+=bytes;pass.stats.metadataBytes+=bytes;pass.frames.push(record!);lastPts=record!.sample.pts;
    pass.stats.frames++;pass.stats.packedBytes+=record!.packedBytes;pass.stats.rgbaBytes+=record!.rgbaBytes;
    if(pass.frames.length===1||pass.frames.length%10===0)
     progress({phase:'decode',pass:pass.pass,frames:pass.frames.length,nativeFormat:record!.native.format,profileId:record!.profile.id});
    // Delay affects only cooperative execution; every sample is still visited.
    if(pass.pass===2&&pass.frames.length%5===0){pass.stats.jitterCount++;
     await new Promise<void>(resolve=>setTimeout(resolve,1+pass.frames.length%3));check(signal);}
   }
   if(!pass.frames.length)throw new ProofError('unsupported','No native samples were decoded.');
  }catch(error){failed=true;reason=error;}
  finally{
   signal.removeEventListener('abort',dispose);job.disposeCurrent=undefined;dispose();
   try{if(iterator?.return){await iterator.return();pass.cleanup.iteratorReturnJoined=true;}}catch(error){pass.cleanup.errors.push(`iterator.return: ${String(error).slice(0,300)}`);}
   pass.stats.elapsedMs=platform.now()-started;
  }
  if(pass.cleanup.errors.length)throw new ProofError('cleanup',pass.cleanup.errors.join(' · '));
  if(failed)throw reason;
 }
 async function run(id:number,blob:Blob,source:NativeYuvProofSource,job:{controller:AbortController;disposeCurrent?:()=>void}){
  const started=platform.now(),signal=job.controller.signal;
  const report:NativeYuvProofReport={complete:false,source,sourceVerified:false,passes:[],comparison:null,elapsedMs:0,
   limits:{sourceBytes:MAX_NATIVE_YUV_SOURCE_BYTES,encodedDigestArrayBufferCapBytes:MAX_NATIVE_YUV_SOURCE_BYTES,frameBytes:MAX_FRAME_BYTES,
    framesPerPass:limits.maxFramesPerPass,retainedMetadataBytes:limits.maxMetadataBytes},
   boundaries:[
    'Only the supplied immutable Blob and source content reference are used; no URL fetch, private-case shortcut, Canvas, OCR or v4 archive change.',
    'Packed native active-plane bytes and this named CPU recipe RGBA are compared across two sequential complete visits; no seek/drop/nearest-frame lookup.',
    'Actual native color metadata selects the supported recipe. Sample/library color is recorded separately and never fills missing native metadata.',
    'Actual native rotation/flip and sample/library orientation are independently required to be 0/false; missing native attributes are unsupported.',
    'Generated opaque RGBA is signal R-prime/G-prime/B-prime under the exact recipe; no transfer conversion, gamut mapping or color-managed sRGB claim.',
    'Equality is a local repeatability result, not proof of Canvas RGB equivalence, source frame identity, screenshot truth or all browser/decoder behavior.',
    'The decoder uses the no-preference hint. Mediabunny may predecode internally; requested packed+RGBA payload sizes and pair allocations are not physical or full decoder/GPU/process memory bounds.',
    'Blob SHA uses one bounded ArrayBuffer of at most 256MiB. Raw pixel buffers remain within the Worker and are not accumulated or posted.',
    'Cleanup receipts describe current sample/frame close, public iterator.return and Input.dispose only. The parent must terminate this Worker after completion or cancel grace.'
   ]};
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;job.controller.abort(new ProofError('timeout','Cooperative proof deadline exceeded.'));job.disposeCurrent?.();},limits.deadlineMs);
  try{
   check(signal);post({kind:'progress',id,phase:'source-sha',bytes:source.bytes});
   {
    const bytes=new Uint8Array(await blob.arrayBuffer());check(signal);
    if(bytes.byteLength!==source.bytes)throw new ProofError('integrity','Encoded Blob length changed.');
    const actual=await platform.hash(bytes);check(signal);
    if(actual!==source.sha256)throw new ProofError('integrity','Encoded Blob SHA-256 mismatch.');report.sourceVerified=true;
   }
   const budget={bytes:0};
   for(let pass=1;pass<=2;pass++){const entry=blankPass(pass);report.passes.push(entry);await decodePass(blob,entry,signal,job,value=>post({kind:'progress',id,...value}),budget);}
   check(signal);const compared=compareNativeYuvPasses(report.passes[0].frames,report.passes[1].frames);
   const trackMetadataMatch=JSON.stringify(report.passes[0].track)===JSON.stringify(report.passes[1].track);
   report.comparison={...compared,trackMetadataMatch,matchedAll:compared.matchedAll&&trackMetadataMatch};
   report.complete=true;report.elapsedMs=platform.now()-started;post({kind:'done',id,report});
  }catch(error){
   report.elapsedMs=platform.now()-started;
   const code:Code=timedOut?'timeout':signal.aborted?'cancelled':error instanceof ProofError?error.code:error instanceof UnsupportedNativeYuvError?'unsupported':'runtime';
   post({kind:'error',id,code,error:String(error).slice(0,2000),report});
  }finally{clearTimeout(timer);}
 }
 return {
  async handle(value:unknown){
   if(!object(value)||!positive(value.id))return;
   const id=value.id;
   if(value.kind==='cancel'){
    try{keys(value,['kind','id']);}catch(error){post({kind:'error',id,code:'protocol',error:String(error)});return;}
    if(active?.id===id){active.controller.abort(new ProofError('cancelled','Native YUV proof cancelled.'));active.disposeCurrent?.();await active.work;}
    return;
   }
   let source:NativeYuvProofSource;
   try{
    keys(value,['kind','id','blob','source']);if(value.kind!=='run')throw new ProofError('protocol','Unknown proof request.');
    source=sourceFrom(value.source,value.blob);if(active)throw new ProofError('protocol','A proof is already running; no application queue is supported.');
   }catch(error){post({kind:'error',id,code:'protocol',error:String(error).slice(0,2000)});return;}
   const job={id,controller:new AbortController(),work:Promise.resolve() as Promise<void>,disposeCurrent:undefined as (()=>void)|undefined};
   active=job;job.work=run(id,value.blob as Blob,source,job);
   try{await job.work;}finally{if(active===job)active=undefined;}
  },
 };
}

if(typeof document==='undefined'&&typeof self!=='undefined'){
 const scope=self as unknown as NativeYuvProofScope&{onmessage:((event:MessageEvent)=>void)|null};
 const runtime=createNativeYuvProofRuntime(scope);scope.onmessage=event=>{void runtime.handle(event.data);};
}
