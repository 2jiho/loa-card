import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import {importImagesRecording,importVideoRecording,readRecordingFrames,readRecordingLines,readRecordingMeta,showinfoTimes,videoColorSpace} from '../dev/recording-store';

const ffmpeg=(args:string[])=>{
  const result=spawnSync(ffmpegPath as unknown as string,['-hide_banner','-loglevel','error','-y',...args]);
  assert.equal(result.status,0,String(result.stderr));
};
const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');

test('an untagged HD video is read as BT.709 limited range; tags win when present',()=>{
  assert.deepEqual(videoColorSpace('Stream #0:0: Video: h264 (Main), yuv420p(progressive), 2560x1440'),
    {primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false});
  assert.deepEqual(videoColorSpace('Stream #0:0: Video: h264, yuv420p(pc, smpte170m/smpte170m/smpte170m, progressive), 1920x1080'),
    {primaries:'smpte170m',transfer:'smpte170m',matrix:'smpte170m',fullRange:true});
});

test('frame times come from every showinfo line, relative to the first frame',()=>{
  const log=['[Parsed_showinfo_0 @ 0] n:   0 pts:   1000 pts_time:1      duration:33',
    '[Parsed_showinfo_0 @ 0] n:   1 pts:   1033 pts_time:1.033  duration:33',
    '[Parsed_showinfo_0 @ 0] n:   2 pts:   1100 pts_time:1.1    duration:33'].join('\n');
  assert.deepEqual(showinfoTimes(log),[0,33,100]);
  assert.throws(()=>showinfoTimes(log.replace(/n: {3}1 .*\n/,'')),/skipped a frame/);
});

test('a video becomes a sealed recording with its own frames and times, losslessly',async()=>{
  const root=await mkdtemp(join(tmpdir(),'import-video-'));
  try{
    const video=join(root,'input.mp4');
    ffmpeg(['-f','lavfi','-i','testsrc2=size=64x48:rate=10:duration=0.5','-pix_fmt','yuv420p','-c:v','libx264',video]);
    const meta=await importVideoRecording(root,video,'imported',{kind:'video',sha256:await sha(video),name:'input.mp4'});
    assert.equal(meta.status,'sealed');assert.equal(meta.complete,true);assert.equal(meta.pixelFormat,'i420');
    assert.equal(meta.frames,5);assert.equal(meta.width,64);assert.equal(meta.height,48);
    const lines=await readRecordingLines(root,'imported');
    assert.deepEqual(lines.map(line=>line.deliveredAtMs),[0,100,200,300,400]);
    const source=spawnSync(ffmpegPath as unknown as string,['-v','error','-i',video,'-f','rawvideo','-pix_fmt','yuv420p','pipe:1'],{maxBuffer:1<<24}).stdout;
    const frames:Buffer[]=[];for await(const frame of readRecordingFrames(root,'imported'))frames.push(frame.data);
    assert.ok(Buffer.concat(frames).equals(source),'the decoded frames are the video\'s own bytes');
    assert.match(String((await readRecordingMeta(root,'imported'))?.note),/not a share/);
    await assert.rejects(importVideoRecording(root,video,'other',{kind:'video',sha256:'0'.repeat(64),name:'input.mp4'}),/do not match/);
    await assert.rejects(importVideoRecording(root,video,'imported',{kind:'video',sha256:await sha(video),name:'input.mp4'}),/already exists/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('screenshots are held still in their order and refuse mixed sizes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'import-images-'));
  try{
    const red=join(root,'a.png'),blue=join(root,'b.png'),small=join(root,'c.png');
    ffmpeg(['-f','lavfi','-i','color=red:size=32x16','-frames:v','1',red]);
    ffmpeg(['-f','lavfi','-i','color=blue:size=32x16','-frames:v','1',blue]);
    ffmpeg(['-f','lavfi','-i','color=blue:size=16x16','-frames:v','1',small]);
    const meta=await importImagesRecording(root,[red,blue],'shots',{kind:'images',sha256:'1'.repeat(64),name:'shots'},100);
    assert.equal(meta.pixelFormat,'rgba');assert.equal(meta.frames,6);
    const frames:Buffer[]=[];for await(const frame of readRecordingFrames(root,'shots'))frames.push(frame.data);
    assert.equal(frames.length,6);
    const pixels=(path:string)=>spawnSync(ffmpegPath as unknown as string,['-v','error','-i',path,'-f','rawvideo','-pix_fmt','rgba','pipe:1']).stdout;
    for(const index of [0,1,2])assert.ok(frames[index].equals(pixels(red)),`frame ${index} is the first screenshot`);
    for(const index of [3,4,5])assert.ok(frames[index].equals(pixels(blue)),`frame ${index} is the second screenshot`);
    await assert.rejects(importImagesRecording(root,[red,small],'mixed',{kind:'images',sha256:'1'.repeat(64),name:'mixed'}),/same size/);
  }finally{await rm(root,{recursive:true,force:true});}
});
