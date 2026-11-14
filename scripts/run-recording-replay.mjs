// Run a saved share recording through the replay page in a HEADLESS Chrome/Edge and wait for
// its report (docs/dev-recording.md). The replay page of the dev server does the work and saves
// the report next to the recording; this script only opens it and waits.
//
// A headless browser page counts as visible, so rendering, timers and the live video pipeline run
// at full speed. A page in a hidden or covered window is throttled (rAF ~1/s), which makes the
// live-path modes unfaithful; use this runner for those.
//
// Usage:
//   node scripts/run-recording-replay.mjs --id <recording-id> [--id <id2> ...] [--mode rowlive|realtime|...]
//        [--port 5173] [--timeout 600] [--browser <path to chrome or edge>] [--log <file>] [--until <seconds>] [--json] [--cpuprofile <file.cpuprofile>] [--query "name=value"]
// --cpuprofile: CPU profiles of the sharing phase (realtime, one --id): the main thread in <file>, and
//        each worker in <file minus .cpuprofile>.<worker script>-<n>.cpuprofile. Open them in
//        Chrome DevTools or summarize it with scripts/summarize-cpuprofile.mjs.
// Modes: realtime (the app's scan, runScanner, on the recording at its own pace),
//        lean (prototype measurement of the acquisition and visual workers alone; not a scan),
//        rows (per-frame row observations for the row-centred design feasibility measurement; not a scan),
//        rowread (row-centred reading prototype: reads only the rows the list table lacks; not a scan),
//        rowlight (rowread with a light per-frame check that skips frames needing nothing; not a scan),
//        rowlive (default: the row-centred scan run directly at the recording's pace, with the
//        progress window's timeline in the report),
//        artfail (the artwork matcher's own numbers for the crops it rejects; not a scan),
//        gridfit (grid measurement: the client border outline laid over every visible card; needs the private work/ extracts),
//        cardmap (card layout measurement: crops lined up with the client border and stacked; needs the private work/ extracts).
import {spawn,spawnSync} from 'node:child_process';
import {closeSync,existsSync,mkdtempSync,openSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const args=process.argv.slice(2);
const values=(name)=>args.flatMap((value,index)=>value===name&&args[index+1]?[args[index+1]]:[]);
const value=(name,fallback)=>values(name)[0]??fallback;
const ids=values('--id'),mode=value('--mode','rowlive'),port=Number(value('--port','5173')),timeoutSec=Number(value('--timeout','600'));
const asJson=args.includes('--json');
const until=value('--until',null); // end the share after this recorded time (seconds): a share that stops while the card window is still shown
const extraQuery=value('--query',null); // extra page parameters for experiments, e.g. "rescue=direct"
const cpuProfile=value('--cpuprofile',null),debugPort=Number(value('--debug-port','9339'));
const logFile=value('--log',null); // browser console and error output, for diagnosing a failed run
const MODES=['rowlive','realtime','lean','rows','rowread','rowlight','cardmap','gridfit','artfail'];
if(!ids.length){console.error(`usage: node scripts/run-recording-replay.mjs --id <recording-id> [--mode ${MODES.join('|')}] [--port 5173]`);process.exit(2);}
if(!MODES.includes(mode)){console.error(`unknown mode: ${mode}`);process.exit(2);}

function findBrowser() {
  const explicit=value('--browser',process.env.CHROME_PATH);
  if(explicit)return explicit;
  const candidates=[
    'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find(path=>existsSync(path));
}
const browser=findBrowser();
if(!browser){console.error('Chrome or Edge not found; pass --browser <path> or set CHROME_PATH.');process.exit(2);}

const base=`http://127.0.0.1:${port}`;
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
async function runNames(id) {
  const response=await fetch(`${base}/__rec/${encodeURIComponent(id)}/runs`);
  if(!response.ok)throw Error(`recording ${id}: HTTP ${response.status}`);
  return ((await response.json()).runs).map(run=>run.name).filter(name=>/^run-2/.test(name));
}
/** Attach to the page over the DevTools protocol, enable the sampling profiler, let the page start,
 * and save the profile the page brackets with console.profile('share') / console.profileEnd('share'). */
async function collectProfile(file) {
  let target;
  for(let attempt=0;attempt<100&&!target;attempt++){
    try{target=(await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(item=>item.type==='page'&&item.url.includes('/dev/recording.html'));}catch{/* Browser still starting. */}
    if(!target)await sleep(100);
  }
  if(!target)throw Error('could not attach to the replay page for profiling');
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=()=>reject(Error('DevTools connection failed'));});
  let next=0;const waiting=new Map();
  const send=(method,params={},sessionId)=>new Promise(resolve=>{const id=++next;waiting.set(id,resolve);socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  // Workers are separate targets. Each one is profiled over the same span as the page:
  // from the page's console.profile('share') to its console.profileEnd('share').
  const workers=new Map();let sharing=false;
  const workerName=url=>(url.split('/').pop()??'worker').split('?')[0].replace(/\.[a-z]+$/,'');
  const startWorker=async sessionId=>{await send('Profiler.enable',{},sessionId);await send('Profiler.setSamplingInterval',{interval:500},sessionId);await send('Profiler.start',{},sessionId);};
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.id&&waiting.has(message.id)){waiting.get(message.id)(message.result);waiting.delete(message.id);}
    if(message.method==='Target.attachedToTarget'&&message.params.targetInfo.type==='worker'){
      workers.set(message.params.sessionId,message.params.targetInfo.url);
      if(sharing)void startWorker(message.params.sessionId);
    }
    if(message.method==='Target.detachedFromTarget')workers.delete(message.params.sessionId);
    if(message.method==='Profiler.consoleProfileStarted'&&!message.sessionId){sharing=true;for(const sessionId of workers.keys())void startWorker(sessionId);}
    if(message.method==='Profiler.consoleProfileFinished'&&!message.sessionId){
      sharing=false;
      writeFileSync(file,JSON.stringify(message.params.profile));console.error(`cpu profile saved: ${file}`);
      const counts=new Map();
      for(const [sessionId,url] of workers)void send('Profiler.stop',{},sessionId).then(result=>{
        if(!result?.profile)return;
        const name=workerName(url),index=(counts.get(name)??0)+1;counts.set(name,index);
        const out=`${file.endsWith('.cpuprofile')?file.slice(0,-11):file}.${name}-${index}.cpuprofile`;
        writeFileSync(out,JSON.stringify(result.profile));console.error(`cpu profile saved: ${out}`);
      });
    }
  };
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:500});
  await send('Runtime.evaluate',{expression:'window.__profilerReady=true'});
  return ()=>socket.close();
}
function killTree(child) {
  try{
    if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
    else child.kill('SIGKILL');
  }catch{/* Already gone. */}
}

async function runOne(id) {
  const before=new Set(await runNames(id));
  const profile=mkdtempSync(join(tmpdir(),'loa-replay-'));
  const url=`${base}/dev/recording.html?autorun=${encodeURIComponent(id)}&mode=${encodeURIComponent(mode)}${until?`&until=${encodeURIComponent(until)}`:''}${cpuProfile?'&profile=1':''}${extraQuery?`&${extraQuery}`:''}`;
  const logFd=logFile?openSync(logFile,'w'):null;
  const child=spawn(browser,['--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required','--window-size=1600,1000','--disable-background-timer-throttling',
    '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--mute-audio',
    ...(cpuProfile?[`--remote-debugging-port=${debugPort}`]:[]),...(logFd!==null?['--enable-logging=stderr','--v=0']:[]),url],{stdio:logFd!==null?['ignore','ignore',logFd]:'ignore'});
  const started=Date.now();
  let name,closeProfile;
  try{
    if(cpuProfile)closeProfile=await collectProfile(cpuProfile);
    while(Date.now()-started<timeoutSec*1000){
      await sleep(2000);
      const now=await runNames(id);
      name=now.find(entry=>!before.has(entry));
      if(name)break;
    }
  }finally{closeProfile?.();killTree(child);await sleep(500);if(logFd!==null)closeSync(logFd);try{rmSync(profile,{recursive:true,force:true});}catch{/* Profile still in use. */}}
  if(!name)throw Error(`no report appeared within ${timeoutSec}s (${id}, ${mode})`);
  const report=await (await fetch(`${base}/__rec/${encodeURIComponent(id)}/runs/${name}`)).json();
  if(report.kind==='recording-replay-failure')
    throw Error(`replay failed (${id}, ${mode}): ${report.error} · last progress: ${String(report.lastProgress).split('\n').join(' | ')}`);
  return {id,name,seconds:Math.round((Date.now()-started)/1000),report};
}

for(const id of ids){
  const result=await runOne(id),{report}=result,summary=report.summary,delivery=report.delivery;
  if(asJson){console.log(JSON.stringify({id,run:result.name,seconds:result.seconds,summary,delivery,status:report.status,cards:report.cards.length,liveReplay:report.liveReplay?.recordingMode??null}));continue;}
  console.log(`${id.slice(-8)} · ${mode} · ${result.name} · ${result.seconds}s`);
  console.log(`  cards ${report.cards.length} · read ${summary.read}/${summary.expected??'?'} · ${report.status.slice(0,70)}`);
  if(delivery&&delivery.mode!=='sequential')console.log(`  delivery: ${delivery.frames}/${delivery.declaredFrames} frames, late mean ${Math.round(delivery.meanLateMs)}ms max ${Math.round(delivery.maxLateMs)}ms, >33ms ${delivery.lateOver33Ms} · ${summary.faithful?'faithful':'NOT faithful'}`);
}
