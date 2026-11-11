import {createHash} from 'node:crypto';
import {mkdir, open, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readCorpusBytes} from './scan-corpus-core.mjs';

// A diagnostic summary is not a replay. Keep it separate from full input cases.
const DEFAULT_ROOT='fixtures/local/corpus/diagnostic-fragments';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/;
function imageBytes(uri) {
  const match=typeof uri==='string'&&/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
  if(!match)throw Error('Invalid retained diagnostic image.');
  const bytes=Buffer.from(match[2],'base64');
  if(bytes.toString('base64')!==match[2])throw Error('Noncanonical image encoding.');
  if(match[1]==='png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
     match[1]==='jpeg'&&!(bytes[0]===0xff&&bytes[1]===0xd8&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9))
    throw Error('Image signature mismatch.');
  return {bytes,format:match[1]};
}
export function extractDiagnosticFragments(bytes) {
  const data=JSON.parse(bytes.toString('utf8'));
  if(!data||!Array.isArray(data.images)||!Array.isArray(data.unidentifiedObservations))throw Error('Invalid diagnostic summary.');
  const images=data.images.map((item,index)=>{
    const image=imageBytes(item.image),digest=sha(image.bytes);
    return {index,format:image.format,sha256:digest,bytes:image.bytes.length,
      source:typeof item.source==='string'?item.source:null,time:typeof item.time==='number'?item.time:null,
      content:image.bytes};
  });
  function reference(index) {
    if(index===undefined||index===null)return null;
    if(!Number.isSafeInteger(index)||index<0||index>=images.length)throw Error('Invalid diagnostic image reference.');
    const image=images[index];return {index,sha256:image.sha256,format:image.format};
  }
  const observations=data.unidentifiedObservations.map((item,index)=>({
    diagnosticIndex:index,group:item.group??null,time:item.time??null,captureOrder:item.captureOrder??null,
    source:item.source??null,location:item.location??null,reason:item.reason??null,
    recognitionImage:reference(item.recognitionImageIndex),previewImage:reference(item.retainedImageIndex),
  }));
  const manifest={version:1,kind:'diagnostic-fragments',id:sha(bytes),source:{sha256:sha(bytes),bytes:bytes.length,
    createdAt:data.createdAt??null,recordedBuild:null,recordedBuildReason:'not present in diagnostic summary',
    nameConfiguration:data.nameConfiguration??null,wholeInputAvailable:false},
    imageRetention:data.imageRetention??null,unidentifiedOmitted:data.unidentifiedOmitted??null,
    observations,images:images.map(image=>({index:image.index,format:image.format,sha256:image.sha256,
      bytes:image.bytes,source:image.source,time:image.time})),humanExpected:null,
    scope:'Retained card crops and diagnostic observations only; no source frame, scheduler, state replay, latency or human truth.'};
  return {manifest,images};
}
async function writeImmutable(path,bytes) {
  try {const file=await open(path,'wx');try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
  catch(error) {if(error.code!=='EEXIST')throw error;const old=await readFile(path);if(!old.equals(bytes))throw Error('Existing corpus object differs; no file overwritten.');}
}
export async function addDiagnosticFragments(input,root=DEFAULT_ROOT) {
  const bytes=await readCorpusBytes(input);const {manifest,images}=extractDiagnosticFragments(bytes);
  const folder=join(root,manifest.id);await mkdir(join(folder,'images'),{recursive:true});
  await writeImmutable(join(folder,'diagnostic.json'),bytes);
  for(const image of images)await writeImmutable(join(folder,'images',`${image.sha256}.${image.format}`),image.content);
  await writeImmutable(join(folder,'manifest.json'),Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
  return manifest;
}
export async function verifyDiagnosticFragments(id,root=DEFAULT_ROOT) {
  if(!hashPattern.test(id))throw Error('Invalid diagnostic ID.');
  const folder=join(root,id),source=await readCorpusBytes(join(folder,'diagnostic.json'));
  if(sha(source)!==id)throw Error('Diagnostic hash mismatch.');
  const {manifest,images}=extractDiagnosticFragments(source);
  const actual=await readCorpusBytes(join(folder,'manifest.json'));
  if(!actual.equals(Buffer.from(JSON.stringify(manifest,null,2)+'\n')))throw Error('Diagnostic manifest mismatch.');
  for(const image of images){const bytes=await readCorpusBytes(join(folder,'images',`${image.sha256}.${image.format}`));
    if(sha(bytes)!==image.sha256||!bytes.equals(image.content))throw Error('Diagnostic image mismatch.');}
  return {id,observations:manifest.observations.length,images:images.length,scope:manifest.scope};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [command,arg,root]=process.argv.slice(2);
  if(!arg||!['add','verify'].includes(command)||process.argv.length>5){console.error('Usage: node scripts/scan-diagnostic-fragments.mjs add <diagnostic.json> [root] | verify <sha256> [root]');process.exitCode=1;}
  else (command==='add'?addDiagnosticFragments(arg,root):verifyDiagnosticFragments(arg,root))
    .then(result=>console.log(JSON.stringify(result,null,2)))
    .catch(error=>{console.error(`Diagnostic fragments: ${error.code?`filesystem error (${error.code})`:error.message}`);process.exitCode=1;});
}
