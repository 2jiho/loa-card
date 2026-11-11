import {readFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function analyzeCountSourceProbe(report){
 const validation=report?.validation??{},e=report?.countSourceEvidence,stats=report?.performance?.countSourceProbe??null;
 const requested=typeof validation.countSourceProbeRequested==='boolean'?validation.countSourceProbeRequested:null;
 if(!e||typeof e!=='object')return {status:'unavailable',requested,scope:'No physical source or independent-repeat verification.'};
 const count=v=>Number.isSafeInteger(v)&&v>=0;
 if(!Array.isArray(e.events)||e.events.length>4096||!count(e.attempted)||!count(e.recorded)||!count(e.omitted)||e.recorded!==e.events.length||e.attempted!==e.recorded+e.omitted||e.retainedEveryDeliveredCallback!==(e.omitted===0))throw Error('Invalid count source evidence');
 let measured=0,reused=0,missing=0,invalid=0;
 for(const event of e.events){
  if(!event||event.version!==1||!event.source||!Object.hasOwn(event,'raster')){invalid++;continue;}
  if(event.raster===null)missing++;
  else if(event.raster?.kind==='measured')measured++;
  else if(event.raster?.kind==='analysis-reused')reused++;
  else invalid++;
 }
 const observed=measured+reused+missing;
 const summaryMatches=stats&&count(stats.measured)&&count(stats.reused)&&count(stats.missing)?stats.measured===measured&&stats.reused===reused&&stats.missing===missing:null;
 const stable=validation.sourceChanged===false&&typeof validation.sourceStart?.sourceDigest==='string'&&/^[a-f0-9]{64}$/.test(validation.sourceStart.sourceDigest)&&validation.sourceStart.sourceDigest===validation.sourceEnd?.sourceDigest;
 const complete=requested===true&&validation.completed===true&&stable&&e.omitted===0&&invalid===0&&stats?.recordingComplete===true&&summaryMatches===true;
 return {status:complete?'observed-callbacks':'partial',requested,sourceStable:stable,inputIntegrity:validation.integrity??null,
  retention:{attempted:e.attempted,recorded:e.recorded,omitted:e.omitted,summaryMatches},events:{measured,reused,missing,invalid,observed},stats,
  scope:'Metadata callbacks only. Raster receipts do not establish physical capture provenance, independent repeats, card correctness, full frame coverage, or completion.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length!==3)throw Error('Usage: node scripts/analyze-count-source-probe.mjs <run.json>');const path=process.argv[2];
  if((await stat(path)).size>16*1024*1024)throw Error('Report too large');const bytes=await readFile(path);if(bytes.length>16*1024*1024)throw Error('Report too large');
  console.log(JSON.stringify(analyzeCountSourceProbe(JSON.parse(bytes)),null,2));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
