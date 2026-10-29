import {parseNativeYuvMetadata,parseFrameStorage,prepareNativeStorage,type NativeStorage} from './native-frame-storage';
import {planNativeYuvFrame,UnsupportedNativeYuvError,type NativeYuvFrameMetadata} from './native-yuv-recipe';
import {pixelHash} from './recording-frame-integrity';
import {SOURCE_PREPARATION_BYTES,parsePreparedSource,parseSourceBinding,parsePreparationAttestationIdentity,parseSourcePreparationMode,preparationObject,sourceRgbaBytes,
  type PreparedSource,type SourceBinding,type SourcePreparationAttestationIdentity,type SourcePreparationMode} from './source-preparation-protocol';
import {parsePreparedNativeAttestation} from './prepared-native-attestation';

export interface PreparationFrame {
  readonly displayWidth:number;readonly displayHeight:number;readonly codedWidth:number;readonly codedHeight:number;
  readonly format:string|null;readonly visibleRect:{x:number;y:number;width:number;height:number}|null;
  readonly rotation?:number;readonly flip?:boolean;
  readonly colorSpace:{toJSON():{primaries?:string|null;transfer?:string|null;matrix?:string|null;fullRange?:boolean|null}};
  allocationSize(options:VideoFrameCopyToOptions):number;
  copyTo(pixels:Uint8Array<ArrayBuffer>,options:VideoFrameCopyToOptions):Promise<PlaneLayout[]>;
  close():void;
}
export interface PreparationBitmap {readonly width:number;readonly height:number;close():void}
type OwnedInput=PreparationFrame|PreparationBitmap;
interface RasterCanvas {
  width:number;height:number;
  getContext(type:'2d',options:{willReadFrequently:true}):{
    drawImage(input:CanvasImageSource,x:number,y:number,width:number,height:number):void;
    getImageData(x:number,y:number,width:number,height:number):{data:Uint8ClampedArray};
  }|null;
}
export interface SourcePreparationPlatform {
  isFrame(value:unknown):value is PreparationFrame;
  isBitmap(value:unknown):value is PreparationBitmap;
  createCanvas(width:number,height:number):RasterCanvas;
  native?(descriptor:NativeYuvFrameMetadata,pixels:Uint8Array<ArrayBuffer>):ReturnType<typeof prepareNativeStorage>;
  hash?(pixels:Uint8Array<ArrayBuffer>):Promise<string>;
  now?():number;
  isAttestationPort?(value:unknown):value is MessagePort;
  randomUUID?():string;
}
export interface SourcePreparationScope {postMessage(value:unknown,transfer?:Transferable[]):void}
const defaultPlatform:SourcePreparationPlatform={
  isFrame:(value):value is PreparationFrame=>typeof VideoFrame!=='undefined'&&value instanceof VideoFrame,
  isBitmap:(value):value is PreparationBitmap=>typeof ImageBitmap!=='undefined'&&value instanceof ImageBitmap,
  createCanvas:(width,height)=>new OffscreenCanvas(width,height) as unknown as RasterCanvas,
};

/** Read the actual retained frame getters once. Clocks are deliberately outside
 * the strict color descriptor and never replace the caller's capture binding. */
function describe(frame:PreparationFrame,displayWidth:number,displayHeight:number):NativeYuvFrameMetadata {
  if(typeof frame.allocationSize!=='function'||typeof frame.copyTo!=='function'||typeof frame.colorSpace?.toJSON!=='function')
    throw new UnsupportedNativeYuvError('native-copy-api-unavailable');
  const rect=frame.visibleRect,color=frame.colorSpace.toJSON();
  const descriptor:NativeYuvFrameMetadata={format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
    displayWidth,displayHeight,visibleRect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,
    rotation:frame.rotation as number,flip:frame.flip as boolean,
    colorSpace:{primaries:color.primaries??null,transfer:color.transfer??null,matrix:color.matrix??null,fullRange:color.fullRange??null}};
  planNativeYuvFrame(descriptor);return parseNativeYuvMetadata(descriptor);
}

/** One active transferred handle, no pending source queue. Cooperative dispose
 * joins copy/hash ownership; client termination bounds hung browser operations. */
export function createSourcePreparationWorkerRuntime(scope:SourcePreparationScope,platform:SourcePreparationPlatform=defaultPlatform){
  type Job={id:number;input:OwnedInput;binding:SourceBinding;attest:boolean;mode:SourcePreparationMode;abort:AbortController;work:Promise<void>};
  let active:Job|undefined,ready=false,closing=false,disposed=false,lastId=0;
  let attestation:SourcePreparationAttestationIdentity&{port:MessagePort}|undefined;
  const closed=new WeakSet<object>(),now=platform.now??(()=>performance.now()),hash=platform.hash??pixelHash;
  const close=(input:OwnedInput)=>{if(closed.has(input))return;closed.add(input);input.close();};
  const owned=(value:unknown):value is OwnedInput=>platform.isFrame(value)||platform.isBitmap(value);
  const isPort=platform.isAttestationPort??((value:unknown):value is MessagePort=>typeof MessagePort!=='undefined'&&value instanceof MessagePort);
  const closePort=(port:MessagePort|undefined)=>{if(port)try{port.close();}catch{/* Stop retaining a failed capability. */}};
  const closeAttestation=()=>{const port=attestation?.port;attestation=undefined;closePort(port);};
  const rejectInput=(input:OwnedInput|undefined)=>{if(input&&active?.input!==input)try{close(input);}catch{return false;}return true;};
  const error=(id:number,cause:unknown,fatal=false)=>{try{scope.postMessage({kind:'preparation-error',id,error:String(cause).slice(0,2000),fatal});}catch{/* Parent deadline still ends ownership. */}};
  async function prepare(job:Job){
    const start=now(),check=()=>job.abort.signal.throwIfAborted();
    let canvas:RasterCanvas|undefined,result:PreparedSource|undefined,nativeStorage:NativeStorage|undefined,failure:unknown,failed=false,cleanupFailed=false;
    try{
      check();const isFrame=platform.isFrame(job.input),width=isFrame?(job.input as PreparationFrame).displayWidth:(job.input as PreparationBitmap).width,
        height=isFrame?(job.input as PreparationFrame).displayHeight:(job.input as PreparationBitmap).height,rgbaBytes=sourceRgbaBytes(width,height),reservationBytes=rgbaBytes*2;
      if(reservationBytes>SOURCE_PREPARATION_BYTES)throw Error('Source preparation byte limit');
      let descriptor:NativeYuvFrameMetadata|undefined,fallbackReason:string|undefined;
      if(job.mode==='canvas')fallbackReason='canvas-requested';
      else if(isFrame)try{descriptor=describe(job.input as PreparationFrame,width,height);}
      catch(cause){if(cause instanceof UnsupportedNativeYuvError)fallbackReason=cause.reason;else throw cause;}
      else fallbackReason='image-bitmap-native-unavailable';
      if(descriptor){
        const frame=job.input as PreparationFrame,plan=planNativeYuvFrame(descriptor),copyOptions={layout:plan.layout.map(plane=>({...plane}))};
        if(frame.allocationSize(copyOptions)!==plan.nativeByteLength)throw Error('Native allocation size mismatch');
        const packed=new Uint8Array(plan.nativeByteLength),copyStart=now(),layout=await frame.copyTo(packed,copyOptions);check();
        const copyMs=Math.max(0,now()-copyStart);
        if(!Array.isArray(layout)||layout.length!==plan.layout.length||layout.some((plane,index)=>!plane||
          ![Object.prototype,null].includes(Object.getPrototypeOf(plane))||Object.keys(plane).length!==2||
          !Object.hasOwn(plane,'offset')||!Object.hasOwn(plane,'stride')||plane.offset!==plan.layout[index].offset||plane.stride!==plan.layout[index].stride))
          throw Error('Native copy layout mismatch');
        const convertStart=now(),prepared=await(platform.native??prepareNativeStorage)(descriptor,packed);check();
        if(job.attest){const storage=parseFrameStorage(prepared.storage,width,height);
          if(storage.kind!=='native-yuv420'||JSON.stringify(storage.descriptor)!==JSON.stringify(descriptor))throw Error('Prepared attestation native descriptor mismatch');
          nativeStorage=storage;}
        result=parsePreparedSource({binding:job.binding,width,height,pixels:prepared.pixels,
          storage:{kind:'native',descriptor,pixels:packed},hash:prepared.rgbaHash,mode:'native',reservationBytes,
          outputBytes:plan.nativeByteLength+rgbaBytes,
          timing:{copyMs,conversionHashMs:Math.max(0,now()-convertStart),rasterMs:0,totalMs:Math.max(0,now()-start)}});
      }else{
        const rasterStart=now();canvas=platform.createCanvas(width,height);canvas.width=width;canvas.height=height;
        const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('Raw source context unavailable');
        context.drawImage(job.input as CanvasImageSource,0,0,width,height);
        const read=context.getImageData(0,0,width,height).data;
        if(!(read instanceof Uint8ClampedArray)||!(read.buffer instanceof ArrayBuffer)||read.byteOffset!==0||
          read.byteLength!==rgbaBytes||read.buffer.byteLength!==rgbaBytes||
          (read.buffer as ArrayBuffer&{resizable?:boolean}).resizable===true)throw Error('Raw source raster size mismatch');
        const pixels=new Uint8Array(read.buffer),storagePixels=pixels.slice();
        const rasterMs=Math.max(0,now()-rasterStart),hashStart=now(),rgbaHash=await hash(pixels);check();
        result=parsePreparedSource({binding:job.binding,width,height,pixels,storage:{kind:'rgba',pixels:storagePixels.buffer},hash:rgbaHash,
          mode:'rgba',fallbackReason,reservationBytes,outputBytes:rgbaBytes*2,
          timing:{copyMs:0,conversionHashMs:Math.max(0,now()-hashStart),rasterMs,totalMs:Math.max(0,now()-start)}});
      }
    }catch(cause){failed=true;failure=cause;}
    finally{
      if(canvas)try{canvas.width=0;canvas.height=0;}catch(cause){failed=true;cleanupFailed=true;failure=cause;}
      try{close(job.input);}catch(cause){failed=true;cleanupFailed=true;failure=cause;}
    }
    if(job.abort.signal.aborted){error(job.id,job.abort.signal.reason);return;}
    if(failed){error(job.id,failure,cleanupFailed);return;}
    try{
      if(job.attest&&result!.storage.kind==='native'){
        // Only this trusted bootstrap port conveys authority. Parsed JSON and
        // the ordinary result channel carry no capability to mint a tuple.
        if(!attestation||!nativeStorage||closing)throw Error('Prepared attestation capability closed');
        const tuple=parsePreparedNativeAttestation({version:1,kind:'prepared-native-conversion',sessionId:attestation.sessionId,
          producerId:attestation.producerId,requestId:job.id,...job.binding,width:result!.width,height:result!.height,
          nativeByteLength:nativeStorage.byteLength,rgbaByteLength:result!.pixels.byteLength,
          descriptorSha256:nativeStorage.descriptorSha256,recipeId:nativeStorage.recipeId,recipeSha256:nativeStorage.recipeSha256,
          nativeSha256:nativeStorage.nativeSha256,generatedRgbaSha256:result!.hash,ticketId:(platform.randomUUID??(()=>crypto.randomUUID()))()});
        result=parsePreparedSource({...result!,storage:{...result!.storage,ticketId:tuple.ticketId}});
        job.abort.signal.throwIfAborted();attestation.port.postMessage(tuple);
      }
      job.abort.signal.throwIfAborted();
      scope.postMessage({kind:'prepared',id:job.id,result},[result!.pixels.buffer,
      result!.storage.kind==='native'?result!.storage.pixels.buffer:result!.storage.pixels]);}
    catch(cause){if(job.attest){closing=true;closeAttestation();}error(job.id,cause,job.attest);}
  }
  return {
    async handle(value:unknown){
      const candidate=owned(value)?value:value&&typeof value==='object'?(value as {input?:unknown}).input:undefined,input=owned(candidate)?candidate:undefined;
      if(value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='init'){
        let incoming:MessagePort|undefined;
        try{
          const offered=(value as {attestation?:unknown}).attestation;
          if(offered&&typeof offered==='object'&&isPort((offered as {port?:unknown}).port))incoming=(offered as {port:MessagePort}).port;
          const data=preparationObject(value,['kind','attestation'],['kind']);
          if(ready||closing)throw Error('Source preparation already initialized');
          if(Object.hasOwn(data,'attestation')){
            const configured=preparationObject(data.attestation,['version','sessionId','producerId','port']);
            if(!isPort(configured.port))throw Error('Invalid owned attestation MessagePort');
            const identity=parsePreparationAttestationIdentity({version:configured.version,sessionId:configured.sessionId,producerId:configured.producerId});
            attestation={...identity,port:configured.port};
          }
          scope.postMessage({kind:'ready',...(attestation?{attestation:{version:1,sessionId:attestation.sessionId,producerId:attestation.producerId}}:{})});ready=true;
        }catch(cause){if(incoming&&incoming!==attestation?.port)closePort(incoming);if(!ready)closeAttestation();error(0,cause,!rejectInput(input));}return;
      }
      if(value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='dispose'){
        try{preparationObject(value,['kind']);}catch(cause){error(0,cause,!rejectInput(input));return;}
        if(closing)return;closing=true;active?.abort.abort(new DOMException('Source preparation disposed','AbortError'));
        await active?.work;closeAttestation();disposed=true;scope.postMessage({kind:'disposed'});return;
      }
      const id=value&&typeof value==='object'?(value as {id?:unknown}).id:undefined;
      let binding:SourceBinding,attest=false,mode:SourcePreparationMode;
      try{
        const data=preparationObject(value,['kind','id','input','binding','attest','mode'],['kind','id','input','binding']);
        if(data.kind!=='prepare'||!Number.isSafeInteger(id)||(id as number)<1||(id as number)<=lastId||!input||closed.has(input))
          throw Error('Invalid owned source preparation request');
        lastId=id as number;binding=parseSourceBinding(data.binding);
        mode=Object.hasOwn(data,'mode')?parseSourcePreparationMode(data.mode):'auto';
        if(Object.hasOwn(data,'attest')&&typeof data.attest!=='boolean')throw Error('Invalid source preparation attestation request');
        attest=data.attest===true;if(attest&&!attestation)throw Error('Source preparation attestation capability unavailable');
        if(!ready||closing||active)throw Error('Source preparation is unavailable or busy');
      }catch(cause){error(Number.isSafeInteger(id)?id as number:0,cause,!rejectInput(input));return;}
      const job:Job={id:id as number,input:input!,binding,attest,mode,abort:new AbortController(),work:Promise.resolve()};
      active=job;job.work=prepare(job);try{await job.work;}finally{if(active===job)active=undefined;}
    },
    get stats(){return {active:active?1:0,closing,disposed,lastId};},
  };
}

if(typeof document==='undefined'&&typeof self!=='undefined'){
  const scope=self as unknown as SourcePreparationScope&{onmessage:((event:MessageEvent)=>void)|null};
  const runtime=createSourcePreparationWorkerRuntime(scope);scope.onmessage=event=>{void runtime.handle(event.data);};
}
