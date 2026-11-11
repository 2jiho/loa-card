import type {CountProvenanceEvent} from '../src/features/card-scanner/recognition/count-source-provenance';

/** Bounded metadata only; a successful callback is not physical-source proof. */
export function createCountSourceDiagnostics(options:{maxEvents?:number;maxBytes?:number}={}){
 const maxEvents=options.maxEvents??4096,maxBytes=options.maxBytes??2*1024*1024;
 if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>4096||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>2*1024*1024)throw Error('Invalid count diagnostic limits');
 const events:unknown[]=[];let attempted=0,omitted=0,bytes=0,closed=false;
 function record(event:CountProvenanceEvent):boolean{
  if(closed)return false;attempted++;
  try{
   const encoded=JSON.stringify(event);if(typeof encoded!=='string')throw Error('Invalid metadata');
   const size=new TextEncoder().encode(encoded).byteLength;
   if(size>8192||events.length>=maxEvents||bytes+size>maxBytes)throw Error('Diagnostic limit');
   events.push(JSON.parse(encoded));bytes+=size;return true;
  }catch{omitted++;return false;}
 }
 return {record,close(){closed=true;},snapshot(){return {version:1,scope:'count-source-metadata-only',attempted,recorded:events.length,omitted,bytes,maxEvents,maxBytes,
  retainedEveryDeliveredCallback:omitted===0,events:events.slice(),physicalSourceVerified:false,independentRepeatVerified:false};}};
}
