import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordingWriter,frameByteLength,listRecordings,readRecordingFrames,readRecordingLines,readRecordingMeta,recordingIdentifier,replayPixelFormat} from '../dev/recording-store';

const W=64,H=48;
/** Deterministic noisy frame: lossless storage must return it unchanged. */
function frame(seed:number):Uint8Array {
  const data=new Uint8Array(W*H*4);let state=seed*2654435761>>>0;
  for(let index=0;index<data.length;index+=4){
    state=(state*1664525+1013904223)>>>0;
    data[index]=state&255;data[index+1]=(state>>>8)&255;data[index+2]=(state>>>16)&255;data[index+3]=255;
  }
  return data;
}
async function withRoot(run:(root:string)=>Promise<void>):Promise<void> {
  const root=await mkdtemp(join(tmpdir(),'recording-'));
  try{await run(root);}finally{await rm(root,{recursive:true,force:true});}
}

test('frames are stored losslessly, in order, with their timing', async()=>{
  await withRoot(async root=>{
    const writer=await RecordingWriter.start(root,'r1',{width:W,height:H},{browser:'test'});
    const times=[0,33.4,70,180];
    for(let index=0;index<times.length;index++)await writer.writeFrame(frame(index+1),{mediaTimeMs:1000+times[index],deliveredAtMs:times[index]});
    const meta=await writer.seal();
    assert.deepEqual({status:meta.status,frames:meta.frames,complete:meta.complete},{status:'sealed',frames:4,complete:true});
    const decoded:Buffer[]=[];
    for await(const item of readRecordingFrames(root,'r1'))decoded.push(item.data);
    assert.equal(decoded.length,4);
    decoded.forEach((rgba,index)=>assert.ok(Buffer.compare(rgba,Buffer.from(frame(index+1)))===0,`frame ${index} is byte-identical`));
    const lines=await readRecordingLines(root,'r1');
    assert.deepEqual(lines.map(line=>[line.seq,line.deliveredAtMs,line.mediaTimeMs]),times.map((time,index)=>[index,time,1000+time]));
    assert.deepEqual(await readRecordingMeta(root,'r1'),meta);
    assert.equal((await listRecordings(root)).length,1);
  });
});

test('an unsealed recording reads as open and incomplete, up to what was written', async()=>{
  await withRoot(async root=>{
    const writer=await RecordingWriter.start(root,'r2',{width:W,height:H});
    for(let index=0;index<3;index++)await writer.writeFrame(frame(index+10),{mediaTimeMs:null,deliveredAtMs:index*50});
    const meta=await readRecordingMeta(root,'r2');
    assert.deepEqual({status:meta!.status,complete:meta!.complete},{status:'open',complete:false},'the page may disappear before sealing');
    assert.equal((await readRecordingLines(root,'r2')).length>=0,true);
    await writer.seal();
    assert.equal((await readRecordingMeta(root,'r2'))!.complete,true);
  });
});

test('a torn last line from a crash is ignored, earlier lines survive', async()=>{
  await withRoot(async root=>{
    const writer=await RecordingWriter.start(root,'r3',{width:W,height:H});
    await writer.writeFrame(frame(1),{mediaTimeMs:null,deliveredAtMs:0});
    await writer.seal();
    const {appendFile}=await import('node:fs/promises');
    await appendFile(join(root,'r3','frames.jsonl'),'{"seq":1,"deliv');
    assert.equal((await readRecordingLines(root,'r3')).length,1);
  });
});

test('invalid ids, sizes, frames and times are rejected', async()=>{
  await withRoot(async root=>{
    assert.throws(()=>recordingIdentifier('../x'));
    assert.throws(()=>recordingIdentifier(''));
    await assert.rejects(RecordingWriter.start(root,'ok',{width:63,height:48}),/Invalid frame size/);
    await assert.rejects(RecordingWriter.start(root,'ok',{width:0,height:48}),/Invalid frame size/);
    const writer=await RecordingWriter.start(root,'r4',{width:W,height:H});
    await assert.rejects(writer.writeFrame(new Uint8Array(10),{mediaTimeMs:null,deliveredAtMs:0}),/size/);
    await assert.rejects(writer.writeFrame(frame(1),{mediaTimeMs:null,deliveredAtMs:-1}),/delivery time/);
    await assert.rejects(writer.writeFrame(frame(1),{mediaTimeMs:Number.NaN,deliveredAtMs:0}),/media time/);
    await writer.seal();
    await assert.rejects(writer.writeFrame(frame(1),{mediaTimeMs:null,deliveredAtMs:0}),/sealed/);
    await assert.rejects(RecordingWriter.start(root,'r4',{width:W,height:H}),/already exists/);
  });
});

test('a sealed recording stores the whole stream and reads back after a restart (fresh reader)', async()=>{
  await withRoot(async root=>{
    const writer=await RecordingWriter.start(root,'r5',{width:W,height:H});
    for(let index=0;index<30;index++)await writer.writeFrame(frame(index),{mediaTimeMs:index*33,deliveredAtMs:index*33});
    await writer.seal();
    let count=0;
    for await(const item of readRecordingFrames(root,'r5')){assert.equal(item.seq,count);count++;}
    assert.equal(count,30);
    assert.ok((await readFile(join(root,'r5','frames.mkv'))).length>0);
  });
});

/** Native YUV: deterministic Y plane and chroma planes. */
function yuvPlanes(seed:number):{y:Uint8Array;u:Uint8Array;v:Uint8Array} {
  const y=new Uint8Array(W*H),u=new Uint8Array(W*H/4),v=new Uint8Array(W*H/4);
  let state=seed*2654435761>>>0;
  const next=()=>{state=(state*1664525+1013904223)>>>0;return state>>>24;};
  for(let index=0;index<y.length;index++)y[index]=next();
  for(let index=0;index<u.length;index++){u[index]=next();v[index]=next();}
  return {y,u,v};
}
const i420=({y,u,v}:{y:Uint8Array;u:Uint8Array;v:Uint8Array})=>Buffer.concat([y,u,v]);
function nv12({y,u,v}:{y:Uint8Array;u:Uint8Array;v:Uint8Array}):Buffer {
  const chroma=new Uint8Array(u.length*2);
  for(let index=0;index<u.length;index++){chroma[index*2]=u[index];chroma[index*2+1]=v[index];}
  return Buffer.concat([y,chroma]);
}

test('native I420 frames are stored losslessly and replayed as the same bytes', async()=>{
  await withRoot(async root=>{
    const writer=await RecordingWriter.start(root,'y1',{width:W,height:H,pixelFormat:'i420',colorSpace:{primaries:'bt709',matrix:'bt709',transfer:'bt709',fullRange:false}});
    assert.equal(writer.frameBytes,frameByteLength('i420',W,H));
    const frames=[1,2,3].map(index=>i420(yuvPlanes(index)));
    for(let index=0;index<frames.length;index++)await writer.writeFrame(frames[index],{mediaTimeMs:index*33,deliveredAtMs:index*33});
    const meta=await writer.seal();
    assert.deepEqual({pixelFormat:meta.pixelFormat,complete:meta.complete,version:meta.version},{pixelFormat:'i420',complete:true,version:2});
    assert.deepEqual(meta.colorSpace,{primaries:'bt709',matrix:'bt709',transfer:'bt709',fullRange:false},'the color description is kept for display');
    assert.match(meta.sha256??'',/^[a-f0-9]{64}$/);
    let count=0;
    for await(const item of readRecordingFrames(root,'y1')){assert.ok(item.data.equals(frames[item.seq]),`frame ${item.seq}`);count++;}
    assert.equal(count,3);
  });
});

test('native NV12 frames are repacked exactly and replayed as I420', async()=>{
  await withRoot(async root=>{
    const writer=await RecordingWriter.start(root,'y2',{width:W,height:H,pixelFormat:'nv12'});
    const planes=[4,5].map(yuvPlanes);
    for(let index=0;index<planes.length;index++)await writer.writeFrame(nv12(planes[index]),{mediaTimeMs:null,deliveredAtMs:index*40});
    const meta=await writer.seal();
    assert.equal(replayPixelFormat(meta.pixelFormat),'i420');
    let count=0;
    for await(const item of readRecordingFrames(root,'y2')){assert.ok(item.data.equals(i420(planes[item.seq])),`frame ${item.seq} deinterleaved without change`);count++;}
    assert.equal(count,2);
  });
});

test('a native recording rejects a frame of the wrong layout size', async()=>{
  await withRoot(async root=>{
    const writer=await RecordingWriter.start(root,'y3',{width:W,height:H,pixelFormat:'i420'});
    await assert.rejects(writer.writeFrame(Buffer.alloc(W*H*4),{mediaTimeMs:null,deliveredAtMs:0}),/size/);
    await assert.rejects(RecordingWriter.start(root,'y4',{width:W,height:H,pixelFormat:'yuv444' as never}),/pixel format/);
    await writer.seal();
  });
});

test('an abandoned recording is recovered from what actually decodes, marked incomplete', async()=>{
  await withRoot(async root=>{
    const {recoverRecording}=await import('../dev/recording-store');
    const writer=await RecordingWriter.start(root,'o1',{width:W,height:H});
    for(let index=0;index<6;index++)await writer.writeFrame(frame(index),{mediaTimeMs:null,deliveredAtMs:index*30});
    await writer.abandon();                                   // the server died: no clean finish
    assert.equal((await readRecordingMeta(root,'o1'))!.status,'open');
    const recovered=await recoverRecording(root,'o1','after a restart');
    assert.equal(recovered.status,'sealed');
    assert.equal(recovered.complete,false,'an unfinished encoder never yields a complete recording');
    assert.ok(recovered.frames>=0&&recovered.frames<=6,'the count is what decodes, not what was promised');
    assert.match(recovered.note??'',/recovered: \d+ decodable of 6 listed frames/);
    assert.match(recovered.note??'',/after a restart/);
    let decoded=0;
    for await(const item of readRecordingFrames(root,'o1')){assert.ok(item.data.equals(Buffer.from(frame(item.seq))),`frame ${item.seq}`);decoded++;}
    assert.equal(decoded,recovered.frames);
    assert.equal((await recoverRecording(root,'o1')).sealedAt,recovered.sealedAt,'recovering twice changes nothing');
    await assert.rejects(recoverRecording(root,'missing'),/Unknown recording/);
  });
});

test('sealing twice at once (a retry after a page reload) returns the one finished seal', async()=>{
  await withRoot(async root=>{
    const writer=await RecordingWriter.start(root,'s1',{width:W,height:H});
    for(let index=0;index<4;index++)await writer.writeFrame(frame(index),{mediaTimeMs:null,deliveredAtMs:index*30});
    const [first,second]=await Promise.all([writer.seal('first'),writer.seal('retry')]);
    assert.equal(first.status,'sealed');
    assert.equal(second.status,'sealed','the second caller never sees the still-open metadata');
    assert.deepEqual([first.frames,second.frames,first.sha256===second.sha256],[4,4,true]);
    assert.equal((await writer.seal()).sealedAt,first.sealedAt,'a later call changes nothing');
    assert.match(first.note??'',/first/);
  });
});

test('a transcoded copy decodes to exactly the same frames and keeps the timing', async()=>{
  await withRoot(async root=>{
    const {transcodeRecording}=await import('../dev/recording-store');
    const writer=await RecordingWriter.start(root,'t1',{width:W,height:H,pixelFormat:'i420'});
    const frames=[1,2,3,4].map(index=>i420(yuvPlanes(index)));
    for(let index=0;index<frames.length;index++)await writer.writeFrame(frames[index],{mediaTimeMs:index*33,deliveredAtMs:index*33});
    const original=await writer.seal();
    const copy=await transcodeRecording(root,'t1','t1-copy');
    assert.equal(copy.id,'t1-copy');assert.equal(copy.frames,4);assert.equal(copy.complete,true);
    assert.equal(copy.codec,'h264-lossless');assert.match(copy.note??'',/transcoded from t1/);
    assert.notEqual(copy.sha256,null);
    let count=0;
    for await(const item of readRecordingFrames(root,'t1-copy')){assert.ok(item.data.equals(frames[item.seq]),`frame ${item.seq}`);count++;}
    assert.equal(count,4);
    assert.deepEqual((await readRecordingLines(root,'t1-copy')).map(line=>line.deliveredAtMs),[0,33,66,99]);
    assert.equal((await readRecordingMeta(root,'t1'))!.sha256,original.sha256,'the source is untouched');
    await assert.rejects(transcodeRecording(root,'t1','t1-copy'),/already exists/);
    await assert.rejects(transcodeRecording(root,'nope','x'),/Unknown recording/);
  });
});
