import type {IncomingMessage,ServerResponse} from 'node:http';
import {mkdir,readFile,readdir,rename,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Plugin} from 'vite';
import {DEFAULT_RECORDING_ROOT,RecordingWriter,listRecordings,openRecordingDecoder,readRecordingLines,readRecordingMeta,recordingIdentifier,recoverRecording} from './recording-store.ts';
import type {RecordingStart} from './recording-store.ts';

/** Development/test only: HTTP front of the server-side recording store.
 * See docs/dev-recording.md. No security model; applies to `vite serve` only. */
export const RECORDING_PREFIX='/__rec';
const MAX_JSON_BYTES=1024*1024;
const MAX_RUN_BYTES=32*1024*1024;

export interface RecordingServerState {
  /** Open writers by id. A server restart leaves their recordings 'open'. */
  readonly writers:Map<string,{writer:RecordingWriter;queue:Promise<unknown>;next:number;waiting:Map<number,()=>void>;idle?:ReturnType<typeof setTimeout>}>;
  /** Seal a recording that received no frame for this long (page closed or crashed). */
  idleSealMs:number;
  /** How long a frame waits for the earlier sequence numbers before it is refused. */
  sequenceWaitMs:number;
}
/** Frames arrive only while the scanner sees the card window, so a quiet spell
 * of a few minutes is normal; the idle seal is only for pages that vanished. */
export function createRecordingServerState(idleSealMs=10*60_000,sequenceWaitMs=15_000):RecordingServerState {return {writers:new Map(),idleSealMs,sequenceWaitMs};}

function touch(state:RecordingServerState,id:string):void {
  const open=state.writers.get(id);if(!open)return;
  if(open.idle)clearTimeout(open.idle);
  open.idle=setTimeout(()=>{
    const current=state.writers.get(id);if(!current||current!==open)return;
    void current.queue.then(()=>current.writer.seal('sealed by the server: no frames for '+state.idleSealMs/1000+' s (page closed or crashed)'))
      .catch(()=>undefined).finally(()=>{if(state.writers.get(id)===current)state.writers.delete(id);});
  },state.idleSealMs);
  open.idle.unref?.();
}

async function readBody(request:IncomingMessage,limit:number):Promise<Buffer> {
  const parts:Buffer[]=[];let bytes=0;
  for await(const chunk of request){
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);
    bytes+=buffer.byteLength;
    if(bytes>limit)throw Object.assign(Error('payload too large'),{status:413});
    parts.push(buffer);
  }
  return Buffer.concat(parts);
}
function json(response:ServerResponse,status:number,value:unknown):void {
  response.statusCode=status;response.setHeader('Content-Type','application/json; charset=utf-8');
  response.setHeader('Cache-Control','no-store');response.end(JSON.stringify(value));
}
function header(request:IncomingMessage,name:string):string|undefined {
  const value=request.headers[name];return Array.isArray(value)?value[0]:value;
}
function number(value:string|undefined):number|null {
  if(value===undefined||value==='')return null;
  const parsed=Number(value);return Number.isFinite(parsed)?parsed:Number.NaN;
}

export async function serveRecording(request:IncomingMessage,response:ServerResponse,state:RecordingServerState,
  root=DEFAULT_RECORDING_ROOT):Promise<boolean> {
  const url=new URL(request.url??'/','http://local');
  if(!url.pathname.startsWith(RECORDING_PREFIX))return false;
  const route=url.pathname.slice(RECORDING_PREFIX.length).split('/').filter(Boolean);
  try{
    if(route.length===0){
      if(request.method!=='GET'){json(response,405,{error:'GET only.'});return true;}
      json(response,200,{recordings:await listRecordings(root)});return true;
    }
    const id=recordingIdentifier(route[0]);
    const action=route[1]??'';
    if(route.length===1||action==='meta'){
      if(request.method!=='GET'){json(response,405,{error:'GET only.'});return true;}
      const meta=await readRecordingMeta(root,id);
      if(!meta){json(response,404,{error:'Unknown recording.'});return true;}
      json(response,200,{...meta,live:state.writers.has(id)});return true;
    }
    if(action==='start'){
      if(request.method!=='PUT'){json(response,405,{error:'PUT only.'});return true;}
      const input=JSON.parse((await readBody(request,MAX_JSON_BYTES)).toString('utf8')) as Partial<RecordingStart>;
      if(state.writers.has(id)){json(response,409,{error:'Recording is already open.'});return true;}
      const writer=await RecordingWriter.start(root,id,{width:Number(input.width),height:Number(input.height),
        ...(input.pixelFormat===undefined?{}:{pixelFormat:input.pixelFormat}),colorSpace:input.colorSpace??null,environment:input.environment??null});
      state.writers.set(id,{writer,queue:Promise.resolve(),next:0,waiting:new Map()});touch(state,id);
      json(response,200,{ok:true,frameBytes:writer.frameBytes,pixelFormat:writer.pixelFormat});return true;
    }
    if(action==='frame'){
      if(request.method!=='POST'){json(response,405,{error:'POST only.'});return true;}
      const open=state.writers.get(id);
      if(!open){json(response,404,{error:'Recording is not open.'});return true;}
      const data=await readBody(request,open.writer.frameBytes);
      const deliveredAtMs=number(header(request,'x-delivered-at-ms'));
      const mediaTimeMs=number(header(request,'x-media-time-ms'));
      if(deliveredAtMs===null||Number.isNaN(deliveredAtMs)||Number.isNaN(mediaTimeMs)){json(response,400,{error:'Invalid frame timing.'});return true;}
      // Frames from one session are written strictly in arrival order.
      // Frames may be uploaded concurrently. With x-seq they are still written
      // strictly in sequence order; without it, in arrival order.
      const claimed=number(header(request,'x-seq'));
      if(claimed!==null&&(!Number.isSafeInteger(claimed)||claimed<open.next)){json(response,400,{error:'Invalid or repeated frame sequence.'});return true;}
      if(claimed!==null&&claimed>open.next){
        // An earlier frame that never arrives (its upload failed) must not hold later frames,
        // and their bodies, forever.
        const arrived=await new Promise<boolean>(resolve=>{
          const timer=setTimeout(()=>{open.waiting.delete(claimed);resolve(false);},state.sequenceWaitMs);
          open.waiting.set(claimed,()=>{clearTimeout(timer);resolve(true);});
        });
        if(!arrived){json(response,409,{error:'An earlier frame never arrived.'});return true;}
      }
      const task=open.queue.then(()=>open.writer.writeFrame(data,{mediaTimeMs,deliveredAtMs}));
      open.queue=task.catch(()=>undefined);
      open.next=(claimed??open.next)+1;touch(state,id);
      open.waiting.get(open.next)?.();open.waiting.delete(open.next);
      try{json(response,200,{seq:await task});}
      catch(error){json(response,400,{error:error instanceof Error?error.message:'Frame rejected.'});}
      return true;
    }
    if(action==='seal'){
      if(request.method!=='POST'){json(response,405,{error:'POST only.'});return true;}
      const open=state.writers.get(id);
      if(!open){
        // No live writer: an unsealed recording left by a restart or crash.
        const meta=await readRecordingMeta(root,id);
        if(!meta){json(response,404,{error:'Unknown recording.'});return true;}
        json(response,200,await recoverRecording(root,id));return true;
      }
      if(open.idle)clearTimeout(open.idle);
      await open.queue;
      // Optional {note} from the recorder, e.g. frames it had to skip.
      let note:string|null=null;
      try{
        const text=(await readBody(request,MAX_JSON_BYTES)).toString('utf8');
        if(text){const parsed=JSON.parse(text) as {note?:unknown};if(typeof parsed.note==='string')note=parsed.note.slice(0,2000);}
      }catch{/* A seal without a readable note is still a seal. */}
      const meta=await open.writer.seal(note);
      state.writers.delete(id);
      json(response,200,meta);return true;
    }
    if(action==='runs'){
      // Replay run reports live next to the recording they ran on, so the same
      // input can be compared across code versions.
      const directory=join(root,id,'runs');
      if(!await readRecordingMeta(root,id)){json(response,404,{error:'Unknown recording.'});return true;}
      if(request.method==='PUT'&&route[2]==='live'){
        // The live scan's own result, overwritten as the scan goes (and kept if
        // the page dies), so it can be compared with replays of this recording.
        const text=(await readBody(request,MAX_RUN_BYTES)).toString('utf8');
        try{JSON.parse(text);}catch{json(response,400,{error:'Invalid JSON.'});return true;}
        await mkdir(directory,{recursive:true});
        const temporary=join(directory,'.run-live.tmp');
        await writeFile(temporary,text);
        await rename(temporary,join(directory,'run-live.json'));
        json(response,200,{name:'run-live.json'});return true;
      }
      if(request.method==='POST'){
        const text=(await readBody(request,MAX_RUN_BYTES)).toString('utf8');
        try{JSON.parse(text);}catch{json(response,400,{error:'Invalid JSON.'});return true;}
        await mkdir(directory,{recursive:true});
        const name=`run-${new Date().toISOString().replace(/[-:.]/g,'').replace('T','-').replace('Z','')}-${Math.floor(Math.random()*0x10000).toString(16).padStart(4,'0')}.json`;
        await writeFile(join(directory,name),text);
        json(response,200,{name});return true;
      }
      if(request.method!=='GET'){json(response,405,{error:'GET or POST only.'});return true;}
      const name=route[2];
      if(name!==undefined){
        if(!/^run-[A-Za-z0-9-]{1,64}\.json$/.test(name)){json(response,400,{error:'Invalid run name.'});return true;}
        try{response.statusCode=200;response.setHeader('Content-Type','application/json; charset=utf-8');response.end(await readFile(join(directory,name)));}
        catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){response.statusCode=404;response.end('{"error":"Unknown run."}');}else throw error;}
        return true;
      }
      let names:string[]=[];
      try{names=(await readdir(directory)).filter(entry=>/^run-[A-Za-z0-9-]{1,64}\.json$/.test(entry)).sort();}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const runs=[];
      for(const entry of names){
        let summary:unknown=null;
        try{summary=(JSON.parse(await readFile(join(directory,entry),'utf8')) as {summary?:unknown}).summary??null;}catch{/* Listing only. */}
        runs.push({name:entry,bytes:(await stat(join(directory,entry))).size,summary});
      }
      json(response,200,{runs});return true;
    }
    if(action==='lines'){
      if(request.method!=='GET'){json(response,405,{error:'GET only.'});return true;}
      if(!await readRecordingMeta(root,id)){json(response,404,{error:'Unknown recording.'});return true;}
      json(response,200,{lines:await readRecordingLines(root,id)});return true;
    }
    if(action==='frames'){
      if(request.method!=='GET'){json(response,405,{error:'GET only.'});return true;}
      const meta=await readRecordingMeta(root,id);
      if(!meta){json(response,404,{error:'Unknown recording.'});return true;}
      const from=Math.max(0,Math.floor(number(url.searchParams.get('from')??undefined)??0));
      const decoder=await openRecordingDecoder(root,id,{from});
      response.on('close',()=>decoder.kill());
      response.statusCode=200;
      response.setHeader('Content-Type','application/octet-stream');
      response.setHeader('X-Frame-Bytes',String(decoder.frameBytes));
      response.setHeader('X-Pixel-Format',decoder.pixelFormat);
      response.setHeader('X-Frame-Width',String(decoder.width));response.setHeader('X-Frame-Height',String(decoder.height));
      response.setHeader('Cache-Control','no-store');
      // The decoder's output goes straight to the client; it assembles frames.
      decoder.stream.pipe(response);
      return true;
    }
    json(response,404,{error:'Unknown recording route.'});return true;
  }catch(error){
    const status=(error as {status?:number}).status;
    if(response.headersSent){response.destroy();return true;}
    json(response,typeof status==='number'?status:error instanceof Error&&/Invalid|exists/.test(error.message)?400:500,
      {error:error instanceof Error?error.message:'Recording failed.'});
    return true;
  }
}

export function recordingPlugin(root=DEFAULT_RECORDING_ROOT):Plugin {
  const state=createRecordingServerState();
  return {
    name:'loacard-recording',
    apply:'serve',
    configureServer(server){
      server.middlewares.use((request,response,next)=>{
        void serveRecording(request,response,state,root).then(handled=>{if(!handled)next();}).catch(()=>response.destroy());
      });
    },
  };
}
