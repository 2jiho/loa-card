import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const number=value=>Number.isSafeInteger(value)&&value>=0?value:null;
/** Image-free callbacks and queue counters; no video ordinal/time joins. */
export function analyzeFrameObstructionProbe(report){
 const v=report?.validation??{},p=report?.performance??{},e=report?.frameObstructionEvidence;
 const requested=typeof v.frameObstructionProbeRequested==='boolean'?v.frameObstructionProbeRequested:null;
 const hashRequested=typeof v.frameObstructionHashRequested==='boolean'?v.frameObstructionHashRequested:null;
 const hashes=[v.sourceStart?.sourceDigest,v.sourceEnd?.sourceDigest],sourceStable=v.sourceChanged===false&&hashes.every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))&&hashes[0]===hashes[1];
 if(!e||typeof e!=='object')return {status:'unavailable',requested,sourceStable,reason:'no diagnostic callback record',scope:'No source-frame or pixel equality proof.'};
 if(!Array.isArray(e.events)||e.events.length>512||number(e.attempted)===null||number(e.recorded)!==e.events.length||number(e.omitted)===null||
   e.attempted!==e.recorded+e.omitted||typeof e.retainedEveryDeliveredCallback!=='boolean'||e.retainedEveryDeliveredCallback!==(e.omitted===0))
  throw Error('Invalid bounded frame diagnostic evidence');
 const submitted=new Map(),results=new Map(),skips={},errors=[],idsWithDuplicates=[];let truncated=0,unsupported=0,invalid=0,candidates=0;
 const readback=[],compute=[],hashTimes=[];let hashOk=0,hashFailed=0,hashMissing=0,hashInvalid=0,hashRequestMissing=0,hashRequestMismatch=0;
 for(const event of e.events){
  if(!event||typeof event!=='object'||!['submitted','result','skipped','error'].includes(event.kind))throw Error('Invalid diagnostic event');
  if(event.kind==='error'){errors.push(String(event.reason??'unknown').slice(0,300));continue;}
  if(number(event.id)===null||event.id===0||typeof event.time!=='number'||!Number.isFinite(event.time)||event.time<0)throw Error('Invalid diagnostic frame identity');
  if(event.kind==='skipped'){const reason=String(event.reason??'unknown').slice(0,300);skips[reason]=(skips[reason]??0)+1;continue;}
  const target=event.kind==='submitted'?submitted:results;if(target.has(event.id))idsWithDuplicates.push(event.id);target.set(event.id,event);
  if(event.kind==='submitted'){if(typeof event.readbackMs==='number'&&Number.isFinite(event.readbackMs)&&event.readbackMs>=0)readback.push(event.readbackMs);
   if(typeof event.hashRequested!=='boolean')hashRequestMissing++;else if(hashRequested!==null&&event.hashRequested!==hashRequested)hashRequestMismatch++;continue;}
  if(typeof event.computeMs==='number'&&Number.isFinite(event.computeMs)&&event.computeMs>=0)compute.push(event.computeMs);
  const hash=event.roiHash;
  if(hash===undefined)hashMissing++;
  else if(!hash||hash.algorithm!=='sha256'||hash.scope!=='roi-rgba-content-only'||hash.captureTimeVerified!==false||hash.physicalSourceVerified!==false||typeof hash.hashMs!=='number'||!Number.isFinite(hash.hashMs)||hash.hashMs<0||
    !(hash.status==='ok'&&typeof hash.hex==='string'&&/^[a-f0-9]{64}$/.test(hash.hex)||hash.status==='failed'&&hash.hex===null))hashInvalid++;
  else {hashTimes.push(hash.hashMs);if(hash.status==='ok')hashOk++;else hashFailed++;}
  const result=event.result;
  if(!result||typeof result!=='object'){invalid++;continue;}
  if(result.truncated===true)truncated++;
  if(result.supported===false)unsupported++;
  if(!Array.isArray(result.candidates)||result.candidates.length>64)throw Error('Invalid candidate count');
  candidates+=result.candidates.length;
 }
 const samples=values=>{if(!values.length)return {samples:0,p50Ms:null,p95Ms:null,maxMs:null};const sorted=values.slice().sort((a,b)=>a-b);
  return {samples:sorted.length,p50Ms:sorted[Math.floor((sorted.length-1)*.5)],p95Ms:sorted[Math.floor((sorted.length-1)*.95)],maxMs:sorted.at(-1)};};
 const pending=[...submitted.keys()].filter(id=>!results.has(id)),orphan=[...results.keys()].filter(id=>!submitted.has(id));
 const worker=p.frameObstructionProbe??null,retentionComplete=e.omitted===0,runComplete=v.completed===true;
 const actualSkips=Object.values(skips).reduce((sum,count)=>sum+count,0);
 const summaryComparable=worker&&number(worker.submitted)!==null&&number(worker.results)!==null&&number(worker.skipped)!==null;
 const summaryMatches=summaryComparable?worker.submitted===submitted.size&&worker.results===results.size&&worker.skipped===actualSkips:null;
 const traceComplete=report.execution?.complete===true&&report.execution?.dropped===0;
 const incomplete=!runComplete||!sourceStable||!traceComplete||!retentionComplete;
 return {version:1,status:incomplete?'partial':!e.attempted?'unmeasured':requested!==true||!worker||summaryMatches!==true||pending.length||orphan.length||idsWithDuplicates.length||errors.length||invalid||truncated||worker?.trackingOverflow===true||worker?.unexpectedResults>0||hashRequested===true&&(hashMissing||hashInvalid||hashFailed||hashRequestMissing||hashRequestMismatch||worker?.hashPending>0)?'partial':'observed-callbacks',
  requested,sourceStable,sourceDigest:sourceStable?hashes[0]:null,input:v.input??null,inputIntegrity:v.integrity??null,
  roiHash:{requested:hashRequested,ok:hashOk,failed:hashFailed,missing:hashMissing,invalid:hashInvalid,requestMissing:hashRequestMissing,requestMismatch:hashRequestMismatch,pending:worker?.hashPending??null,trackingOverflow:worker?.trackingOverflow??null,latency:samples(hashTimes),scope:'ROI content only; no source PTS or physical-source proof'},
  executionTrace:{complete:report.execution?.complete??null,dropped:report.execution?.dropped??null},
  retention:{attempted:e.attempted,recorded:e.recorded,omitted:e.omitted,retainedEveryDeliveredCallback:e.retainedEveryDeliveredCallback,summaryMatches},
  inputPipeline:{offered:number(p.inputPipeline?.offered),processed:number(p.inputPipeline?.processed),replaced:number(p.inputPipeline?.replaced),capacityDropped:number(p.inputPipeline?.capacityDropped)},
  callbacks:{submitted:submitted.size,results:results.size,skips,errors,pendingObserved:pending.length,orphanResults:orphan.length,duplicateIds:idsWithDuplicates,
    unsupported,invalid,truncated,candidates},latency:{readback:samples(readback),compute:samples(compute)},worker,
  scope:'Callback timing and sampled acquisition requests only. Replaced/skip counts are not all original frames; pending counts cover retained callbacks only. No decoded-frame identity, target PTS, original pixels, full coverage, OCR truth, or automatic-stop proof.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length!==3)throw Error('Usage: node scripts/analyze-frame-obstruction-probe.mjs <run.json>');
  const path=process.argv[2];if((await stat(path)).size>16*1024*1024)throw Error('Report too large');const bytes=await readFile(path);
  if(bytes.length>16*1024*1024)throw Error('Report too large');console.log(JSON.stringify({reportSha256:createHash('sha256').update(bytes).digest('hex'),...analyzeFrameObstructionProbe(JSON.parse(bytes))},null,2));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
