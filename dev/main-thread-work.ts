/** Development-only Long Tasks samples. Not CPU time or proof of pixel loss. */
export function createMainThreadWork(startedAtMs:number,limit=256) {
  const samples:{startTime:number;duration:number}[]=[];
  let count=0,totalMs=0,maxMs=0,omitted=0;
  return {
    add(entries:readonly {startTime:number;duration:number}[]) {
      for(const e of entries) {
        if(!Number.isFinite(e.startTime)||e.startTime<startedAtMs||!Number.isFinite(e.duration)||e.duration<50)continue;
        count++;totalMs+=e.duration;maxMs=Math.max(maxMs,e.duration);
        if(samples.length<limit)samples.push({startTime:e.startTime,duration:e.duration});else omitted++;
      }
    },
    snapshot(){return {clock:'page-performance-now',startedAtMs,count,totalMs,maxMs:count?maxMs:null,
      samples:samples.map(e=>({...e})),omitted,sampleLimit:limit,
      scope:'Page long tasks >=50ms; elapsed task duration, not CPU time, worker work or pixel delivery proof.'};},
  };
}

export function observeMainThreadWork() {
  const result=createMainThreadWork(performance.now());
  let observer:PerformanceObserver|undefined,closed=false,status:'observing'|'unsupported'|'failed'='unsupported';
  try {
    if(typeof PerformanceObserver!=='undefined'&&PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      observer=new PerformanceObserver(list=>{if(!closed)result.add(list.getEntries());});
      observer.observe({type:'longtask',buffered:false});status='observing';
    }
  } catch {observer?.disconnect();status='failed';}
  return {stop(){
    if(!closed){if(status==='observing')result.add(observer!.takeRecords());observer?.disconnect();closed=true;}
    return {...result.snapshot(),status:status==='observing'?'measured':status};
  }};
}
