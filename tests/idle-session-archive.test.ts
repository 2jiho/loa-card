import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIdleSessionArchive} from '../dev/idle-session-archive';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const eventually=async(check:()=>boolean)=>{for(let n=0;n<100;n++){if(check())return;await sleep(5);}throw Error('Timed out waiting for archive transition');};

test('new work cancels idle archive, ignores stale completion and resumes when idle',async()=>{
 let idle=true,calls=0;const signals:AbortSignal[]=[],notifications:string[]=[],finish:(()=>void)[]=[],emit:((value:never)=>void)[]=[];
 const job=createIdleSessionArchive({idle:()=>idle,retryMs:10,notify:value=>notifications.push(value.state),archive:(signal,notify)=>{
  calls++;signals.push(signal);emit.push(notify as (value:never)=>void);return new Promise<void>(resolve=>finish.push(resolve));
 }});
 job.schedule();await eventually(()=>calls===1);
 idle=false;job.cancel();assert.equal(signals[0].aborted,true);
 emit[0]({id:'old',state:'stored'} as never);assert.deepEqual(notifications,[]);
 idle=true;job.schedule();await eventually(()=>calls===2);
 finish[0]();await sleep(5);emit[1]({id:'new',state:'stored'} as never);
 assert.deepEqual(notifications,['stored']);finish[1]();job.dispose();
});

test('retry is bounded to idle time and disposal aborts the owned operation',async()=>{
 let idle=true,calls=0,signal:AbortSignal|undefined;
 const job=createIdleSessionArchive({idle:()=>idle,retryMs:10,notify:()=>{},archive:async(s,notify)=>{
  calls++;signal=s;if(calls===1)notify({id:'pending',state:'failed'});else await new Promise<void>(resolve=>s.addEventListener('abort',()=>resolve(),{once:true}));
 }});
 job.schedule();await eventually(()=>calls===2);idle=false;job.dispose();assert.equal(signal?.aborted,true);
 await sleep(30);assert.equal(calls,2);
});
