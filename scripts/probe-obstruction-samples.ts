import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {alignCardBorders} from '../src/features/card-scanner/acquisition/card-borders';
import {blankNameLine} from '../src/features/card-scanner/recognition/name-visibility';
import {hasPanelOverlay,sidePanelCandidate} from '../src/features/card-scanner/acquisition/overlay-quality';
import {obstructionProbeEvidence} from './obstruction-probe-evidence';
import {emptySlotVector,isEmptySlotVector} from '../src/features/card-scanner/acquisition/empty-slot';
import {inspectCapture,preBorderEvidence} from '../src/features/card-scanner/acquisition/capture-quality';

const root='work/obstruction-samples',sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const video='fixtures/local/corpus/cases/93496e841f6b4f03d9c09ec45e7854eb59478285118223f0daa4b9fccfc6fce8/input/0001.mp4';
async function hashFile(path:string){const h=createHash('sha256');for await(const part of createReadStream(path))h.update(part);return h.digest('hex');}
const sourceFiles=[...['card-borders.ts','border-integrity.ts','name-visibility.ts','overlay-quality.ts','empty-slot.ts','capture-quality.ts']
 .map(name=>`src/features/card-scanner/${name}`),'scripts/obstruction-probe-evidence.ts','scripts/probe-obstruction-samples.ts'];
const codeHashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,sha(await readFile(path))] as const)));
function decode(png:Uint8Array,expected:number){if(!ffmpeg)throw Error('ffmpeg unavailable');const out=spawnSync(ffmpeg,
 ['-v','error','-f','image2pipe','-vcodec','png','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],
 {input:png,maxBuffer:32*1024*1024,windowsHide:true});if(out.error||out.status!==0||out.stdout.length!==expected)throw Error('PNG decode failed');return out.stdout;}
function cut(frame:Uint8Array,width:number,box:{x:number;y:number;width:number;height:number}){const pixels=new Uint8Array(box.width*box.height*4);
 for(let y=0;y<box.height;y++)pixels.set(frame.subarray(((box.y+y)*width+box.x)*4,((box.y+y)*width+box.x+box.width)*4),y*box.width*4);return pixels;}
async function main(){
 const name=process.argv[2];if(!name||!/^[a-f0-9]{64}\.json$/.test(name))throw Error('Supply content-addressed manifest name');
 const data=await readFile(join(root,name));if(sha(data)!==name.slice(0,64))throw Error('Manifest hash mismatch');
 const manifest=JSON.parse(data.toString('utf8'));
 if(manifest.kind!=='private-obstruction-samples'||manifest.version!==1||manifest.source?.caseId!=='93496e841f6b4f03d9c09ec45e7854eb59478285118223f0daa4b9fccfc6fce8'||
  manifest.source.frameWidth!==2560||manifest.source.frameHeight!==1440||!Array.isArray(manifest.samples)||manifest.samples.length>100)throw Error('Invalid sample manifest');
 const inputHash=await hashFile(video);if(inputHash!==manifest.source.sha256)throw Error('Original video hash mismatch');
 const timing=spawnSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',video],{windowsHide:true,maxBuffer:4*1024*1024});
 if(timing.status!==0)throw Error('Original video timestamps unavailable');const pts=JSON.parse(timing.stdout.toString()).frames as {best_effort_timestamp_time?:string}[];
 const before=await codeHashes(),rows=[];
 let lastFrame=-1,verifiedFrame:Buffer|undefined;
 for(const sample of manifest.samples){
  if(!Number.isSafeInteger(sample.frameOrdinal)||sample.frameOrdinal<0||!Number.isFinite(sample.framePtsSeconds)||
    Number(pts[sample.frameOrdinal]?.best_effort_timestamp_time)!==sample.framePtsSeconds)throw Error('Original frame timestamp mismatch');
  const box=sample.box;if(!box||![box.x,box.y,box.width,box.height].every(Number.isSafeInteger)||box.width!==140||box.height!==210||
   box.x<0||box.y<0||box.x+box.width>2560||box.y+box.height>1440)throw Error('Invalid crop coordinates');
  for(const ref of [sample.fullFrame,sample.crop])if(!ref||typeof ref.name!=='string'||!/^[a-f0-9]{64}\.png$/.test(ref.name)||ref.sha256!==ref.name.slice(0,64))throw Error('Invalid image reference');
  const [framePng,cropPng]=await Promise.all([readFile(join(root,sample.fullFrame.name)),readFile(join(root,sample.crop.name))]);
  if(framePng.length!==sample.fullFrame.bytes||cropPng.length!==sample.crop.bytes||sha(framePng)!==sample.fullFrame.sha256||sha(cropPng)!==sample.crop.sha256)throw Error('Image hash mismatch');
  const frame=decode(framePng,2560*1440*4),pixels=decode(cropPng,140*210*4),expected=cut(frame,2560,box);
  if(sample.frameOrdinal!==lastFrame){if(!ffmpeg)throw Error('ffmpeg unavailable');const original=spawnSync(ffmpeg,
   ['-v','error','-i',video,'-vf',`select=eq(n\\,${sample.frameOrdinal})`,'-fps_mode','passthrough','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],
   {maxBuffer:32*1024*1024,windowsHide:true});if(original.status!==0||original.stdout.length!==2560*1440*4)throw Error('Original frame decode failed');
   verifiedFrame=original.stdout;lastFrame=sample.frameOrdinal;}
  if(!verifiedFrame?.equals(frame))throw Error('Full-frame pixels differ from original video');
  if(!pixels.equals(Buffer.from(expected)))throw Error('Crop does not match source frame pixels');
  const alignment=alignCardBorders(frame,2560,1440,box),experimental=obstructionProbeEvidence(frame,2560,1440,box,pixels,alignment.borderSides);
  const ifLabel=(label:boolean)=>{const quality=inspectCapture(pixels,140,210,true,label,alignment.intact,alignment.alignment>=.8);
   return {...quality,preBorder:preBorderEvidence(quality)};};
  rows.push({frameOrdinal:sample.frameOrdinal,framePtsSeconds:sample.framePtsSeconds,slot:sample.slot,box,cropSha256:sample.crop.sha256,
   humanVerified:false,visualReview:sample.visualReview,
   programEstimate:{nameBlank:blankNameLine(pixels,140,210),panelRule:hasPanelOverlay(pixels,140,210),
    emptyVector:isEmptySlotVector(emptySlotVector(pixels,140,210)),borderIntact:alignment.intact,borderMinimum:alignment.alignment,borderSides:alignment.borderSides,
    lowerPanelCandidate:experimental.lower,lowerPanelCrossing:experimental.edges,
    sidePanelCandidate:sidePanelCandidate(pixels,140,210,alignment.borderSides),
    ifLabelAbsent:ifLabel(false),ifLabelPresent:ifLabel(true),labelVisible:'not-measured',
    scope:'Fixed manually measured nominal crop, no canvas label test or original acquisition replay. Lower and side panels are experimental candidates, not ground truth or evidence of absence.'}});
 }
 const after=await codeHashes();if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Source changed during probe');
 if(await hashFile(video)!==inputHash)throw Error('Original video changed during probe');
 const report={version:1,kind:'private-obstruction-quality-probe',manifest:name,manifestSha256:sha(data),source:manifest.source,codeHashes:before,
  scope:'Purposive frames and manual boxes only; original frame PTS and RGBA re-decoded and compared; not prevalence, recall, actual captured-frame coverage or independently confirmed human labels.',rows};
 const output=Buffer.from(JSON.stringify(report,null,2)),file=`${sha(output)}.probe.json`;
 try{await writeFile(join(root,file),output,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  if(sha(await readFile(join(root,file)))!==sha(output))throw Error('Existing probe differs');}
 console.log(JSON.stringify({file,sha256:sha(output),rows:rows.length},null,2));
}
main().catch(error=>{console.error(String(error));process.exitCode=1;});
