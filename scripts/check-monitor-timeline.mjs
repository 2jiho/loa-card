// Dev only (docs/dev-recording.md, "진행 창 자동 점검"): checks what the progress window showed
// during a row-live replay (the report's monitorTimeline) for the problems a person would see:
// a map that lags the scroll or flickers, rows that go back from read, an action line that
// flips back and forth, header bands that move, and an end state that contradicts the result.
//   node scripts/check-monitor-timeline.mjs <recording id> [run file] [--json]
// Exit code 1 when a check fails. Thresholds are for the display, not for recognition.
import fs from 'node:fs';
import path from 'node:path';

const args=process.argv.slice(2),json=args.includes('--json'),[id,runName]=args.filter(arg=>!arg.startsWith('--'));
if(!id){console.error('Usage: node scripts/check-monitor-timeline.mjs <recording id> [run file] [--json]');process.exit(2);}
const runs=path.join('fixtures/local/recordings',id,'runs');
const name=runName??fs.readdirSync(runs).filter(file=>file.startsWith('run-')).sort().reverse()
  .find(file=>JSON.parse(fs.readFileSync(path.join(runs,file),'utf8')).monitorTimeline);
if(!name){console.error(`no run with a monitor timeline in ${runs}`);process.exit(2);}
const report=JSON.parse(fs.readFileSync(path.join(runs,name),'utf8'));
const entries=report.monitorTimeline?.entries??[];
if(!entries.length){console.error('the run has no monitor timeline');process.exit(2);}

/** Limits a person notices. */
const LIMIT={greenLagMs:600,flipBackMs:2000,actionFlips:2,locatedFlips:2,doneRegressions:0,bandChanges:1};
const rowsOf=runs=>{const set=new Set();for(const run of runs??[])for(let row=run.from;row<=run.to;row++)set.add(row);return set;};
const checks=[];const check=(name,ok,detail)=>checks.push({name,ok,detail});

// 1. The map follows the scroll: a card row under the screen box is drawn read (or as a row to
//    show again) soon after it is first under the box.
// Rows holding cards: from the header as last read (before it is read, every row may hold cards).
const finalMap=[...entries].reverse().find(entry=>entry.map)?.map;
const cardRowsAtEnd=finalMap?(finalMap.emptyFrom??finalMap.lockedFrom??finalMap.totalRows):Infinity;
const firstOnScreen=new Map(),firstMarked=new Map();
for(const entry of entries){
  const map=entry.map;if(!map)continue;
  const cardRows=Math.min(cardRowsAtEnd,map.emptyFrom??map.lockedFrom??map.totalRows);
  if(entry.sharing&&map.currentRow!==null)
    for(let row=map.currentRow;row<Math.min(cardRows,map.currentRow+map.visibleRows);row++)if(!firstOnScreen.has(row))firstOnScreen.set(row,entry.t);
  const marked=rowsOf(map.done);for(const target of map.targets)if(target.kind!=='unseen')marked.add(target.row);
  for(const row of marked)if(!firstMarked.has(row))firstMarked.set(row,entry.t);
}
const lags=[...firstOnScreen].map(([row,t])=>({row,lag:firstMarked.has(row)?firstMarked.get(row)-t:null}));
const never=lags.filter(item=>item.lag===null).map(item=>item.row+1);
const late=lags.filter(item=>item.lag!==null&&item.lag>LIMIT.greenLagMs);
const sorted=lags.filter(item=>item.lag!==null).map(item=>Math.max(0,item.lag)).sort((a,b)=>a-b);
const p=q=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(q*sorted.length))]:null;
check('map follows the scroll',never.length===0&&late.length<=Math.ceil(lags.length*.1),
  `rows on screen ${lags.length}, never marked ${never.length}${never.length?` (${never.slice(0,12).join(',')})`:''}, over ${LIMIT.greenLagMs} ms ${late.length}, lag p50 ${p(.5)} ms p95 ${p(.95)} ms`);

// 2. A row drawn read does not go back to unmarked (it may become a row to show again).
let regressions=0;const regressed=[];
for(let index=1;index<entries.length;index++){
  const before=entries[index-1].map,now=entries[index].map,at=entries[index].t;if(!before||!now)continue;
  const wasDone=rowsOf(before.done),nowDone=rowsOf(now.done),targets=new Set(now.targets.map(target=>target.row));
  // Rows that turn out to be empty slots or locked once the header is read are not a step back.
  const bandFrom=now.emptyFrom??now.lockedFrom??Infinity;
  for(const row of wasDone)if(row<bandFrom&&!nowDone.has(row)&&!targets.has(row)){regressions++;if(regressed.length<10)regressed.push(`${row+1}@${at}`);}
}
check('read rows stay read',regressions<=LIMIT.doneRegressions,`${regressions} ${regressed.join(' ')}`);

// 3. Highlighted rows do not blink: a row that stops being a target and is one again soon after.
const flips=[];const lastOff=new Map();let previous=new Set();
for(const entry of entries){
  const now=new Set((entry.map?.targets??[]).filter(target=>target.kind!=='unseen').map(target=>target.row));
  for(const row of previous)if(!now.has(row))lastOff.set(row,entry.t);
  for(const row of now)if(!previous.has(row)&&lastOff.has(row)&&entry.t-lastOff.get(row)<LIMIT.flipBackMs)flips.push(`${row+1}@${entry.t}`);
  previous=now;
}
check('highlights do not blink',flips.length===0,`${flips.length} ${flips.slice(0,10).join(' ')}`);

// 4. The action line does not flip back within a moment (A -> B -> A).
const actionFlips=[];
for(let index=2;index<entries.length;index++){
  const [a,b,c]=[entries[index-2],entries[index-1],entries[index]];
  if(a.action===c.action&&a.action!==b.action&&c.t-a.t<LIMIT.flipBackMs)actionFlips.push(`${b.action}@${b.t}`);
}
check('action line is steady',actionFlips.length<=LIMIT.actionFlips,`${actionFlips.length} ${actionFlips.slice(0,6).join(' | ')}`);

// 5. "Show the card tab" does not flash while the tab is shown.
let locatedFlips=0;
for(let index=2;index<entries.length;index++)
  if(entries[index-2].located===true&&entries[index-1].located===false&&entries[index].located===true&&entries[index].sharing)locatedFlips++;
check('window found steadily',locatedFlips<=LIMIT.locatedFlips,`${locatedFlips} brief losses of the card window`);

// 6. The header bands appear once and stay; the list size stays.
const bands=new Set(entries.filter(entry=>entry.map&&entry.map.emptyFrom!==undefined).map(entry=>`${entry.map.emptyFrom}/${entry.map.lockedFrom}`));
const sizes=new Set(entries.filter(entry=>entry.map).map(entry=>entry.map.totalRows));
check('bands and list size are stable',bands.size<=LIMIT.bandChanges&&sizes.size<=1,`bands ${[...bands].join(' ')||'none'}, list sizes ${[...sizes].join(' ')}`);

// 7. The screen box does not spike: far away and straight back within 0.5 s is a misread scrollbar
//    (a real flick of the list goes somewhere and stays a while).
let jumps=0;const spikes=[];
for(let index=2;index<entries.length;index++){
  const [a,b,c]=[entries[index-2],entries[index-1],entries[index]];
  const ra=a.map?.currentRow,rb=b.map?.currentRow,rc=c.map?.currentRow;
  if(ra==null||rb==null||rc==null||c.t-a.t>500)continue;
  const far=2*b.map.visibleRows;
  if(Math.abs(rb-ra)>far&&Math.abs(rc-ra)<=1){jumps++;if(spikes.length<6)spikes.push(`${ra+1}>${rb+1}>${rc+1}@${b.t}`);}
}
check('screen box does not spike',jumps===0,`${jumps} ${spikes.join(' ')}`);

// 7b. Once every card of the displayed total is confirmed, no row is asked for and the action does
//     not say to keep scrolling.
const stale=entries.filter(entry=>entry.expected!==null&&entry.read===entry.expected&&entry.names===entry.expected&&
  ((entry.map?.targets.length??0)>0||entry.action==='목록을 천천히 끝까지 넘겨 주세요'||entry.action==='강조된 미확인 부분을 다시 비춰 주세요'));
check('nothing asked once all is confirmed',stale.length===0,`${stale.length} entries${stale.length?` from ${stale[0].t} ms (${stale[0].action}, ${stale[0].map?.targets.length??0} rows)`:''}`);

// 8. Counts only go up while sharing.
let countDrops=0;
for(let index=1;index<entries.length;index++)if(entries[index].read<entries[index-1].read)countDrops++;
check('confirmed count only goes up',countDrops===0,`${countDrops} drops`);

// 9. The end agrees with the result.
const last=entries[entries.length-1],lastMap=last.map;
const complete=last.expected!==null&&last.read===last.expected;
if(complete){
  const cardRows=lastMap?(lastMap.emptyFrom??lastMap.lockedFrom??lastMap.totalRows):0,done=rowsOf(lastMap?.done);
  const blank=[];for(let row=0;row<cardRows;row++)if(!done.has(row))blank.push(row+1);
  check('a complete scan ends clean',last.header==='판독 완료'&&(lastMap?.targets.length??0)===0&&blank.length===0,
    `header ${last.header}, targets ${lastMap?.targets.length??0}, card rows not drawn read ${blank.length}${blank.length?` (${blank.slice(0,12).join(',')})`:''}`);
}else check('an incomplete scan says where to look',(lastMap?.targets.length??0)>0||last.header!=='판독 완료',
  `read ${last.read}/${last.expected}, header ${last.header}, targets ${lastMap?.targets.length??0}`);

// 10. After the share, every card read carries its own picture from the screen (the card list shows it).
if(typeof last.pictures==='number')check('every card has a screen picture',last.pictures===last.names,`${last.pictures} of ${last.names} cards`);

const failed=checks.filter(item=>!item.ok);
if(json)console.log(JSON.stringify({id,run:name,entries:entries.length,dropped:report.monitorTimeline.dropped,checks},null,1));
else{
  console.log(`${id} · ${name} · ${entries.length} entries${report.monitorTimeline.dropped?` (${report.monitorTimeline.dropped} not kept)`:''}`);
  for(const item of checks)console.log(`${item.ok?'ok  ':'FAIL'} ${item.name}: ${item.detail}`);
}
process.exit(failed.length?1:0);
