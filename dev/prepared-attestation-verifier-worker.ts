import {createPreparedNativeAttestationInbox,verifyAttestedPreparedNative} from '../src/features/card-scanner/prepared-native-attestation';
import {parseNativeYuvMetadata,prepareNativeStorage} from '../src/features/card-scanner/native-frame-storage';
import {planNativeYuvFrame} from '../src/features/card-scanner/native-yuv-recipe';

// Development-only transport/verification probe. No OPFS write, stored ACK,
// field acceptance or canonical-raster-contract is produced by this worker.
let mode:'independent'|'attested'|undefined,busy=false,closed=false,lastId=0;
let inbox:ReturnType<typeof createPreparedNativeAttestationInbox>|undefined;
const own=(value:unknown,keys:string[])=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||
  Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error('Invalid verifier message');
 return value as Record<string,unknown>;
};
const error=(id:unknown,cause:unknown)=>self.postMessage({kind:'error',id,error:String(cause).slice(0,2000)});
self.onmessage=async(event:MessageEvent)=>{
 const value=event.data;
 if(value?.kind==='init'){
  try{
   if(mode||closed)throw Error('Verifier already initialized');
   const data=own(value,value.mode==='attested'?['kind','mode','port','sessionId','producerId']:['kind','mode']);
   if(data.mode!=='independent'&&data.mode!=='attested')throw Error('Invalid verifier mode');
   if(data.mode==='attested'){
    if(!(data.port instanceof MessagePort))throw Error('Private capability port required');
    inbox=createPreparedNativeAttestationInbox(data.port,{sessionId:data.sessionId as string,producerId:data.producerId as string});
   }
   mode=data.mode;self.postMessage({kind:'ready',mode});
  }catch(cause){error(0,cause);}return;
 }
 if(value?.kind==='dispose'){
  closed=true;inbox?.dispose(new DOMException('Development verifier disposed','AbortError'));
  if(!busy)self.postMessage({kind:'disposed'});return;
 }
 const id=value?.id;
 let ownsBusy=false;
 try{
  const data=own(value,mode==='attested'?['kind','id','binding','width','height','native','ticketId']:['kind','id','binding','width','height','native']);
  if(data.kind!=='verify'||!mode||closed||busy||!Number.isSafeInteger(id)||id<=lastId)throw Error('Verifier unavailable or source order invalid');
  const binding=own(data.binding,['sourceFrameId','captureTime']),native=own(data.native,['descriptor','pixels']);
  if(binding.sourceFrameId!==id||typeof binding.captureTime!=='number'||!Number.isFinite(binding.captureTime)||binding.captureTime<0)throw Error('Verifier binding mismatch');
  const descriptor=parseNativeYuvMetadata(native.descriptor),plan=planNativeYuvFrame(descriptor),pixels=native.pixels;
  if(data.width!==plan.width||data.height!==plan.height||!(pixels instanceof Uint8Array)||!(pixels.buffer instanceof ArrayBuffer)||
   pixels.byteOffset!==0||pixels.byteLength!==plan.nativeByteLength||pixels.buffer.byteLength!==plan.nativeByteLength||
   (pixels.buffer as ArrayBuffer&{resizable?:boolean}).resizable===true)throw Error('Verifier native ownership mismatch');
  const ownedPixels=new Uint8Array(pixels.buffer);
  busy=true;ownsBusy=true;lastId=id;
  const started=performance.now();
  const verified=mode==='attested'
   ?await verifyAttestedPreparedNative(await inbox!.take(data.ticketId as string,{sourceFrameId:id,captureTime:binding.captureTime},plan.width,plan.height),{descriptor,pixels:ownedPixels})
   :await prepareNativeStorage(descriptor,ownedPixels).then(result=>({pixels:ownedPixels,storage:result.storage,hash:result.rgbaHash}));
  if(closed)throw new DOMException('Development verifier disposed','AbortError');
  const workMs=performance.now()-started;
  self.postMessage({kind:'verified',id,mode,binding,width:plan.width,height:plan.height,hash:verified.hash,storage:verified.storage,
   pixels:verified.pixels,workMs,...('attestation' in verified?{attestation:verified.attestation}:{})},{transfer:[verified.pixels.buffer]});
 }catch(cause){error(id,cause);}
 finally{if(ownsBusy){busy=false;if(closed)self.postMessage({kind:'disposed'});}}
};
