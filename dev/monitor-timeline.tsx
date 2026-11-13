/** Development only (docs/dev-recording.md, "진행 창 자동 점검"). Plays the progress window states
 * a row-live replay kept (its report's monitorTimeline) through the app's own ScanMonitorPanel, at
 * the progress window's width, and measures what a person would see move:
 *   /dev/monitor-timeline.html?id=<recording>&run=<run file>[&width=340][&at=<entry>]
 * Without `at`, every entry is drawn in turn and the page reports, in window.__monitorLayout and on
 * the page, how far each part of the window moved and whether any text overflowed. With `at`, that
 * one entry is drawn (for a screenshot). */
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ScanMonitorPanel} from '../src/features/card-scanner/ui/ScanMonitor';
import styles from '../src/features/card-scanner/scan-monitor.css?inline';
import type {MonitorTimelineEntry} from './monitor-timeline';

const query=new URLSearchParams(location.search);
const id=query.get('id')??'',run=query.get('run')??'',width=Number(query.get('width')??340),at=query.get('at');
// fill=1: drawn as in the separate progress window (the page itself is the window: open it in a frame of the window's size).
const fill=query.get('fill')==='1';
const style=document.createElement('style');style.textContent=styles;document.head.append(style);
const host=document.getElementById('root')!;
host.style.width=fill?'100%':`${width}px`;
if(fill)document.body.style.overflow='hidden';
const panel=document.createElement('div');host.append(panel);
const out=document.createElement('pre');if(fill)out.style.display='none';out.style.cssText='white-space:pre-wrap;font-size:11px;padding:8px';document.body.append(out);
const root=createRoot(panel);

/** The parts of the window whose place a person follows. */
const PARTS=['.monitor-action','.monitor-pending','.monitor-total','.monitor-breakdown','.monitor-progress-slot','.monitor-list-bar','.monitor-list-legend','footer'];

function draw(entry:MonitorTimelineEntry){
  flushSync(()=>root.render(<ScanMonitorPanel state={entry.monitor} busy={entry.busy} sharing={entry.sharing} onStop={()=>{}} fill={fill}/>));
}

async function main(){
  if(!id||!run){out.textContent='?id=<recording>&run=<run file> 가 필요합니다.';return;}
  const report=await (await fetch(`/__rec/${encodeURIComponent(id)}/runs/${encodeURIComponent(run)}`)).json() as {monitorTimeline?:{entries:MonitorTimelineEntry[]}};
  const entries=report.monitorTimeline?.entries??[];
  if(!entries.length){out.textContent='이 실행에는 진행 창 기록이 없습니다.';return;}
  if(at!==null){const entry=entries[Math.max(0,Math.min(entries.length-1,Number(at)))];draw(entry);
    out.textContent=`${Number(at)}/${entries.length} · ${entry.t} ms · ${entry.phase}`;return;}
  // Per part and per phase group (sharing, after the share): the range of its top and height.
  const ranges=new Map<string,{top:[number,number];height:[number,number];seen:number}>();
  const overflow:string[]=[],places=new Map<string,number>();
  let legendLines=new Set<number>();
  for(const [index,entry] of entries.entries()){
    draw(entry);
    const group=entry.sharing?'sharing':'after';
    for(const selector of PARTS){
      const element=panel.querySelector(selector);if(!element)continue;
      const box=element.getBoundingClientRect(),key=`${group} ${selector}`;
      const range=ranges.get(key)??{top:[Infinity,-Infinity],height:[Infinity,-Infinity],seen:0};
      range.top=[Math.min(range.top[0],box.top),Math.max(range.top[1],box.top)];
      range.height=[Math.min(range.height[0],box.height),Math.max(range.height[1],box.height)];
      range.seen++;ranges.set(key,range);
      // The first entry at each place, to find what moved a part.
      const placeKey=`${key} @${Math.round(box.top)}`;if(!places.has(placeKey))places.set(placeKey,index);
    }
    legendLines.add(panel.querySelectorAll('.monitor-list-legend p').length);
    for(const element of panel.querySelectorAll<HTMLElement>('.scan-monitor *')){
      if(element.scrollWidth>element.clientWidth+1&&getComputedStyle(element).overflow!=='visible'&&overflow.length<20)
        overflow.push(`${index}: ${element.className||element.tagName} ${element.scrollWidth}>${element.clientWidth}`);
    }
    const section=panel.querySelector('.scan-monitor') as HTMLElement|null;
    if(section&&section.scrollWidth>section.clientWidth+1&&overflow.length<20)overflow.push(`${index}: window wider than ${width}px (${section.scrollWidth})`);
  }
  const moves=[...ranges].map(([key,range])=>({part:key,entries:range.seen,
    topMove:Math.round(range.top[1]-range.top[0]),heightChange:Math.round(range.height[1]-range.height[0])}));
  const moved=new Set(moves.filter(move=>move.topMove>0).map(move=>move.part));
  const firstAt=Object.fromEntries([...places].filter(([key])=>moved.has(key.split(' @')[0])));
  const result={id,run,width,entries:entries.length,legendLineCounts:[...legendLines],moves,firstAt,overflow};
  (window as unknown as {__monitorLayout:unknown}).__monitorLayout=result;
  out.textContent=JSON.stringify(result,null,1);
}
void main().catch(error=>{out.textContent=String(error);(window as unknown as {__monitorLayout:unknown}).__monitorLayout={error:String(error)};});
