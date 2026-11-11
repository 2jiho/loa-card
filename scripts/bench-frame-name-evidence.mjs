// Local-only metadata microbenchmark. Input is an existing private trace export;
// this script never uploads it or prints identities. It does not simulate the
// screen capture/OCR/recording pipeline and cannot establish end-to-end speed.
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {FrameNameEvidence,hashFrameNameEvidence} from '../src/features/card-scanner/recognition/frame-name-evidence.ts';
const path=process.argv[2];
if(!path)throw Error('Usage: node --import tsx scripts/bench-frame-name-evidence.mjs <private-trace.json>');
const input=JSON.parse(await readFile(path,'utf8'));
if(!Array.isArray(input.observations)||!Array.isArray(input.inventory))throw Error('Expected observations and inventory arrays');
const rows=input.observations.filter(row=>row.usable&&row.source?.phase==='input');
const sessions=new Set(rows.map(row=>row.source.sessionId));
if(sessions.size!==1)throw Error('Expected one source session');
const session=[...sessions][0],frames=new Map();
for(const row of rows){
  const source=row.source,frame=frames.get(source.frameId)??{seq:0,processingFrame:source.frameId,frameId:source.frameId,cells:Array(40).fill(null)};
  if(frame.cells[source.slot])throw Error('Repeated original frame/slot; processing-frame provenance required');
  frame.cells[source.slot]={group:row.group,source};frame.seq=Math.max(frame.seq,row.seq);frames.set(source.frameId,frame);
}
const all=[...frames.values()].map(({seq,...frame})=>({seq,type:'frame',value:{version:1,kind:'frame',sessionId:session,...frame}}));
for(const event of input.inventory)if(event.value?.kind==='name-confirmed'&&event.value.source?.phase==='input'&&event.value.source.sessionId===session)
  all.push({seq:event.seq,type:'inventory',value:event.value});
all.sort((a,b)=>a.seq-b.seq);
if(!all.length)throw Error('No eligible facts');
const encoder=new TextEncoder(),frameEvents=all.filter(e=>e.type==='frame');
const bytes=frameEvents.reduce((sum,event)=>sum+encoder.encode(JSON.stringify(event.value)).byteLength,0);
function run(measure=false){
  const reducer=new FrameNameEvidence(session),capture=[];let nanos=0;
  for(const event of all){const t=measure?performance.now():0;
    if(event.type==='frame')reducer.capture(event.value);else reducer.inventory(event.value);
    if(measure){const dt=performance.now()-t;nanos+=dt;if(event.type==='frame')capture.push(dt);}
  }
  return {reducer,nanos,capture};
}
for(let i=0;i<10;i++)run();
const iterations=100, measurements=[];let elapsed=0,last;
for(let i=0;i<iterations;i++){last=run(true);elapsed+=last.nanos;measurements.push(...last.capture);}
const again=run().reducer;
const hash=await hashFrameNameEvidence(last.reducer.snapshot());
const equal=hash!==null&&hash===await hashFrameNameEvidence(again.snapshot());
measurements.sort((a,b)=>a-b);
console.log(JSON.stringify({basis:'private trace-derived metadata; processing frame reconstructed from unique source frame; no pixels or browser',
  actualFrames:frames.size,actualSources:rows.length,actualNameEvents:all.length-frames.size,
  uncompressedJsonBytes:bytes,averageJsonBytesPerFrame:Math.round(bytes/frames.size),
  iterations,meanReducerMsPerTrace:elapsed/iterations,meanReducerMsPerFrame:elapsed/iterations/frames.size,
  captureP50Ms:measurements[Math.floor(measurements.length*.5)],captureP95Ms:measurements[Math.floor(measurements.length*.95)],
  retainedFrames:last.reducer.snapshot().frames.length,complete:last.reducer.snapshot().complete,deterministicProjectionHash:equal},null,2));
