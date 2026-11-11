// Run a saved share recording through the replay page in a HEADLESS Chrome/Edge and wait for
// its report (docs/dev-recording.md). The replay page of the dev server does the work and saves
// the report next to the recording; this script only opens it and waits.
//
// A headless browser page counts as visible, so rendering, timers and the live video pipeline run
// at full speed. A page in a hidden or covered window is throttled (rAF ~1/s), which makes the
// live-path modes unfaithful; use this runner for those.
//
// Usage:
//   node scripts/run-recording-replay.mjs --id <recording-id> [--id <id2> ...] [--mode sequential|realtime|realtime-detailed]
//        [--port 5199] [--timeout 600] [--browser <path to chrome or edge>] [--log <file>] [--until <seconds>] [--json]
// Modes: skip:mean=1,block=6,force=8 (sequential replay that leaves out frames similar to the last processed one; experiment),
//        sequential (default, deterministic), realtime (live path, recording off = deployed app),
//        realtime-detailed (live path with the detailed input recording on = development default).
import {spawn,spawnSync} from 'node:child_process';
import {closeSync,existsSync,mkdtempSync,openSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const args=process.argv.slice(2);
const values=(name)=>args.flatMap((value,index)=>value===name&&args[index+1]?[args[index+1]]:[]);
const value=(name,fallback)=>values(name)[0]??fallback;
const ids=values('--id'),mode=value('--mode','sequential'),port=Number(value('--port','5199')),timeoutSec=Number(value('--timeout','600'));
const asJson=args.includes('--json');
const until=value('--until',null); // end the share after this recorded time (seconds): a share that stops while the card window is still shown
const logFile=value('--log',null); // browser console and error output, for diagnosing a failed run
if(!ids.length){console.error('usage: node scripts/run-recording-replay.mjs --id <recording-id> [--mode sequential|realtime|realtime-detailed]');process.exit(2);}
if(!['sequential','realtime','realtime-detailed'].includes(mode)&&!mode.startsWith('skip:')){console.error(`unknown mode: ${mode}`);process.exit(2);}

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
function killTree(child) {
  try{
    if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
    else child.kill('SIGKILL');
  }catch{/* Already gone. */}
}

async function runOne(id) {
  const before=new Set(await runNames(id));
  const profile=mkdtempSync(join(tmpdir(),'loa-replay-'));
  const url=`${base}/dev/recording.html?autorun=${encodeURIComponent(id)}&mode=${encodeURIComponent(mode)}${until?`&until=${encodeURIComponent(until)}`:''}`;
  const logFd=logFile?openSync(logFile,'w'):null;
  const child=spawn(browser,['--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required','--window-size=1600,1000','--disable-background-timer-throttling',
    '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--mute-audio',
    ...(logFd!==null?['--enable-logging=stderr','--v=0']:[]),url],{stdio:logFd!==null?['ignore','ignore',logFd]:'ignore'});
  const started=Date.now();
  let name;
  try{
    while(Date.now()-started<timeoutSec*1000){
      await sleep(2000);
      const now=await runNames(id);
      name=now.find(entry=>!before.has(entry));
      if(name)break;
    }
  }finally{killTree(child);await sleep(500);if(logFd!==null)closeSync(logFd);try{rmSync(profile,{recursive:true,force:true});}catch{/* Profile still in use. */}}
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
