import type {FrameObstructionProbeEvent} from '../src/features/card-scanner/acquisition/acquisition-client';

/** Image-free, bounded optional diagnostics. This is not a reducer trace. */
export function createFrameObstructionDiagnostics(options:{maxEvents?:number;maxBytes?:number;now?:()=>number}={}){
 const maxEvents=options.maxEvents??512,maxBytes=options.maxBytes??512*1024,now=options.now??(()=>performance.now());
 if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>512||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>512*1024)
  throw Error('Invalid frame diagnostic limits');
 const rows:unknown[]=[];let attempted=0,omitted=0,bytes=0,captureMs=0,maxCaptureMs=0,closed=false;
 function record(event:FrameObstructionProbeEvent){
  if(closed)return false;attempted++;const start=now();
  try{
   if(!event||!['submitted','result','skipped','error'].includes(event.kind))throw Error('Unknown frame diagnostic');
   if(event.kind!=='error'&&(!Number.isSafeInteger(event.id)||event.id<1||!Number.isFinite(event.time)||event.time<0))throw Error('Invalid frame identity');
   const encoded=JSON.stringify(event);if(typeof encoded!=='string')throw Error('Invalid frame diagnostic payload');
   const size=new TextEncoder().encode(encoded).byteLength;if(size>64*1024||rows.length>=maxEvents||bytes+size>maxBytes)throw Error('Diagnostic limit');
   rows.push(JSON.parse(encoded));bytes+=size;return true;
  }catch{omitted++;return false;}
  finally{const elapsed=Math.max(0,now()-start);captureMs+=elapsed;maxCaptureMs=Math.max(maxCaptureMs,elapsed);}
 }
 return {record,close(){closed=true;},snapshot(){return {version:1,scope:'image-free-diagnostic-only',attempted,recorded:rows.length,omitted,
  retainedEveryDeliveredCallback:omitted===0,bytes,maxEvents,maxBytes,captureMs,maxCaptureMs,events:rows.slice(),
  interpretation:'Includes only callbacks delivered while the owned scanner was active. Missing/unfinished worker jobs and omitted callbacks are not zero candidates; no source-video PTS join or physical pixel replay.'};}};
}
