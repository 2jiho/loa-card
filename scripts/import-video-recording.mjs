// Dev only: turns a video or a set of screenshots a person made into a recording the current
// scanner can replay like a screen share (docs/dev-recording.md). The inputs are left untouched.
// Usage: node --import tsx scripts/import-video-recording.mjs <corpus case id | video file> [new-id]
// A corpus case may be a video or screenshots; screenshots are held still 1 s each, in order.
import {createHash} from 'node:crypto';
import {existsSync,readdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {DEFAULT_RECORDING_ROOT,importImagesRecording,importVideoRecording} from '../dev/recording-store.ts';

const CORPUS_CASES='fixtures/local/corpus/cases';
const [target,newIdArgument]=process.argv.slice(2);
if(!target){console.error('Usage: node --import tsx scripts/import-video-recording.mjs <corpus case id | video file> [new-id]');process.exit(2);}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const caseDir=/^[a-f0-9]{8,64}$/.test(target)&&existsSync(CORPUS_CASES)?readdirSync(CORPUS_CASES).find(id=>id.startsWith(target)):undefined;
const started=Date.now();
let meta;
if(caseDir){
  const manifest=JSON.parse(await readFile(join(CORPUS_CASES,caseDir,'manifest.json'),'utf8'));
  const newId=newIdArgument??`corpus-${manifest.name}`;
  const inputs=[...manifest.inputs].sort((a,b)=>a.index-b.index);
  if(manifest.kind==='video'&&inputs.length===1){
    const input=inputs[0];
    meta=await importVideoRecording(DEFAULT_RECORDING_ROOT,join(CORPUS_CASES,caseDir,input.path),newId,
      {kind:'video',sha256:input.sha256,name:input.name,corpusCase:caseDir});
  }else if(manifest.kind==='images'){
    // The images' identity is their hashes in order.
    meta=await importImagesRecording(DEFAULT_RECORDING_ROOT,inputs.map(input=>join(CORPUS_CASES,caseDir,input.path)),newId,
      {kind:'images',sha256:sha(inputs.map(input=>input.sha256).join('\n')),name:manifest.name,corpusCase:caseDir});
  }else throw Error(`corpus case ${caseDir.slice(0,12)} is a ${manifest.kind} case; only video and images cases can be imported`);
}else{
  if(!existsSync(target))throw Error('No such corpus case or file.');
  const sha256=sha(await readFile(target));
  meta=await importVideoRecording(DEFAULT_RECORDING_ROOT,target,newIdArgument??`video-${sha256.slice(0,8)}`,{kind:'video',sha256,name:basename(target)});
}
console.log(JSON.stringify({id:meta.id,frames:meta.frames,width:meta.width,height:meta.height,sha256:meta.sha256,seconds:(Date.now()-started)/1000},null,1));
