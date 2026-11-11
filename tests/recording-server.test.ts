import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRecordingServerState,serveRecording} from '../dev/recording-server';

const W=32,H=24;
function frame(seed:number):Buffer {
  const data=Buffer.alloc(W*H*4);
  for(let index=0;index<data.length;index+=4){data[index]=(index*7+seed)&255;data[index+1]=(index*3+seed*5)&255;data[index+2]=seed&255;data[index+3]=255;}
  return data;
}
async function withServer(run:(base:string)=>Promise<void>):Promise<void> {
  const root=await mkdtemp(join(tmpdir(),'recording-server-'));const state=createRecordingServerState();
  const server:Server=createServer((request,response)=>{
    void serveRecording(request,response,state,root).then(handled=>{if(!handled){response.statusCode=404;response.end();}});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address() as {port:number};
  try{await run(`http://127.0.0.1:${port}/__rec`);}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
}
const start=(base:string,id:string)=>fetch(`${base}/${id}/start`,{method:'PUT',body:JSON.stringify({width:W,height:H,environment:{test:true}})});
const post=(base:string,id:string,data:Buffer,at:number,media?:number)=>fetch(`${base}/${id}/frame`,{method:'POST',body:data,
  headers:{'x-delivered-at-ms':String(at),...(media===undefined?{}:{'x-media-time-ms':String(media)})}});

test('a session is recorded over HTTP and streamed back byte-identically in order', async()=>{
  await withServer(async base=>{
    assert.equal((await start(base,'a')).status,200);
    for(let index=0;index<5;index++)assert.deepEqual(await (await post(base,'a',frame(index),index*40,index*40+7)).json(),{seq:index});
    let meta=await (await fetch(`${base}/a`)).json() as {status:string;live:boolean};
    assert.deepEqual({status:meta.status,live:meta.live},{status:'open',live:true});
    const sealed=await (await fetch(`${base}/a/seal`,{method:'POST'})).json() as {status:string;frames:number;complete:boolean};
    assert.deepEqual({status:sealed.status,frames:sealed.frames,complete:sealed.complete},{status:'sealed',frames:5,complete:true});
    meta=await (await fetch(`${base}/a`)).json() as typeof meta;
    assert.equal(meta.live,false);
    const lines=(await (await fetch(`${base}/a/lines`)).json() as {lines:{seq:number;deliveredAtMs:number;mediaTimeMs:number}[]}).lines;
    assert.deepEqual(lines.map(line=>[line.seq,line.deliveredAtMs,line.mediaTimeMs]),[0,1,2,3,4].map(index=>[index,index*40,index*40+7]));
    const response=await fetch(`${base}/a/frames`);
    assert.equal(response.headers.get('x-frame-bytes'),String(W*H*4));
    const body=Buffer.from(await response.arrayBuffer());
    assert.equal(body.length,5*W*H*4);
    for(let index=0;index<5;index++)assert.ok(body.subarray(index*W*H*4,(index+1)*W*H*4).equals(frame(index)),`frame ${index}`);
    const tail=Buffer.from(await (await fetch(`${base}/a/frames?from=3`)).arrayBuffer());
    assert.equal(tail.length,2*W*H*4);assert.ok(tail.subarray(0,W*H*4).equals(frame(3)));
    assert.equal((await (await fetch(base)).json() as {recordings:unknown[]}).recordings.length,1);
  });
});

test('bad requests are refused without corrupting the recording', async()=>{
  await withServer(async base=>{
    assert.equal((await post(base,'none',frame(0),0)).status,404,'a frame for a session that was never opened');
    assert.equal((await start(base,'b')).status,200);
    assert.equal((await start(base,'b')).status,409,'a second start of the same id');
    assert.equal((await post(base,'b',Buffer.alloc(10),0)).status,400,'wrong frame size');
    assert.equal((await post(base,'b',frame(0),-5)).status,400,'negative delivery time');
    assert.equal((await fetch(`${base}/b/frame`,{method:'POST',body:frame(0)})).status,400,'missing timing header');
    assert.equal((await post(base,'b',frame(1),10)).status,200,'a valid frame still works');
    assert.equal((await fetch(`${base}/..%2Fx/start`,{method:'PUT',body:'{}'})).status,400);
    assert.equal((await fetch(`${base}/missing`)).status,404);
    const sealed=await (await fetch(`${base}/b/seal`,{method:'POST'})).json() as {frames:number};
    assert.equal(sealed.frames,1,'only the valid frame was recorded');
  });
});

test('concurrent frame posts are written in arrival order', async()=>{
  await withServer(async base=>{
    await start(base,'c');
    const results=await Promise.all([0,1,2,3,4,5].map(index=>post(base,'c',frame(index),index*10)));
    assert.deepEqual(results.map(result=>result.status),new Array(6).fill(200));
    const sealed=await (await fetch(`${base}/c/seal`,{method:'POST'})).json() as {frames:number;complete:boolean};
    assert.deepEqual({frames:sealed.frames,complete:sealed.complete},{frames:6,complete:true});
  });
});

test('requests outside the prefix are not handled', async()=>{
  assert.equal(await serveRecording({url:'/__corpus',method:'GET'} as never,{} as never,createRecordingServerState(),'unused'),false);
});

test('native frames are accepted, may be uploaded out of order, and are written in sequence order', async()=>{
  await withServer(async base=>{
    const W2=32,H2=24,bytes=W2*H2*3/2;
    const native=(seed:number)=>{const data=Buffer.alloc(bytes);for(let index=0;index<bytes;index++)data[index]=(index*5+seed*17)&255;return data;};
    const started=await (await fetch(`${base}/n/start`,{method:'PUT',body:JSON.stringify({width:W2,height:H2,pixelFormat:'i420',colorSpace:{matrix:'bt709'}})})).json() as {frameBytes:number;pixelFormat:string};
    assert.deepEqual(started,{ok:true,frameBytes:bytes,pixelFormat:'i420'} as never);
    const send=(seq:number)=>fetch(`${base}/n/frame`,{method:'POST',body:native(seq),headers:{'x-delivered-at-ms':String(seq*30),'x-seq':String(seq)}});
    // 2 and 1 arrive before 0: the server holds them until their turn.
    const pending=[send(2),send(1)];
    await new Promise(resolve=>setTimeout(resolve,50));
    pending.push(send(0),send(3));
    assert.deepEqual((await Promise.all(pending)).map(result=>result.status),[200,200,200,200]);
    const sealed=await (await fetch(`${base}/n/seal`,{method:'POST'})).json() as {frames:number;complete:boolean;pixelFormat:string};
    assert.deepEqual({frames:sealed.frames,complete:sealed.complete,pixelFormat:sealed.pixelFormat},{frames:4,complete:true,pixelFormat:'i420'});
    const response=await fetch(`${base}/n/frames`);
    assert.equal(response.headers.get('x-pixel-format'),'i420');
    assert.equal(response.headers.get('x-frame-bytes'),String(bytes));
    const body=Buffer.from(await response.arrayBuffer());
    for(let seq=0;seq<4;seq++)assert.ok(body.subarray(seq*bytes,(seq+1)*bytes).equals(native(seq)),`frame ${seq} is in sequence order`);
    const lines=(await (await fetch(`${base}/n/lines`)).json() as {lines:{seq:number;deliveredAtMs:number}[]}).lines;
    assert.deepEqual(lines.map(line=>line.deliveredAtMs),[0,30,60,90],'timing follows the sequence, not the arrival order');
  });
});

test('a repeated or past sequence number is refused', async()=>{
  await withServer(async base=>{
    await fetch(`${base}/q/start`,{method:'PUT',body:JSON.stringify({width:W,height:H})});
    const send=(seq:number)=>fetch(`${base}/q/frame`,{method:'POST',body:frame(seq),headers:{'x-delivered-at-ms':'0','x-seq':String(seq)}});
    assert.equal((await send(0)).status,200);
    assert.equal((await send(0)).status,400);
    assert.equal((await send(1)).status,200);
    await fetch(`${base}/q/seal`,{method:'POST'});
  });
});

test('replay run reports are stored next to the recording and listed with their summary', async()=>{
  await withServer(async base=>{
    await fetch(`${base}/r/start`,{method:'PUT',body:JSON.stringify({width:W,height:H})});
    await post(base,'r',frame(1),0);
    await fetch(`${base}/r/seal`,{method:'POST'});
    assert.equal((await fetch(`${base}/missing/runs`,{method:'POST',body:'{}'})).status,404);
    assert.equal((await fetch(`${base}/r/runs`,{method:'POST',body:'{broken'})).status,400);
    const saved=await (await fetch(`${base}/r/runs`,{method:'POST',body:JSON.stringify({summary:{read:383},cards:[{id:'a'}]})})).json() as {name:string};
    assert.match(saved.name,/^run-[0-9-]+-[0-9a-f]{4}\.json$/);
    const listed=await (await fetch(`${base}/r/runs`)).json() as {runs:{name:string;summary:{read:number}}[]};
    assert.deepEqual(listed.runs.map(run=>[run.name,run.summary]),[[saved.name,{read:383}]]);
    const full=await (await fetch(`${base}/r/runs/${saved.name}`)).json() as {cards:unknown[]};
    assert.equal(full.cards.length,1);
    assert.equal((await fetch(`${base}/r/runs/..%2Fmeta.json`)).status,400);
    assert.equal((await fetch(`${base}/r/runs/run-nope.json`)).status,404);
  });
});

test('a recording whose page disappeared is sealed by the server after the idle window', async()=>{
  const root=await mkdtemp(join(tmpdir(),'recording-idle-'));const state=createRecordingServerState(250);
  const server:Server=createServer((request,response)=>{void serveRecording(request,response,state,root).then(handled=>{if(!handled){response.statusCode=404;response.end();}});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/__rec`;
  try{
    await start(base,'idle');
    for(let index=0;index<3;index++)await post(base,'idle',frame(index),index*30);
    assert.equal((await (await fetch(`${base}/idle`)).json() as {status:string}).status,'open');
    await new Promise(resolve=>setTimeout(resolve,900));            // the page never sealed it
    const meta=await (await fetch(`${base}/idle`)).json() as {status:string;frames:number;complete:boolean;note:string;live:boolean};
    assert.deepEqual({status:meta.status,frames:meta.frames,complete:meta.complete,live:meta.live},{status:'sealed',frames:3,complete:true,live:false});
    assert.match(meta.note,/no frames for/);
    assert.equal((await post(base,'idle',frame(9),99)).status,404,'a late frame after the idle seal is refused');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test('sealing an unsealed recording with no live writer recovers it', async()=>{
  await withServer(async base=>{
    // Simulate a restart: a recording folder left 'open' with a finished encoder but no meta update.
    await start(base,'orphan');
    await post(base,'orphan',frame(0),0);await post(base,'orphan',frame(1),30);
    const sealedByHttp=await (await fetch(`${base}/orphan/seal`,{method:'POST'})).json() as {frames:number};
    assert.equal(sealedByHttp.frames,2);
    const again=await (await fetch(`${base}/orphan/seal`,{method:'POST'}));
    assert.equal(again.status,200,'sealing a sealed recording is harmless');
    assert.equal((await fetch(`${base}/nothing/seal`,{method:'POST'})).status,404);
  });
});

test('the live scan result is overwritten in place next to the recording and listed with its summary', async()=>{
  await withServer(async base=>{
    assert.equal((await fetch(`${base}/nope/runs/live`,{method:'PUT',body:'{}'})).status,404,'unknown recording');
    assert.equal((await start(base,'live1')).status,200);
    const put=(body:string)=>fetch(`${base}/live1/runs/live`,{method:'PUT',body});
    assert.equal((await put('not json')).status,400);
    assert.equal((await put(JSON.stringify({summary:{read:3,mode:'live'},cards:[]}))).status,200);
    assert.equal((await put(JSON.stringify({summary:{read:7,mode:'live'},cards:[]}))).status,200);
    const list=await (await fetch(`${base}/live1/runs`)).json() as {runs:{name:string;summary:{read:number}}[]};
    assert.equal(list.runs.length,1,'one live file, overwritten rather than accumulated');
    assert.equal(list.runs[0].name,'run-live.json');
    assert.equal(list.runs[0].summary.read,7);
    const text=await (await fetch(`${base}/live1/runs/run-live.json`)).text();
    assert.equal(JSON.parse(text).summary.read,7);
    assert.equal((await fetch(`${base}/live1/seal`,{method:'POST',body:'{}'})).status,200,'an open recording would keep the server alive');
  });
});
