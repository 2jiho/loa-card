import {FieldDiagnosticImages} from './field-diagnostic-images';
import type {NameAttempt} from './name-diagnostics';
import {unknownKeyId,unknownVersionId} from './unknown-lifecycle';
import type {UnknownEntry} from './unknown-lifecycle-types';
import {readPortraitDiagnostics,type PortraitDiagnostics} from './portrait-diagnostics';

/** Optional, bounded presentation data. Its absence never removes a warning. */
export class UnknownDiagnosticSidecars {
  private versions=new Map<string,{version:string;pixelKey:string}>();
  private metadata=new Map<string,{version:string;attempts?:readonly NameAttempt[];portraitDiagnostics:PortraitDiagnostics|null;bytes:number}>();
  private metadataBytes=0;
  private previews:FieldDiagnosticImages;
  private recognition:FieldDiagnosticImages;
  private limits:{entries:number;previewBytes:number;recognitionEntries:number;recognitionBytes:number;metadataBytes:number};
  constructor(limits={entries:128,previewBytes:2*1024*1024,recognitionEntries:32,
    recognitionBytes:1024*1024,metadataBytes:1024*1024}) {
    this.limits={...limits};
    this.previews=new FieldDiagnosticImages(limits.entries,limits.previewBytes);
    this.recognition=new FieldDiagnosticImages(limits.recognitionEntries,limits.recognitionBytes);
  }
  remember(entry:UnknownEntry,diagnostic:{pixelKey:string;preview:()=>string;
    recognition:()=>string;nameAttempts?:readonly NameAttempt[];portraitDiagnostics?:PortraitDiagnostics|null}) {
    const key=unknownKeyId(entry.key),version=unknownVersionId(entry),order=entry.captureOrder;
    const previous=this.versions.get(key);
    if(previous&&previous.version!==version&&previous.pixelKey!==diagnostic.pixelKey){
      this.previews.resolved(key,Infinity);this.recognition.resolved(key,Infinity);
    }
    this.versions.delete(key);this.versions.set(key,{version,pixelKey:diagnostic.pixelKey});
    this.removeMetadata(key);
    // The lifecycle has already accepted this entry. Encoding errors are local
    // diagnostic omissions, not missing input facts or failed recognition.
    if(order!==null){
      try{this.previews.capture(key,order,diagnostic.pixelKey,diagnostic.preview);}catch{/* Optional image. */}
      if(!entry.pending)try{this.recognition.capture(key,order,diagnostic.pixelKey,diagnostic.recognition);}catch{/* Optional image. */}
    }
    let attempts:readonly NameAttempt[]|undefined,attemptBytes=0;
    if(diagnostic.nameAttempts)try{
      const copied=diagnostic.nameAttempts.slice(0,24).map(attempt=>({...attempt,
        candidates:attempt.candidates.slice(0,3).map(candidate=>({...candidate}))}));
      const bytes=new TextEncoder().encode(JSON.stringify(copied)).byteLength;
      if(bytes<=this.limits.metadataBytes){attempts=Object.freeze(copied);attemptBytes=bytes;}
    }catch{/* Malformed optional OCR diagnostics do not own warning state. */}
    let portraitDiagnostics=readPortraitDiagnostics(diagnostic);
    const portraitBytes=portraitDiagnostics===null?0:new TextEncoder().encode(JSON.stringify(portraitDiagnostics)).byteLength;
    // Existing OCR diagnostics take precedence if this entry cannot retain
    // both optional payloads. Invalid portrait metadata consumes no budget.
    if(attemptBytes+portraitBytes>this.limits.metadataBytes)portraitDiagnostics=null;
    const bytes=attemptBytes+(portraitDiagnostics===null?0:portraitBytes);
    if(attempts!==undefined||portraitDiagnostics!==null){
      this.metadata.set(key,{version,...(attempts!==undefined?{attempts}:{}),portraitDiagnostics,bytes});this.metadataBytes+=bytes;
      while(this.metadataBytes>this.limits.metadataBytes)this.removeMetadata(this.metadata.keys().next().value!);
    }
    while(this.versions.size>this.limits.entries){
      const oldest=this.versions.keys().next().value!;
      this.versions.delete(oldest);this.removeMetadata(oldest);
      this.previews.resolved(oldest,Infinity);this.recognition.resolved(oldest,Infinity);
    }
  }
  retire(entries:readonly UnknownEntry[]) {
    for(const entry of entries){
      const key=unknownKeyId(entry.key);
      if(this.versions.get(key)?.version!==unknownVersionId(entry))continue;
      this.versions.delete(key);this.removeMetadata(key);
      if(entry.captureOrder!==null){this.previews.resolved(key,entry.captureOrder);this.recognition.resolved(key,entry.captureOrder);}
    }
  }
  project(entries:readonly UnknownEntry[]) {
    return entries.map(entry=>{
      const key=unknownKeyId(entry.key),version=unknownVersionId(entry),matches=this.versions.get(key)?.version===version,
        metadata=this.metadata.get(key),order=entry.captureOrder;
      return {
        image:matches&&order!==null?this.previews.get(key,order)??'':'',
        ...(matches&&order!==null?{recognitionImage:this.recognition.get(key,order)}:{}),
        // Live entries always have captureTime; legacy absence is display-only.
        time:entry.captureTime??0,...(order!==null?{captureOrder:order}:{}),pending:entry.pending,
        ...(entry.key.kind==='group'?{group:entry.key.group}:{}),reason:entry.reason,
        ...(entry.location?{location:{...entry.location}}:{}),...(entry.source?{source:{...entry.source}}:{}),
        ...(metadata?.version===version&&metadata.attempts!==undefined?{nameAttempts:metadata.attempts.map(attempt=>({...attempt,
          candidates:attempt.candidates.map(candidate=>({...candidate}))}))}:{}),
        portraitDiagnostics:metadata?.version===version?metadata.portraitDiagnostics:null,
      };
    });
  }
  private removeMetadata(key:string){
    const prior=this.metadata.get(key);
    if(prior){this.metadataBytes-=prior.bytes;this.metadata.delete(key);}
  }
}
