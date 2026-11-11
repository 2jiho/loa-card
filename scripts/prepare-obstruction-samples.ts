import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import ffmpeg from 'ffmpeg-static';

const caseId='93496e841f6b4f03d9c09ec45e7854eb59478285118223f0daa4b9fccfc6fce8';
const source=`fixtures/local/corpus/cases/${caseId}/input/0001.mp4`,root='work/obstruction-samples';
const selected=[
 {frame:30,row:0,column:0,review:'clear-card'},
 {frame:88,row:0,column:0,review:'scroll-pair-before'},
 {frame:90,row:0,column:0,review:'scroll-pair-after'},
 {frame:120,row:0,column:0,review:'clear-card'},
 {frame:120,row:1,column:4,review:'cursor-on-card'},
 {frame:120,row:1,column:5,review:'tooltip-covered'},
 {frame:120,row:1,column:6,review:'tooltip-covered'},
 {frame:120,row:2,column:5,review:'tooltip-covered'},
 {frame:150,row:0,column:0,review:'empty-back'},
] as const;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function hashFile(path:string){const h=createHash('sha256');for await(const part of createReadStream(path))h.update(part);return h.digest('hex');}
function command(bin:string,args:string[],input?:Uint8Array,limit=32*1024*1024){const out=spawnSync(bin,args,{input,maxBuffer:limit,windowsHide:true});
 if(out.error||out.status!==0)throw Error(`${bin} failed: ${out.error??out.stderr.toString().slice(0,400)}`);return out.stdout;}
async function store(bytes:Uint8Array,extension:string){const digest=sha(bytes),name=`${digest}.${extension}`,path=join(root,name);
 try{await writeFile(path,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  if(sha(await readFile(path))!==digest)throw Error('Existing sample differs');}return {name,sha256:digest,bytes:bytes.length};}
async function main(){
 if(!ffmpeg)throw Error('ffmpeg unavailable');const sourceSha256=await hashFile(source);
 const corpus=JSON.parse(await readFile(`fixtures/local/corpus/cases/${caseId}/manifest.json`,'utf8'));
 if(corpus.inputs?.[0]?.sha256!==sourceSha256)throw Error('Corpus source hash mismatch');
 const probed=JSON.parse(command('ffprobe',['-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',source]).toString());
 const pts=probed.frames as {best_effort_timestamp_time?:string}[];await mkdir(root,{recursive:true});
 const images=new Map<number,Awaited<ReturnType<typeof store>>>();const full=new Map<number,Uint8Array>();
 for(const frame of [...new Set(selected.map(sample=>sample.frame))]){
  if(typeof pts[frame]?.best_effort_timestamp_time!=='string')throw Error('Missing original frame PTS');
  const png=command(ffmpeg,['-v','error','-i',source,'-vf',`select=eq(n\\,${frame})`,'-fps_mode','passthrough','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1']);
  images.set(frame,await store(png,'png'));full.set(frame,png);
 }
 const samples=[];
 for(const entry of selected){
  // Nominal grid is manually measured for this 2560×1440 capture. The model
  // has not verified a correspondence with the acquisition detector.
  const box={x:137+157*entry.column,y:392+241*entry.row,width:140,height:210};
  const png=command(ffmpeg,['-v','error','-f','image2pipe','-vcodec','png','-i','pipe:0','-vf',`crop=${box.width}:${box.height}:${box.x}:${box.y}`,
   '-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],full.get(entry.frame));
  samples.push({frameOrdinal:entry.frame,framePtsSeconds:Number(pts[entry.frame].best_effort_timestamp_time),slot:entry.row*10+entry.column,
   row:entry.row+1,column:entry.column+1,box,fullFrame:images.get(entry.frame),crop:await store(png,'png'),
   visualReview:{label:entry.review,authority:'assistant-visual-review',humanConfirmed:false,
    meaning:entry.review.startsWith('scroll-pair')?'Visual position changed between frames 88 and 90; a single crop does not prove motion.':'Visual scene annotation, not ground-truth card fields or a scanner verdict.'}});
 }
 const record={version:1,kind:'private-obstruction-samples',source:{caseId,sha256:sourceSha256,frameWidth:2560,frameHeight:1440,
  ptsMeaning:'decoded source-video PTS; not browser capture clock',coordinateMeaning:'manual fixed nominal grid; not production detector output'},
  selection:'purposive examples only; not random or independent, no population accuracy claims',samples};
 const saved=await store(Buffer.from(JSON.stringify(record,null,2)),'json');console.log(JSON.stringify({manifest:saved,samples:samples.length,sourceSha256},null,2));
}
main().catch(error=>{console.error(String(error));process.exitCode=1;});
