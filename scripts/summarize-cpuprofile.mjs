// Summarize a .cpuprofile (Chrome DevTools, or scripts/run-recording-replay.mjs --cpuprofile):
// where the sampled thread's time went, by source file and by function (self time).
// Usage: node scripts/summarize-cpuprofile.mjs <file.cpuprofile> [--top 30]
import {readFileSync} from 'node:fs';
const file=process.argv[2],topIndex=process.argv.indexOf('--top'),top=topIndex>0?Number(process.argv[topIndex+1]):30;
if(!file){console.error('usage: node scripts/summarize-cpuprofile.mjs <file.cpuprofile> [--top 30]');process.exit(2);}
const profile=JSON.parse(readFileSync(file,'utf8'));
const nodes=new Map(profile.nodes.map(node=>[node.id,node]));
const self=new Map();
// Each sample's time is the delta that precedes the next one.
profile.samples.forEach((id,index)=>self.set(id,(self.get(id)??0)+(profile.timeDeltas[index+1]??0)/1000));
const total=(profile.endTime-profile.startTime)/1000;
const short=url=>url.replace(/^https?:\/\/[^/]+\//,'').replace(/\?.*$/,'')||'(native)';
const byFunction=new Map(),byFile=new Map();
for(const [id,ms] of self){
  const frame=nodes.get(id).callFrame;
  const name=`${frame.functionName||'(anonymous)'} ${short(frame.url)}${frame.url&&frame.lineNumber>=0?`:${frame.lineNumber+1}`:''}`;
  byFunction.set(name,(byFunction.get(name)??0)+ms);
  const group=frame.url?short(frame.url):frame.functionName||'(native)';
  byFile.set(group,(byFile.get(group)??0)+ms);
}
const print=(title,map,count)=>{
  console.log(`\n${title}`);
  for(const [name,ms] of [...map].sort((a,b)=>b[1]-a[1]).slice(0,count))
    console.log(`${ms.toFixed(0).padStart(7)}ms ${(ms/total*100).toFixed(1).padStart(5)}%  ${name}`);
};
// --callers <function name>: that function's self time split by its two nearest callers.
const callersIndex=process.argv.indexOf('--callers');
if(callersIndex>0){
  const wanted=process.argv[callersIndex+1],parent=new Map(),byCaller=new Map();
  for(const node of profile.nodes)for(const child of node.children??[])parent.set(child,node.id);
  const label=id=>{const frame=nodes.get(id)?.callFrame;return frame?`${frame.functionName||'(anonymous)'} ${short(frame.url)}${frame.url?`:${frame.lineNumber+1}`:''}`:'(root)';};
  for(const [id,ms] of self){
    if(nodes.get(id).callFrame.functionName!==wanted)continue;
    const first=parent.get(id),second=first===undefined?undefined:parent.get(first);
    const key=`${label(first)}  <-  ${label(second)}`;
    byCaller.set(key,(byCaller.get(key)??0)+ms);
  }
  console.log(`${file}: ${total.toFixed(0)}ms`);
  print(`callers of ${wanted} (self time of ${wanted})`,byCaller,top);
  process.exit(0);
}
console.log(`${file}: ${total.toFixed(0)}ms, ${profile.samples.length} samples`);
print('by source file or engine bucket (self time)',byFile,20);
print(`by function (self time), top ${top}`,byFunction,top);
