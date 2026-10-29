import {createHash,randomUUID} from 'node:crypto';
import {link,lstat,mkdir,open,readdir,unlink} from 'node:fs/promises';
import {join,parse,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DEFAULT_CORPUS_ROOT,MAX_CORPUS_RUN_BYTES,readCorpusBytes,readCorpusCase,verifyCorpus} from './scan-corpus-core.mjs';
import {parseScanResult} from './scan-case-results.mjs';

export const MAX_HUMAN_LABEL_BYTES=256*1024,MAX_HUMAN_ASSET_BYTES=1024*1024;
const HASH=/^[a-f0-9]{64}$/,FIELDS=['name','awakening','extraCopies'];
const fail=message=>{throw new Error(message);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const encoded=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);
function object(v,required,optional=[]){
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v))||
  required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))fail('Invalid human-label object keys.');
 return v;
}
function text(v,max=200){if(typeof v!=='string'||!v.length||v!==v.trim()||v.length>max||/[\0\r\n]/.test(v))fail('Invalid human-label text.');return v;}
function hash(v){if(typeof v!=='string'||!HASH.test(v))fail('Invalid human-label SHA-256.');return v;}
function integer(v,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(v)||v<min||v>max)fail('Invalid human-label integer.');return v;}
function time(v){if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail('Invalid capture time.');return v;}
function iso(v){if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('Invalid label record time.');return v;}
function input(v,index){object(v,['index','sha256','bytes']);if(v.index!==index)fail('Invalid ordered input index.');return{index,sha256:hash(v.sha256),bytes:integer(v.bytes)};}
function confirmation(v){
 object(v,['authority','recordedAt','question','answer','wording','capturedAt']);
 if(v.authority!=='human-user'||!['normalized','verbatim'].includes(v.wording))fail('Human confirmation is required.');
 return{authority:'human-user',recordedAt:iso(v.recordedAt),question:text(v.question,2000),answer:text(v.answer,2000),
  wording:v.wording,capturedAt:v.capturedAt===null?null:iso(v.capturedAt)};
}
function anchor(v){
 object(v,['caseId','input','sourceFrameId','acquisitionFrameId','observationId','phase','slot','captureOrder','captureTime','clock','box','fullRgbaSha256','cropRgbaSha256','png']);
 if(v.clock!=='browser-capture'||!['input','recovery'].includes(v.phase))fail('Unsupported anchor clock or phase.');
 object(v.box,['x','y','width','height']);object(v.png,['sha256','bytes']);
 const limit=64*1024*1024/4,box={x:integer(v.box.x,0,limit-1),y:integer(v.box.y,0,limit-1),width:integer(v.box.width,1,limit),height:integer(v.box.height,1,limit)};
 if(box.width*box.height>limit||box.x+box.width>limit||box.y+box.height>limit)fail('Anchor crop size exceeds its bound.');
 return{caseId:hash(v.caseId),input:input(v.input,integer(v.input?.index)),sourceFrameId:integer(v.sourceFrameId,1),
  acquisitionFrameId:integer(v.acquisitionFrameId,1),observationId:text(v.observationId),phase:v.phase,slot:integer(v.slot,0,39),
  captureOrder:integer(v.captureOrder),captureTime:time(v.captureTime),clock:'browser-capture',box,
  fullRgbaSha256:hash(v.fullRgbaSha256),cropRgbaSha256:hash(v.cropRgbaSha256),png:{sha256:hash(v.png.sha256),bytes:integer(v.png.bytes,1,MAX_HUMAN_ASSET_BYTES)}};
}
/** An operator assertion, not a cryptographic proof that a human was correct.
 * Missing, explicitly unknown, and known zero remain separate states. */
export function parseHumanExpected(value){
 const v=object(value,['kind','version','status','scope','caseId','inputs','confirmation','cards'],['anchor','migration']);
 if(v.kind!=='loacard-human-label'||v.version!==1||v.status!=='human-confirmed'||v.scope!=='partial')fail('Unsupported human-label format.');
 if(!Array.isArray(v.inputs)||!v.inputs.length||v.inputs.length>1000||!Array.isArray(v.cards)||!v.cards.length||v.cards.length>1000)fail('Human-label cardinality exceeds its bound.');
 const inputs=Array.from(v.inputs,(v,i)=>input(v,i)),ids=new Set(),cards=Array.from(v.cards,c=>{
  object(c,['id','fields']);const id=text(c.id);if(ids.has(id))fail('Duplicate human-label card ID.');ids.add(id);
  object(c.fields,[],FIELDS);if(!Object.keys(c.fields).length)fail('A card needs at least one explicit field.');const fields={};
  for(const key of FIELDS)if(Object.hasOwn(c.fields,key)){
   const f=c.fields[key];object(f,['status'],['value']);
   if(f.status==='unknown'){if(Object.hasOwn(f,'value'))fail('Unknown is not a labelled value.');fields[key]={status:'unknown'};}
   else if(f.status==='known'){if(!Object.hasOwn(f,'value'))fail('Known field value is missing.');fields[key]={status:'known',value:key==='name'?text(f.value):integer(f.value,0,key==='awakening'?5:15)};}
   else fail('Invalid field status.');
  }
  const a=fields.awakening,e=fields.extraCopies;
  if(a?.status==='known'&&e?.status==='known'&&e.value>15-a.value*(a.value+1)/2)fail('Impossible labelled awakening/count pair.');
  return{id,fields};
 }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const parsed={kind:'loacard-human-label',version:1,status:'human-confirmed',scope:'partial',caseId:hash(v.caseId),inputs,confirmation:confirmation(v.confirmation),cards};
 if(Object.hasOwn(v,'anchor'))parsed.anchor=anchor(v.anchor);
 if(Object.hasOwn(v,'migration')){object(v.migration,['format','sourceSha256']);if(v.migration.format!=='private-flat-v1')fail('Unknown migration format.');parsed.migration={format:'private-flat-v1',sourceSha256:hash(v.migration.sourceSha256)};}
 return parsed;
}
function decode(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('Expected bounded UTF-8 JSON.');}}
async function readJson(file,max=MAX_HUMAN_LABEL_BYTES){return decode(await readCorpusBytes(file,max));}
function ordered(manifest){return manifest.inputs.map(({index,sha256,bytes})=>({index,sha256,bytes}));}
function equalInputs(actual,expected){if(JSON.stringify(actual)!==JSON.stringify(expected))fail('Case ordered input hash/size mismatch.');}
async function bind(label,root){
 const manifest=await readCorpusCase({root,id:label.caseId});equalInputs(label.inputs,ordered(manifest));
 if(label.anchor){const m=await readCorpusCase({root,id:label.anchor.caseId}),i=m.inputs[label.anchor.input.index];
  if(!i)fail('Anchor input does not exist.');equalInputs([label.anchor.input],[{index:i.index,sha256:i.sha256,bytes:i.bytes}]);}
 return manifest;
}
/** Explicit conversion only. Old sidecar paths are never followed automatically. */
export function migratePrivateHumanExpected(v,manifest,sourceSha256){
 object(v,['kind','version','status','scope','registeredAt','caseId','inputSha256','inputBytes','assertedFields','unassertedFields','cards','provenance','evidence','role','boundaries']);
 if(v.kind!=='loacard-human-expected'||v.version!==1||v.status!=='human-confirmed'||v.scope!=='partial'||v.caseId!==manifest.id||manifest.inputs.length!==1)fail('Unsupported explicit private migration.');
 if(v.inputSha256!==manifest.inputs[0].sha256||v.inputBytes!==manifest.inputs[0].bytes)fail('Private input binding mismatch.');
 if(!Array.isArray(v.assertedFields)||new Set(v.assertedFields).size!==v.assertedFields.length||v.assertedFields.some(k=>!['id',...FIELDS].includes(k))||!v.assertedFields.includes('id'))fail('Invalid private asserted-field mask.');
 object(v.provenance,['authority','status','source','questionContext','normalizedAnswer','recordedAt','answeredAt','capturedAt','timeMeaning','programBaselinePromoted','independentHumanConfirmations']);
 if(v.provenance.authority!=='human-user'||v.provenance.status!=='human-confirmed'||v.provenance.programBaselinePromoted!==false||v.provenance.independentHumanConfirmations!==1)fail('Private program output is not a human label.');
 if(!Array.isArray(v.cards)||!v.cards.length)fail('Private cards missing.');
 const migrated={kind:'loacard-human-label',version:1,status:'human-confirmed',scope:'partial',caseId:manifest.id,inputs:ordered(manifest),
  confirmation:{authority:'human-user',recordedAt:v.provenance.recordedAt,question:v.provenance.questionContext,answer:v.provenance.normalizedAnswer,wording:'normalized',capturedAt:v.provenance.capturedAt},
  cards:v.cards.map(c=>{object(c,['id','name','awakening','extraCopies']);const fields={};for(const key of FIELDS)if(v.assertedFields.includes(key))fields[key]=c[key]===null?{status:'unknown'}:{status:'known',value:c[key]};return{id:c.id,fields};}),
  migration:{format:'private-flat-v1',sourceSha256:hash(sourceSha256)}};
 object(v.evidence,['original','replay','duplicatePolicy']);const r=v.evidence.replay;
 object(r,['caseId','input','producerSource','sourceFrameId','acquisitionFrameId','observationId','phase','slot','captureOrder','captureTime','captureClock','box','fullRgbaSha256','cropRgbaSha256','cropPng','exactPixelJoinEvidence']);
 if(r.captureClock!=='browser capture clock, not original-video PTS')fail('Private capture clock is unsupported.');
 migrated.anchor={caseId:r.caseId,input:{index:r.input.index,sha256:r.input.sha256,bytes:r.input.bytes},sourceFrameId:r.sourceFrameId,acquisitionFrameId:r.acquisitionFrameId,
  observationId:r.observationId,phase:r.phase,slot:r.slot,captureOrder:r.captureOrder,captureTime:r.captureTime,clock:'browser-capture',box:r.box,
  fullRgbaSha256:r.fullRgbaSha256,cropRgbaSha256:r.cropRgbaSha256,png:{sha256:r.cropPng.sha256,bytes:r.cropPng.bytes}};
 return parseHumanExpected(migrated);
}
async function safeDirectory(path,create=false){
 const absolute=resolve(path);let current=parse(absolute).root;
 for(const part of relative(current,absolute).split(sep).filter(Boolean)){
  current=join(current,part);let s;try{s=await lstat(current);}catch(e){if(e.code!=='ENOENT'||!create)throw e;try{await mkdir(current);}catch(e){if(e.code!=='EEXIST')throw e;}s=await lstat(current);}
  if(s.isSymbolicLink()||!s.isDirectory())fail('Human-label directory cannot follow symlinks/junctions.');
 }return absolute;
}
function registry(root){return join(resolve(root),'human-labels');}
async function immutable(directory,filename,bytes){
 await safeDirectory(directory,true);const staging=join(directory,'..','.tmp');await safeDirectory(staging,true);
 const target=join(directory,filename),temporary=join(staging,`.human-${randomUUID()}.tmp`);let created=false,owned=false,handle,failure;
 try{
  handle=await open(temporary,'wx');owned=true;await handle.writeFile(bytes);await handle.sync();await handle.close();handle=undefined;
  try{await link(temporary,target);created=true;}catch(e){if(e.code!=='EEXIST')throw e;const existing=await readCorpusBytes(target,Math.max(MAX_HUMAN_LABEL_BYTES,MAX_HUMAN_ASSET_BYTES));if(!existing.equals(bytes))fail('Immutable human-label object conflict.');}
 }catch(e){failure=e;}finally{
  if(handle)try{await handle.close();}catch(e){failure??=e;}
  if(owned)try{await unlink(temporary);}catch(e){failure??=e;}
 }
 if(failure)throw failure;
 return{created,file:target,sha256:sha(bytes),bytes:bytes.length};
}
function confirmationBytes(label){return encoded({kind:'loacard-human-confirmation',version:1,...label.confirmation});}
function labelFile(root,id){return join(registry(root),'labels',`${hash(id)}.json`);}
async function storedLabel(root,id){const file=labelFile(root,id),bytes=await readCorpusBytes(file,MAX_HUMAN_LABEL_BYTES);if(sha(bytes)!==id)fail('Stored human-label checksum mismatch.');return{file,bytes,label:parseHumanExpected(decode(bytes))};}
function checkPng(bytes,label){
 if(bytes.length!==label.anchor.png.bytes||sha(bytes)!==label.anchor.png.sha256||bytes.length<33||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||
  bytes.readUInt32BE(16)!==label.anchor.box.width||bytes.readUInt32BE(20)!==label.anchor.box.height)fail('Anchor PNG hash/size/dimensions mismatch.');
}
export async function importHumanExpected(caseId,file,{root=DEFAULT_CORPUS_ROOT,operatorConfirmed=false,migratePrivateV1=false,asset}={}){
 if(operatorConfirmed!==true)fail('Explicit --operator-confirmed assertion is required.');
 const bytes=await readCorpusBytes(file,MAX_HUMAN_LABEL_BYTES),value=decode(bytes),manifest=await readCorpusCase({root,id:hash(caseId)}),
  label=migratePrivateV1?migratePrivateHumanExpected(value,manifest,sha(bytes)):parseHumanExpected(value);
 if(label.caseId!==caseId)fail('Human label belongs to another case.');await bind(label,root);
 const canonical=encoded(label);if(canonical.length>MAX_HUMAN_LABEL_BYTES)fail('Canonical human label exceeds its bound.');
 let assetBytes;if(label.anchor){
  assetBytes=await readCorpusBytes(asset??join(registry(root),'assets',`${label.anchor.png.sha256}.png`),MAX_HUMAN_ASSET_BYTES);checkPng(assetBytes,label);
 }else if(asset!==undefined)fail('Unexpected asset without an anchor.');
 // Existing input verification is streaming and includes object-store identity.
 const verified=await verifyCorpus({root,id:caseId});if(label.anchor&&label.anchor.caseId!==caseId)await verifyCorpus({root,id:label.anchor.caseId});
 if(assetBytes)await immutable(join(registry(root),'assets'),`${label.anchor.png.sha256}.png`,assetBytes);
 const confirmation=await immutable(join(registry(root),'confirmations'),`${sha(confirmationBytes(label))}.json`,confirmationBytes(label)),
  record=await immutable(join(registry(root),'labels'),`${sha(canonical)}.json`,canonical);
 return{...record,caseId,confirmationSha256:confirmation.sha256,scope:'partial',cards:label.cards.length,inputVerification:verified,
  interpretation:'Explicit operator human assertion; hashes verify storage/bindings, not cryptographic human truth.'};
}
export async function listHumanExpected({root=DEFAULT_CORPUS_ROOT,caseId}={}){
 if(caseId!==undefined)await readCorpusCase({root,id:hash(caseId)});
 const directory=join(registry(root),'labels');try{await safeDirectory(directory);}catch(e){if(e.code==='ENOENT')return{labels:[],confirmations:0};throw e;}
 const files=await readdir(directory,{withFileTypes:true});if(files.length>10_000)fail('Human-label registry exceeds its bound.');const labels=[];
 for(const f of files.sort((a,b)=>a.name.localeCompare(b.name))){
  if(!/^[a-f0-9]{64}\.json$/.test(f.name)||!f.isFile())fail('Unexpected human-label registry entry.');
  const id=f.name.slice(0,-5),{label}=await storedLabel(root,id);await bind(label,root);
  if(caseId===undefined||label.caseId===caseId)labels.push({sha256:id,caseId:label.caseId,scope:label.scope,cards:label.cards.length,confirmationSha256:sha(confirmationBytes(label))});
 }
 return{labels,confirmations:new Set(labels.map(l=>l.confirmationSha256)).size};
}
export async function verifyHumanExpected(id,{root=DEFAULT_CORPUS_ROOT}={}){
 const{label}=await storedLabel(root,hash(id));await bind(label,root);const inputVerification=await verifyCorpus({root,id:label.caseId}),
  confirmationSha256=sha(confirmationBytes(label)),confirmed=await readCorpusBytes(join(registry(root),'confirmations',`${confirmationSha256}.json`),MAX_HUMAN_LABEL_BYTES);
 if(!confirmed.equals(confirmationBytes(label)))fail('Human confirmation storage mismatch.');
 if(label.anchor){if(label.anchor.caseId!==label.caseId)await verifyCorpus({root,id:label.anchor.caseId});checkPng(await readCorpusBytes(join(registry(root),'assets',`${label.anchor.png.sha256}.png`),MAX_HUMAN_ASSET_BYTES),label);}
 return{verified:true,labelSha256:id,caseId:label.caseId,confirmationSha256,inputVerification,anchorAssetVerified:!!label.anchor,
  anchorPixelProof:'not-restored-by-this-command',humanTruth:'operator-asserted',scope:'partial'};
}
async function latestInventory(report){
 const unsupported=reason=>({supported:false,reason});
 if(report.executionExpected&&Object.hasOwn(report.executionExpected,'inventoryHash')&&!HASH.test(report.executionExpected.inventoryHash??''))fail('Invalid captured inventory hash.');
 if(!report.execution||!HASH.test(report.executionExpected?.inventoryHash??''))return unsupported('No captured inventory checkpoint hash.');
 const start=report.validation?.sourceStart?.sourceDigest,end=report.validation?.sourceEnd?.sourceDigest;
 if(!HASH.test(start??'')||start!==end||report.validation.sourceChanged===true)return unsupported('Producer source is not stable/verified.');
 // Optional TypeScript capability: old plain-Node corpus commands never load this.
 let traceApi,evidenceApi,replayApi,proofApi;
 try{[traceApi,evidenceApi,replayApi,proofApi]=await Promise.all([import('../dev/run-state-trace.ts'),import('../src/features/card-scanner/inventory-evidence.ts'),
  import('../src/features/card-scanner/inventory-evidence-replay.ts'),import('../src/features/card-scanner/recovery-completion.ts')]);}
 catch(e){if(['ERR_UNKNOWN_FILE_EXTENSION','ERR_MODULE_NOT_FOUND','ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'].includes(e.code))return unsupported('Inventory replay requires the documented TypeScript runtime.');throw e;}
 const signal=AbortSignal.timeout(120_000),trace=await traceApi.parseRunStateTrace(new Blob([JSON.stringify(report.execution)]),signal);
 if(trace.version!==2||trace.complete!==true||trace.dropped!==0)return unsupported('A complete v2 execution trace is required.');
 const replay=new replayApi.InventoryEvidenceReplay(signal);let seed;const events=[];
 for(const e of trace.events){if(e.type==='inventory-seed'){replay.seed(e.value);seed=e.value;}
  else if(e.type==='inventory-event'){replay.accept(e.value);events.push(e.value);}else if(e.type==='inventory-checkpoint')replay.checkpoint(e.value);}
 const summary=await replay.summary();if(!summary.supported||summary.matchesCapturedState!==true||summary.hash!==report.executionExpected.inventoryHash)return unsupported('Inventory checkpoint is absent, stale or mismatched.');
 const inventory=evidenceApi.replayInventoryEvidence(seed.cards,events);
 if(await evidenceApi.hashInventoryEvidence(inventory.snapshot())!==summary.hash)fail('Inventory reconstruction hash mismatch.');
 return{supported:true,inventory,summary,confirmedReadingCount:proofApi.confirmedReadingCount};
}
export async function compareHumanExpected(id,reportFile,{root=DEFAULT_CORPUS_ROOT,valuesOnly=false}={}){
 const{label}=await storedLabel(root,hash(id));await bind(label,root);const report=await readJson(reportFile,MAX_CORPUS_RUN_BYTES),actual=parseScanResult(report);
 if(report.validation?.caseId!==label.caseId||!Array.isArray(report.validation.input))fail('Actual report belongs to another case.');
 equalInputs(report.validation.input.map(v=>({index:v.index,sha256:hash(v.sha256),bytes:integer(v.bytes)})),label.inputs);
 const rows=new Map(actual.cards.map(c=>[c.id,c])),latest=valuesOnly?{supported:false,reason:'Explicit values-only comparison.'}:await latestInventory(report),cards=[];
 let checked=0,valueMatches=true,allResolved=latest.supported;
 for(const expected of label.cards){
  const row=rows.get(expected.id),fields={};for(const key of FIELDS)if(Object.hasOwn(expected.fields,key)){
   const f=expected.fields[key];if(f.status==='unknown'){fields[key]={status:'unasserted-unknown'};continue;}
   checked++;const match=!!row&&row[key]===f.value;valueMatches&&=match;fields[key]={expected:f.value,actual:row?.[key]??null,valueMatches:match};
  }
  let proof={status:'unsupported',reason:latest.reason};
  if(latest.supported){
   const inv=latest.inventory,raw=inv.latestFieldObservations.get(expected.id)?.card,order=inv.latestIdentityOrder.get(expected.id),
    atLatest=!!raw&&raw.captureOrder===order,
    jointFieldsConfirmed=atLatest&&latest.confirmedReadingCount({cards:[raw],latest:inv.latestIdentityOrder,confirmed:inv.confirmedFieldOrder})===1,
    named=order!==undefined&&(inv.confirmedNameOrder.get(expected.id)??-Infinity)>=order,
    nameKnown=expected.fields.name?.status==='known',numericKnown=['awakening','extraCopies'].some(k=>expected.fields[k]?.status==='known'),
    tupleMatches=!!row&&!!raw&&(!nameKnown||row.name===raw.name)&&(!numericKnown||row.awakening===raw.awakening&&row.extraCopies===raw.extraCopies),
    knownMatches=!!raw&&FIELDS.every(k=>expected.fields[k]?.status!=='known'||raw[k]===expected.fields[k].value),
    fresh=atLatest&&(!numericKnown||jointFieldsConfirmed),resolved=fresh&&named&&tupleMatches&&knownMatches;
   const asserted=nameKnown||numericKnown;
   if(asserted)allResolved&&=resolved;proof={status:!asserted?'unasserted':resolved?'resolved':'unresolved',latestOrder:order??null,confirmedOrder:inv.confirmedFieldOrder.get(expected.id)??null,
    raw:raw?{name:raw.name,awakening:raw.awakening,extraCopies:raw.extraCopies,captureOrder:raw.captureOrder,time:raw.time,countReliable:raw.countReliable,review:raw.review,identitySource:raw.identitySource}:null,
    jointFieldContract:numericKnown,jointFieldsConfirmed,atLatest,fresh,named,tupleMatches,knownMatches};
  }
  cards.push({id:expected.id,fields,actualReview:row?.review??null,latestEvidence:proof});
 }
 const fieldProofPassed=checked===0||!latest.supported?null:valueMatches&&allResolved,
  verdict=!valueMatches?'value-mismatch':checked===0?'no-known-fields':fieldProofPassed===true?'scoped-fresh-field-match':latest.supported?'latest-evidence-unresolved':'latest-evidence-unsupported',
  exitCode=!valueMatches?2:fieldProofPassed===true?0:3;
 return{scope:'partial-human-fields',labelSha256:id,caseId:label.caseId,checkedFields:checked,headersChecked:false,otherCardsChecked:false,reviewLabelled:false,
  valueMatches,latestEvidenceSupported:latest.supported,latestEvidenceUnresolved:latest.supported?!allResolved:null,fieldProofPassed,verdict,cards,exitCode,
  interpretation:'Recorded-state evidence comparison, not pixel/OCR accuracy, whole-inventory coverage or cryptographic human truth.'};
}

const USAGE=`Usage: scan-human-expected <import|list|verify|compare> ...
 import <case-id> <label.json> --operator-confirmed [--migrate-private-v1] [--asset crop.png] [--root path]
 list [case-id] [--root path]
 verify <label-sha256> [--root path]
 compare <label-sha256> <actual-report.json> [--values-only] [--root path]
Known zero differs from missing/unknown. Import is an explicit operator human assertion.
Compare exits: 0 scoped fresh proof; 2 value mismatch; 3 unresolved/unsupported; 1 invalid input.
Latest proof requires Node 22 with --import tsx. Values-only never claims fresh proof.`;
export async function runHumanExpectedCli(args,write=text=>process.stdout.write(`${text}\n`)){
 if(!args.length||['--help','help'].includes(args[0])){write(USAGE);return 0;}const[command,...rest]=args;
 if(!['import','list','verify','compare'].includes(command))fail('Unknown human-expected command.');
 const options={},files=[],allowed={import:['root','asset','operator-confirmed','migrate-private-v1'],list:['root'],verify:['root'],compare:['root','values-only']}[command];
 for(let i=0;i<rest.length;i++){const arg=rest[i];if(!arg.startsWith('--')){files.push(arg);continue;}const key=arg.slice(2);
  if(!allowed.includes(key)||Object.hasOwn(options,key))fail('Unknown or repeated human-expected option.');
  if(['operator-confirmed','migrate-private-v1','values-only'].includes(key))options[key]=true;
  else{if(!rest[i+1]||rest[i+1].startsWith('--'))fail('Missing option value.');options[key]=rest[++i];}}
 const opts={root:options.root,...(options.asset?{asset:options.asset}:{}),operatorConfirmed:options['operator-confirmed'],migratePrivateV1:options['migrate-private-v1'],valuesOnly:options['values-only']};
 let result;if(command==='import'){if(files.length!==2)fail('import requires a case ID and label file.');result=await importHumanExpected(files[0],files[1],opts);}
 else if(command==='list'){if(files.length>1)fail('list accepts at most one case ID.');result=await listHumanExpected({...opts,caseId:files[0]});}
 else if(command==='verify'){if(files.length!==1)fail('verify requires a registered label SHA.');result=await verifyHumanExpected(files[0],opts);}
 else{if(files.length!==2)fail('compare requires a registered label SHA and actual report.');result=await compareHumanExpected(files[0],files[1],opts);}
 write(JSON.stringify(result,null,2));return result.exitCode??0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runHumanExpectedCli(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(e=>{process.stderr.write(`Human expected: ${e.code?`filesystem/runtime error (${e.code})`:e.message}\n`);process.exitCode=1;});
}
