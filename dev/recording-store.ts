import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream,existsSync} from 'node:fs';
import {mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import type {WriteStream} from 'node:fs';
import {join} from 'node:path';
import ffmpegPath from 'ffmpeg-static';

/** Development/test only. Server-side, lossless recording of a screen share.
 * See docs/dev-recording.md. No security model: local development only. */
export const DEFAULT_RECORDING_ROOT='fixtures/local/recordings';
const ID=/^[A-Za-z0-9._-]{1,128}$/;
const MAX_SIDE=8192;

/** `rgba`: converted pixels. `i420`/`nv12`: the shared frame's native bytes, no
 * conversion at record time. Native frames are stored as lossless yuv420p and
 * replayed as I420 whatever the source layout was (an NV12 repack is exact). */
export type RecordingPixelFormat='rgba'|'i420'|'nv12';
export function frameByteLength(format:RecordingPixelFormat,width:number,height:number):number {
  return format==='rgba'?width*height*4:width*height*3/2;
}
export function replayPixelFormat(format:RecordingPixelFormat):'rgba'|'i420' {return format==='rgba'?'rgba':'i420';}

/** Both are lossless; recordings of older codecs (including FFV1) still decode.
 * - `h264-lossless` (planar YUV, the normal case): x264 at qp 0 keeps every
 *   byte and, because consecutive frames of a scrolling list are nearly alike,
 *   is about 8x smaller than Ut Video (599 MB to 74 MB for 304 real 2560x1440
 *   frames, byte-identical decode) while encoding ~300 fps and decoding as
 *   fast as Ut Video. `ultrafast` has no B-frames or lookahead, so a crashed
 *   recording still decodes up to its last frame.
 * - `utvideo` (RGBA fallback): intra-only; the fast choice for a layout that is
 *   rarely used. */
export type RecordingCodec='utvideo'|'h264-lossless';
export function codecFor(format:RecordingPixelFormat):{name:RecordingCodec;args:string[]} {
  return format==='rgba'
    ?{name:'utvideo',args:['-c:v','utvideo','-pred','median','-pix_fmt','rgba']}
    :{name:'h264-lossless',args:['-c:v','libx264','-preset','ultrafast','-qp','0','-pix_fmt','yuv420p']};
}
export function isPixelFormat(value:unknown):value is RecordingPixelFormat {return value==='rgba'||value==='i420'||value==='nv12';}

export interface RecordingFrameInfo {
  /** Media time reported by the source, in ms; null when unknown. */
  readonly mediaTimeMs:number|null;
  /** Delivery time since the session started, in ms. Drives replay cadence. */
  readonly deliveredAtMs:number;
}
export interface RecordedFrameLine extends RecordingFrameInfo {readonly seq:number;readonly receivedAtMs:number}
export interface RecordingMeta {
  readonly version:2;readonly id:string;readonly startedAt:string;readonly width:number;readonly height:number;
  /** Layout of the frames as received; replay uses `replayPixelFormat`. */
  readonly pixelFormat:RecordingPixelFormat;
  /** The source's color description (VideoColorSpaceInit), needed to display native frames as the scanner saw them. */
  readonly colorSpace:unknown;
  /** Lossless codec of frames.mkv. Recordings made before this field were FFV1 (decoding picks the codec itself). */
  readonly codec?:RecordingCodec;
  readonly status:'open'|'sealed';readonly frames:number;readonly complete:boolean;
  /** SHA-256 of frames.mkv, set when sealed. */
  readonly sha256:string|null;
  readonly sealedAt:string|null;readonly note:string|null;readonly environment:unknown;
}
export interface RecordingStart {
  readonly width:number;readonly height:number;
  readonly pixelFormat?:RecordingPixelFormat;
  readonly colorSpace?:unknown;
  readonly environment?:unknown;
}

export function recordingIdentifier(value:unknown):string {
  if(typeof value!=='string'||!ID.test(value))throw Error('Invalid recording id.');
  return value;
}
function ffmpeg():string {
  if(typeof ffmpegPath!=='string'||!existsSync(ffmpegPath))throw Error('ffmpeg-static is not installed.');
  return ffmpegPath;
}
async function writeJson(path:string,value:unknown):Promise<void> {
  const temp=`${path}.${process.pid}.tmp`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`);await rename(temp,path);
}
function fileHash(path:string):Promise<string> {
  return new Promise((resolve,reject)=>{
    const hash=createHash('sha256');
    createReadStream(path).on('data',chunk=>hash.update(chunk)).on('error',reject).on('end',()=>resolve(hash.digest('hex')));
  });
}

export class RecordingWriter {
  private readonly root:string;private readonly id:string;
  readonly width:number;readonly height:number;readonly frameBytes:number;readonly pixelFormat:RecordingPixelFormat;
  private process:ChildProcessWithoutNullStreams|undefined;
  private lines:WriteStream|undefined;
  private exited:Promise<number>|undefined;
  private ffmpegError='';
  private frames=0;
  private startedAt=Date.now();
  private sealed=false;
  private broken:string|null=null;
  private meta:RecordingMeta;

  private constructor(root:string,id:string,start:RecordingStart,pixelFormat:RecordingPixelFormat) {
    this.root=root;this.id=id;this.width=start.width;this.height=start.height;this.pixelFormat=pixelFormat;
    this.frameBytes=frameByteLength(pixelFormat,start.width,start.height);
    this.meta={version:2,id,startedAt:new Date(this.startedAt).toISOString(),width:start.width,height:start.height,pixelFormat,
      colorSpace:start.colorSpace??null,codec:codecFor(pixelFormat).name,status:'open',frames:0,complete:false,sha256:null,sealedAt:null,note:null,environment:start.environment??null};
  }

  static async start(root:string,idValue:string,start:RecordingStart):Promise<RecordingWriter> {
    const id=recordingIdentifier(idValue);
    const {width,height}=start;
    const pixelFormat=start.pixelFormat??'rgba';
    if(!isPixelFormat(pixelFormat))throw Error('Invalid pixel format.');
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<2||height<2||width>MAX_SIDE||height>MAX_SIDE||width%2||height%2)
      throw Error('Invalid frame size (even, 2..8192).');
    const directory=join(root,id);
    if(existsSync(join(directory,'meta.json')))throw Error('Recording already exists.');
    await mkdir(directory,{recursive:true});
    const writer=new RecordingWriter(root,id,start,pixelFormat);
    await writeJson(join(directory,'meta.json'),writer.meta);
    writer.lines=createWriteStream(join(directory,'frames.jsonl'),{flags:'a'});
    // Native YUV is repacked (never rescaled or recolored) to planar yuv420p.
    const codec=codecFor(pixelFormat);
    const child=spawn(ffmpeg(),['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt',pixelFormat==='rgba'?'rgba':pixelFormat==='nv12'?'nv12':'yuv420p',
      '-s',`${width}x${height}`,'-framerate','30','-i','pipe:0',...codec.args,join(directory,'frames.mkv')]);
    writer.process=child;
    child.stderr.on('data',(data:Buffer)=>{if(writer.ffmpegError.length<4000)writer.ffmpegError+=data.toString();});
    child.stdin.on('error',error=>{writer.broken=`ffmpeg input: ${error.message}`;});
    writer.exited=new Promise<number>(resolve=>{child.on('close',code=>resolve(code??-1));child.on('error',error=>{writer.broken=`ffmpeg: ${error.message}`;resolve(-1);});});
    return writer;
  }

  /** Stop the encoder without finalizing, as a crash would. For tests and
   * server shutdown; the recording stays 'open' and is recovered later. */
  async abandon():Promise<void> {
    if(this.sealed)return;
    this.sealed=true;
    this.process!.kill();
    await this.exited;
    await new Promise<void>(resolve=>this.lines!.end(()=>resolve()));
  }

  get frameCount():number {return this.frames;}
  get isBroken():string|null {return this.broken;}

  /** Resolves once ffmpeg accepted the frame (backpressure is honoured). */
  async writeFrame(data:Uint8Array,info:RecordingFrameInfo):Promise<number> {
    if(this.sealed)throw Error('Recording is sealed.');
    if(this.broken)throw Error(this.broken);
    if(data.byteLength!==this.frameBytes)throw Error('Frame size does not match the recording.');
    if(!Number.isFinite(info.deliveredAtMs)||info.deliveredAtMs<0)throw Error('Invalid delivery time.');
    if(info.mediaTimeMs!==null&&!Number.isFinite(info.mediaTimeMs))throw Error('Invalid media time.');
    const stdin=this.process!.stdin;
    const seq=this.frames++;
    const line:RecordedFrameLine={seq,mediaTimeMs:info.mediaTimeMs,deliveredAtMs:info.deliveredAtMs,receivedAtMs:Date.now()-this.startedAt};
    this.lines!.write(`${JSON.stringify(line)}\n`);
    // An encoder that dies while its input is full never drains: fail instead of waiting forever.
    if(!stdin.write(data))await Promise.race([new Promise<void>(resolve=>stdin.once('drain',resolve)),
      this.exited!.then(()=>{throw Error(this.broken??'ffmpeg exited while a frame was being written.');})]);
    return seq;
  }

  /** Close the encoder and mark the recording sealed. `complete` means every
   * accepted frame is in the file; an encoder failure leaves it false. */
  async seal(note:string|null=null):Promise<RecordingMeta> {
    // Concurrent or repeated callers (a retry after a page reload) wait for the
    // one real seal instead of receiving the still-open metadata.
    if(this.sealing)return this.sealing;
    if(this.sealed)return this.meta;
    this.sealing=this.finishSeal(note);
    return this.sealing;
  }

  private sealing:Promise<RecordingMeta>|undefined;

  private async finishSeal(note:string|null):Promise<RecordingMeta> {
    this.sealed=true;
    this.process!.stdin.end();
    const code=await this.exited!;
    await new Promise<void>(resolve=>this.lines!.end(()=>resolve()));
    const complete=code===0&&!this.broken;
    const failure=complete?null:`ffmpeg exit ${code}${this.ffmpegError?`: ${this.ffmpegError.trim().slice(0,500)}`:''}${this.broken?` (${this.broken})`:''}`;
    // A caller note never hides an encoder failure.
    const combined=[note,failure].filter((part):part is string=>!!part).join(' | ')||null;
    let sha256:string|null=null;
    try{sha256=await fileHash(join(this.root,this.id,'frames.mkv'));}catch{/* An unreadable file stays unhashed. */}
    this.meta={...this.meta,status:'sealed',frames:this.frames,complete,sha256,sealedAt:new Date().toISOString(),note:combined};
    await writeJson(join(this.root,this.id,'meta.json'),this.meta);
    return this.meta;
  }
}

export async function readRecordingMeta(root:string,idValue:string):Promise<RecordingMeta|undefined> {
  const id=recordingIdentifier(idValue);
  try{return JSON.parse(await readFile(join(root,id,'meta.json'),'utf8')) as RecordingMeta;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}

export async function readRecordingLines(root:string,idValue:string):Promise<RecordedFrameLine[]> {
  const id=recordingIdentifier(idValue);
  let text:string;
  try{text=await readFile(join(root,id,'frames.jsonl'),'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const lines:RecordedFrameLine[]=[];
  for(const raw of text.split('\n')){
    if(!raw)continue;
    try{lines.push(JSON.parse(raw) as RecordedFrameLine);}catch{break;} // a torn last line from a crash
  }
  return lines;
}

export async function listRecordings(root:string):Promise<RecordingMeta[]> {
  let names:string[];
  try{names=(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&ID.test(entry.name)).map(entry=>entry.name).sort();}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const result:RecordingMeta[]=[];
  for(const name of names){const meta=await readRecordingMeta(root,name);if(meta)result.push(meta);}
  return result;
}

/** Decode a recording back to raw frames in its replay layout, in order. A
 * recording that was never sealed is readable up to what ffmpeg managed to write. */
export async function* readRecordingFrames(root:string,idValue:string,options:{signal?:AbortSignal}={}):AsyncGenerator<{seq:number;data:Buffer}> {
  const id=recordingIdentifier(idValue);
  const meta=await readRecordingMeta(root,id);
  if(!meta)throw Error('Unknown recording.');
  const file=join(root,id,'frames.mkv');
  if(!existsSync(file))return;
  const replay=replayPixelFormat(meta.pixelFormat);
  const frameBytes=frameByteLength(replay,meta.width,meta.height);
  const child=spawn(ffmpeg(),['-hide_banner','-loglevel','error','-threads','0','-i',file,'-f','rawvideo','-pix_fmt',replay==='rgba'?'rgba':'yuv420p','-fps_mode','passthrough','pipe:1']);
  const stop=()=>child.kill();
  options.signal?.addEventListener('abort',stop,{once:true});
  let pending:Buffer[]=[],pendingBytes=0,seq=0;
  try{
    for await(const chunk of child.stdout){
      pending.push(chunk as Buffer);pendingBytes+=(chunk as Buffer).length;
      while(pendingBytes>=frameBytes){
        const joined=pending.length===1?pending[0]:Buffer.concat(pending);
        yield {seq:seq++,data:Buffer.from(joined.subarray(0,frameBytes))};
        const rest=joined.subarray(frameBytes);
        pending=rest.length?[rest]:[];pendingBytes=rest.length;
      }
    }
  }finally{options.signal?.removeEventListener('abort',stop);stop();}
}

/** Seal a recording that has no live writer (the server restarted or the
 * writer was abandoned). The frame count is what actually decodes, never what
 * the timing file claims, and the recording is marked incomplete because the
 * encoder did not finish cleanly. */
export async function recoverRecording(root:string,idValue:string,note:string|null=null):Promise<RecordingMeta> {
  const id=recordingIdentifier(idValue);
  const meta=await readRecordingMeta(root,id);
  if(!meta)throw Error('Unknown recording.');
  if(meta.status==='sealed')return meta;
  let decodable=0;
  for await(const item of readRecordingFrames(root,id)){void item;decodable++;}
  const listed=(await readRecordingLines(root,id)).length;
  const frames=Math.min(decodable,listed);
  let sha256:string|null=null;
  try{sha256=await fileHash(join(root,id,'frames.mkv'));}catch{/* An unreadable file stays unhashed. */}
  const detail=`recovered: ${decodable} decodable of ${listed} listed frames`;
  const sealed:RecordingMeta={...meta,status:'sealed',frames,complete:false,sha256,sealedAt:new Date().toISOString(),
    note:[note,detail,meta.note].filter((part):part is string=>!!part).join(' | ')};
  await writeJson(join(root,id,'meta.json'),sealed);
  return sealed;
}

/** Copy a sealed recording into a new one stored with the current codec. The
 * decoded frames are identical (both codecs are lossless); only the file, its
 * hash and the decode speed change. The source is left untouched. */
export async function transcodeRecording(root:string,sourceIdValue:string,newIdValue:string):Promise<RecordingMeta> {
  const sourceId=recordingIdentifier(sourceIdValue),newId=recordingIdentifier(newIdValue);
  const meta=await readRecordingMeta(root,sourceId);
  if(!meta)throw Error('Unknown recording.');
  if(meta.status!=='sealed')throw Error('Only a sealed recording can be transcoded.');
  const target=join(root,newId);
  if(existsSync(join(target,'meta.json')))throw Error('Recording already exists.');
  await mkdir(target,{recursive:true});
  const lines=await readRecordingLines(root,sourceId);
  await writeFile(join(target,'frames.jsonl'),lines.map(line=>JSON.stringify(line)).join('\n')+(lines.length?'\n':''));
  const replay=replayPixelFormat(meta.pixelFormat);
  const code=await new Promise<number>((resolve,reject)=>{
    const child=spawn(ffmpeg(),['-hide_banner','-loglevel','error','-y','-threads','0','-i',join(root,sourceId,'frames.mkv'),
      ...codecFor(replay==='rgba'?'rgba':'i420').args,join(target,'frames.mkv')]);
    child.on('error',reject);child.on('close',value=>resolve(value??-1));
  });
  if(code!==0)throw Error(`ffmpeg exit ${code}`);
  // The reader needs a metadata file; it is replaced below with the verified one.
  const pixelFormat:RecordingPixelFormat=meta.pixelFormat==='nv12'?'i420':meta.pixelFormat;
  const targetCodec=codecFor(pixelFormat).name;
  await writeJson(join(target,'meta.json'),{...meta,id:newId,codec:targetCodec,pixelFormat,status:'open',complete:false,sha256:null});
  let decoded=0;
  for await(const item of readRecordingFrames(root,newId)){void item;decoded++;}
  const sha256=await fileHash(join(target,'frames.mkv'));
  const copy:RecordingMeta={...meta,id:newId,codec:targetCodec,sha256,
    // An NV12 source was already repacked to yuv420p when it was stored.
    pixelFormat,
    complete:meta.complete&&decoded===lines.length,frames:Math.min(decoded,lines.length),
    note:[`transcoded from ${sourceId} (lossless)`,meta.note].filter((part):part is string=>!!part).join(' | ')};
  await writeJson(join(target,'meta.json'),copy);
  return copy;
}

/** Frame order of a derived recording, as source frame indices. */
export function derivedOrder(frames:number,kind:'reverse'|{readonly middle:number}):number[] {
  const all=Array.from({length:frames},(_,index)=>index);
  if(kind==='reverse')return all.reverse();
  // Start at `middle`, go to the end, then all the way back to the start (a scan begun mid-list).
  const from=Math.max(0,Math.min(frames-1,Math.floor(kind.middle)));
  return [...all.slice(from),...all.slice(0,frames-1).reverse()];
}

/** Times of the frames in a new order: the first frame keeps its times, and each next frame is as
 * far from the one before as the two were apart in the source (the cadence is kept). */
export function derivedLines(lines:readonly RecordedFrameLine[],order:readonly number[]):RecordedFrameLine[] {
  const out:RecordedFrameLine[]=[];
  order.forEach((index,seq)=>{
    const line=lines[index];
    if(!seq){out.push({...line,seq});return;}
    const before=out[seq-1],previous=lines[order[seq-1]];
    // A turn shows the same frame twice in a row: take the cadence of its neighbours.
    const near=lines[index+1]??lines[index-1]??line;
    const step=(a:number|null,b:number|null,c:number|null)=>a===null||b===null?null:Math.max(1,Math.abs(b-a)||(c===null?1:Math.abs(c-b)));
    const media=step(previous.mediaTimeMs,line.mediaTimeMs,near.mediaTimeMs);
    out.push({seq,deliveredAtMs:before.deliveredAtMs+step(previous.deliveredAtMs,line.deliveredAtMs,near.deliveredAtMs)!,
      receivedAtMs:before.receivedAtMs+step(previous.receivedAtMs,line.receivedAtMs,near.receivedAtMs)!,
      mediaTimeMs:before.mediaTimeMs===null||media===null?null:before.mediaTimeMs+media});
  });
  return out;
}

/** Runs of neighbouring source frames in one direction; a run going back is kept short, since
 * ffmpeg holds a reversed run in memory. */
export function derivedRuns(order:readonly number[],maxDown=48):{first:number;last:number;down:boolean}[] {
  const runs:{first:number;last:number;down:boolean}[]=[];
  for(const index of order){
    const run=runs[runs.length-1],length=run?Math.abs(run.last-run.first)+1:0;
    if(run&&index===run.last+1&&(length===1||!run.down)){run.last=index;run.down=false;}
    else if(run&&index===run.last-1&&(length===1||run.down)&&length<maxDown){run.last=index;run.down=true;}
    else runs.push({first:index,last:index,down:false});
  }
  return runs;
}

/** Dev only: a new recording whose frames are a sealed recording's frames in another order: a scan
 * from the bottom up, or one begun mid-list. Not a share that happened; the meta says what it was
 * derived from. The source is left untouched. */
export async function deriveRecording(root:string,sourceIdValue:string,newIdValue:string,kind:'reverse'|{readonly middle:number}):Promise<RecordingMeta> {
  const sourceId=recordingIdentifier(sourceIdValue),newId=recordingIdentifier(newIdValue);
  const meta=await readRecordingMeta(root,sourceId);
  if(!meta)throw Error('Unknown recording.');
  if(meta.status!=='sealed')throw Error('Only a sealed recording can be derived.');
  const target=join(root,newId);
  if(existsSync(join(target,'meta.json')))throw Error('Recording already exists.');
  await mkdir(target,{recursive:true});
  const lines=(await readRecordingLines(root,sourceId)).slice(0,meta.frames);
  const order=derivedOrder(lines.length,kind);
  const pixelFormat:RecordingPixelFormat=meta.pixelFormat==='nv12'?'i420':meta.pixelFormat;
  const codec=codecFor(replayPixelFormat(meta.pixelFormat)==='rgba'?'rgba':'i420');
  const ffmpegRun=(args:string[])=>new Promise<void>((resolve,reject)=>{
    const child=spawn(ffmpeg(),['-hide_banner','-loglevel','error','-y',...args]);
    child.on('error',reject);child.on('close',value=>value===0?resolve():reject(Error(`ffmpeg exit ${value}`)));
  });
  const parts:string[]=[];
  for(const [index,run] of derivedRuns(order).entries()){
    const file=join(target,`part-${index}.mkv`),from=Math.min(run.first,run.last),to=Math.max(run.first,run.last);
    parts.push(file);
    await ffmpegRun(['-i',join(root,sourceId,'frames.mkv'),'-vf',`trim=start_frame=${from}:end_frame=${to+1},setpts=N/30/TB${run.down?',reverse':''}`,
      '-r','30',...codec.args,file]);
  }
  const list=join(target,'parts.txt');
  // Names relative to the list's own folder (ffmpeg resolves them from there).
  await writeFile(list,parts.map((_,index)=>`file 'part-${index}.mkv'`).join('\n')+'\n');
  await ffmpegRun(['-f','concat','-safe','0','-i',list,'-c','copy',join(target,'frames.mkv')]);
  for(const file of [...parts,list])await rm(file,{force:true});
  const derived=derivedLines(lines,order);
  await writeFile(join(target,'frames.jsonl'),derived.map(line=>JSON.stringify(line)).join('\n')+'\n');
  await writeJson(join(target,'meta.json'),{...meta,id:newId,codec:codecFor(pixelFormat).name,pixelFormat,status:'open',complete:false,sha256:null});
  let decoded=0;
  for await(const item of readRecordingFrames(root,newId)){void item;decoded++;}
  if(decoded!==derived.length)throw Error(`derived ${decoded} frames, expected ${derived.length}`);
  const sha256=await fileHash(join(target,'frames.mkv'));
  const how=kind==='reverse'?'frames in reverse order: a scan from the bottom up':`from frame ${kind.middle} to the end, then back to the start: a scan begun mid-list`;
  const copy:RecordingMeta={...meta,id:newId,codec:codecFor(pixelFormat).name,pixelFormat,sha256,frames:derived.length,
    note:[`derived from ${sourceId} (${how}; not a share that happened)`,meta.note].filter((part):part is string=>!!part).join(' | ')};
  await writeJson(join(target,'meta.json'),copy);
  return copy;
}

/** Raw decoded frames of a recording as one byte stream, straight from ffmpeg
 * (no per-frame handling in JS: ~3x the throughput of re-framing). Frame
 * boundaries are every `frameBytes` bytes. `from` skips earlier frames. */
export async function openRecordingDecoder(root:string,idValue:string,options:{from?:number;signal?:AbortSignal}={}):Promise<
  {stream:NodeJS.ReadableStream;frameBytes:number;pixelFormat:'rgba'|'i420';width:number;height:number;kill:()=>void}> {
  const id=recordingIdentifier(idValue);
  const meta=await readRecordingMeta(root,id);
  if(!meta)throw Error('Unknown recording.');
  const file=join(root,id,'frames.mkv');
  if(!existsSync(file))throw Error('Recording has no frames.');
  const replay=replayPixelFormat(meta.pixelFormat);
  const from=Math.max(0,Math.floor(options.from??0));
  const child=spawn(ffmpeg(),['-hide_banner','-loglevel','error','-threads','0','-i',file,
    // The comma inside the filter expression must reach ffmpeg as `\,`.
    ...(from>0?['-vf',`select=gte(n\\,${from})`]:[]),
    '-f','rawvideo','-pix_fmt',replay==='rgba'?'rgba':'yuv420p','-fps_mode','passthrough','pipe:1']);
  const kill=()=>{child.kill();};
  options.signal?.addEventListener('abort',kill,{once:true});
  return {stream:child.stdout,frameBytes:frameByteLength(replay,meta.width,meta.height),pixelFormat:replay,width:meta.width,height:meta.height,kill};
}

/** Where an imported recording came from (absent on a recorded share). */
export interface RecordingSource {
  readonly kind:'video'|'images';
  /** The video file's SHA-256 (images: of the ordered list of image hashes), and its corpus case
   * when it was imported from one. */
  readonly sha256:string;readonly name:string;readonly corpusCase?:string;
}

/** The color description of an untagged or tagged video, as VideoColorSpaceInit. An untagged
 * HD video is BT.709 limited range, as a browser playing it assumes. */
export function videoColorSpace(probe:string):{primaries:string;transfer:string;matrix:string;fullRange:boolean} {
  const stream=/Video: [^\n]*?yuv420p\(([^)]*)\)/.exec(probe)?.[1]??'';
  const parts=stream.split(',').map(part=>part.trim());
  const fullRange=parts.includes('pc');
  const known=['bt709','smpte170m','bt470bg'];
  const matrix=parts.find(part=>known.includes(part.split('/')[0]))?.split('/')[0]??'bt709';
  return {primaries:matrix==='bt470bg'?'bt470bg':matrix,transfer:matrix==='bt709'?'bt709':'smpte170m',matrix,fullRange};
}

/** Frame times from ffmpeg's `showinfo` log, in ms from the first frame. */
export function showinfoTimes(log:string):number[] {
  const times:number[]=[];
  for(const match of log.matchAll(/\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/g))times[Number(match[1])]=Number(match[2])*1000;
  // A plain loop: array methods skip the holes a missing frame leaves.
  for(let index=0;index<times.length;index++)if(!Number.isFinite(times[index]))throw Error('ffmpeg showinfo skipped a frame.');
  const first=times[0]??0;
  return times.map(time=>Math.round((time-first)*1000)/1000);
}

/** A sealed recording from a video file (a screen recording a person made, not a share recorded by
 * the dev server), so the current scanner can replay it like a share. The video's own YUV 4:2:0
 * frames are kept losslessly (no scaling or color conversion) and replayed at their own times. The
 * video was already lossy-compressed by whatever recorded it; that is part of the input. */
export async function importVideoRecording(root:string,videoPath:string,newIdValue:string,source:RecordingSource):Promise<RecordingMeta> {
  const newId=recordingIdentifier(newIdValue);
  const target=join(root,newId);
  if(existsSync(join(target,'meta.json')))throw Error('Recording already exists.');
  if(await fileHash(videoPath)!==source.sha256)throw Error('Video bytes do not match the given SHA-256.');
  const run=(args:string[])=>new Promise<string>((resolve,reject)=>{
    const child=spawn(ffmpeg(),['-hide_banner',...args]);let log='';
    child.stderr.on('data',chunk=>{log+=chunk;});
    child.on('error',reject);child.on('close',value=>value===0?resolve(log):reject(Error(`ffmpeg exit ${value}: ${log.slice(-400)}`)));
  });
  const probe=await run(['-i',videoPath,'-f','null','-frames:v','1','-']);
  const size=/Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(probe);
  if(!size)throw Error('No video stream.');
  if(!/Video: [^\n]*yuv420p/.test(probe))throw Error('Only YUV 4:2:0 videos are supported.');
  const width=Number(size[1]),height=Number(size[2]);
  if(width%2||height%2||width>MAX_SIDE||height>MAX_SIDE)throw Error('Unsupported video size.');
  await mkdir(target,{recursive:true});
  const log=await run(['-loglevel','info','-y','-i',videoPath,'-an','-map','0:v:0','-vf','showinfo','-fps_mode','passthrough',
    ...codecFor('i420').args,join(target,'frames.mkv')]);
  const times=showinfoTimes(log);
  if(!times.length)throw Error('The video has no frames.');
  await writeFile(join(target,'frames.jsonl'),times.map((time,seq)=>JSON.stringify({seq,mediaTimeMs:time,deliveredAtMs:time,receivedAtMs:Math.round(time)})).join('\n')+'\n');
  const meta:RecordingMeta&{source:RecordingSource}={version:2,id:newId,startedAt:new Date().toISOString(),width,height,pixelFormat:'i420',
    colorSpace:videoColorSpace(probe),codec:'h264-lossless',status:'open',frames:times.length,complete:false,sha256:null,sealedAt:null,
    note:null,environment:null,source};
  await writeJson(join(target,'meta.json'),meta);
  let decoded=0;
  for await(const item of readRecordingFrames(root,newId)){void item;decoded++;}
  if(decoded!==times.length)throw Error(`imported ${decoded} frames, expected ${times.length}`);
  const sealed:RecordingMeta&{source:RecordingSource}={...meta,status:'sealed',complete:true,sha256:await fileHash(join(target,'frames.mkv')),
    sealedAt:new Date().toISOString(),
    note:`imported from the video ${source.name}${source.corpusCase?` (corpus case ${source.corpusCase.slice(0,12)})`:''}: a screen recording a person made, replayed at its own frame times; not a share the dev server recorded`};
  await writeJson(join(target,'meta.json'),sealed);
  return sealed;
}

/** A sealed recording from screenshots, in their order, each held still for `holdMs` at 30 fps (as
 * if the person stopped scrolling on each). The pixels are the screenshots' RGBA, kept losslessly.
 * Not a share that happened: the movement between the screenshots is missing. */
export async function importImagesRecording(root:string,imagePaths:readonly string[],newIdValue:string,source:RecordingSource,holdMs=1000):Promise<RecordingMeta> {
  const newId=recordingIdentifier(newIdValue);
  const target=join(root,newId);
  if(!imagePaths.length)throw Error('No images.');
  if(existsSync(join(target,'meta.json')))throw Error('Recording already exists.');
  const run=(args:string[])=>new Promise<string>((done,reject)=>{
    const child=spawn(ffmpeg(),['-hide_banner',...args]);let log='';
    child.stderr.on('data',chunk=>{log+=chunk;});
    child.on('error',reject);child.on('close',value=>value===0?done(log):reject(Error(`ffmpeg exit ${value}: ${log.slice(-400)}`)));
  });
  let width=0,height=0;
  for(const path of imagePaths){
    const probe=await run(['-i',path,'-f','null','-frames:v','1','-']);
    const size=/Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(probe);
    if(!size)throw Error(`Not an image: ${path}`);
    if(width&&(Number(size[1])!==width||Number(size[2])!==height))throw Error('All images must have the same size.');
    width=Number(size[1]);height=Number(size[2]);
  }
  if(width>MAX_SIDE||height>MAX_SIDE)throw Error('Unsupported image size.');
  const perImage=Math.max(1,Math.round(holdMs/1000*30)),frames=perImage*imagePaths.length;
  await mkdir(target,{recursive:true});
  // Each image as a looping 30 fps input cut to exactly `perImage` frames, then joined in order.
  const inputs=imagePaths.flatMap(path=>['-loop','1','-framerate','30','-i',path]);
  const graph=imagePaths.map((_,index)=>`[${index}:v]trim=end_frame=${perImage},setpts=PTS-STARTPTS[v${index}]`).join(';')
    +';'+imagePaths.map((_,index)=>`[v${index}]`).join('')+`concat=n=${imagePaths.length}:v=1:a=0[out]`;
  await run(['-loglevel','error','-y',...inputs,'-filter_complex',graph,'-map','[out]','-frames:v',String(frames),'-fps_mode','passthrough',
    ...codecFor('rgba').args,join(target,'frames.mkv')]);
  const time=(seq:number)=>Math.round(seq*1000/30*1000)/1000;
  await writeFile(join(target,'frames.jsonl'),Array.from({length:frames},(_,seq)=>JSON.stringify({seq,mediaTimeMs:time(seq),deliveredAtMs:time(seq),receivedAtMs:Math.round(time(seq))})).join('\n')+'\n');
  const meta:RecordingMeta&{source:RecordingSource}={version:2,id:newId,startedAt:new Date().toISOString(),width,height,pixelFormat:'rgba',
    colorSpace:{primaries:'bt709',transfer:'iec61966-2-1',matrix:'rgb',fullRange:true},codec:'utvideo',status:'open',frames,complete:false,
    sha256:null,sealedAt:null,note:null,environment:null,source};
  await writeJson(join(target,'meta.json'),meta);
  let decoded=0;
  for await(const item of readRecordingFrames(root,newId)){void item;decoded++;}
  if(decoded!==frames)throw Error(`imported ${decoded} frames, expected ${frames}`);
  const sealed:RecordingMeta&{source:RecordingSource}={...meta,status:'sealed',complete:true,sha256:await fileHash(join(target,'frames.mkv')),
    sealedAt:new Date().toISOString(),
    note:`imported from ${imagePaths.length} screenshots (${source.name}${source.corpusCase?`, corpus case ${source.corpusCase.slice(0,12)}`:''}), each held still for ${perImage} frames at 30 fps; not a share that happened (no scrolling between them)`};
  await writeJson(join(target,'meta.json'),sealed);
  return sealed;
}
