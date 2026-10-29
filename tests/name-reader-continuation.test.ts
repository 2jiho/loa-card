import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createNameReader} from '../src/features/card-scanner/name-reader';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/card-read-budget';
import {createGrayNameFirstLine,NAME_GRAY_FIRST_RECIPE} from '../src/features/card-scanner/name-gray-first';
import {softNamePixels,normalizeSoftNamePixels} from '../src/features/card-scanner/soft-name-pixels';
import type {NameAttempt} from '../src/features/card-scanner/name-diagnostics';
import type {NeuralReading} from '../src/features/card-scanner/neural-reader';
import type {NameReading} from '../src/features/card-scanner/name-reader';

type Request={id:number;type:string;model:string;width:number;height:number;data:Uint8ClampedArray;
 useLexicon:boolean;nameLine?:{group:string;line:number}};
type Phase='raw-first'|'raw-second'|'raw-full'|'gray-first'|'soft';
type Reply=NeuralReading|{error:string}|'hang';
const cards=[{id:'raw',name:'벨루마테',rarity:2},{id:'other',name:'아크투루스',rarity:2}];
const reading=(text:string):NeuralReading=>({text,confidence:.98});
const phase=(request:Request):Phase=>request.nameLine?.line===0?'raw-first':request.nameLine?.line===1?'raw-second':
 request.height===36?'raw-full':request.useLexicon?'soft':'gray-first';
const phases=(requests:Request[])=>requests.map(phase);
const evidence=(value:NameReading|null)=>value?{card:value.card,exact:value.exact,score:value.score,gap:value.gap,
 ocrConfidence:value.ocrConfidence,complete:value.complete,rawText:value.rawText,ctc:value.ctc,
 preprocessing:value.preprocessing,engine:value.engine,fingerprint:value.fingerprint,artwork:value.artwork}:null;

function labelPixels(shift=0){
 const data=new Uint8ClampedArray(128*36*4);
 for(let y=2;y<14;y++)for(let x=12+shift;x<72+shift;x++)if((x-shift)%5<2){
  data.set([20,180,220,255],(y*128+x)*4);
 }
 return data;
}

function setup(policy:'continue'|'resample'|'default'='continue',signal?:AbortSignal,createReader=createNameReader){
 const previous={Worker:globalThis.Worker,document:globalThis.document,ImageData:globalThis.ImageData};
 const state={requests:[] as Request[],workers:[] as FakeWorker[],canvases:[] as FakeCanvas[],clock:0,cost:0,
  reply:((request:Request)=>phase(request)==='raw-first'?reading('벨루마트'):reading('')) as (request:Request,index:number)=>Reply,
  onRequest:undefined as undefined|((request:Request)=>void),deliveries:[] as (()=>void)[]};
 class FakeWorker {
  onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;terminations=0;
  constructor(){state.workers.push(this);}
  postMessage(value:unknown,transfer:Transferable[]=[]){
   const request=structuredClone(value,{transfer}) as Request;
   if(request.type==='ready'){queueMicrotask(()=>this.onmessage?.({data:{id:request.id,result:null}}));return;}
   const index=state.requests.push(request)-1;state.clock+=state.cost;
   const reply=state.reply(request,index);
   const deliver=(result:Reply)=>{if(result==='hang')return;
    this.onmessage?.({data:'error' in result?{id:request.id,error:result.error}:{id:request.id,result}});};
   state.deliveries.push(()=>deliver(reading('아크투루스')));
   state.onRequest?.(request);queueMicrotask(()=>deliver(reply));
  }
  terminate(){this.terminations++;}
 }
 class FakeImageData {constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}}
 class FakeCanvas {
  width=140;height=210;private pixels=new Uint8ClampedArray();
  constructor(readonly external=false,readonly labels=new Map([[0,labelPixels()],[2,labelPixels(2)]])){
   state.canvases.push(this);
  }
  private raster(){if(this.pixels.length!==this.width*this.height*4)this.pixels=new Uint8ClampedArray(this.width*this.height*4);return this.pixels;}
  getContext(){return {
   drawImage:(source:FakeCanvas,...args:number[])=>{
    if(source.external){
     this.pixels=this.width===24&&this.height===32?new Uint8ClampedArray(24*32*4):
      (source.labels.get((args[1]??14)-14)??source.labels.get(0)!).slice();
     return;
    }
    const [sx,sy,sw,sh,dx,dy,dw,dh]=args.length===8?args:
     [0,0,source.width,source.height,args[0]??0,args[1]??0,args[2]??source.width,args[3]??source.height];
    const original=source.raster(),output=this.raster();
    for(let y=0;y<dh;y++)for(let x=0;x<dw;x++){
     const src=((sy+Math.floor(y*sh/dh))*source.width+sx+Math.floor(x*sw/dw))*4;
     output.set(original.subarray(src,src+4),((dy+y)*this.width+dx+x)*4);
    }
   },
   clearRect:(x:number,y:number,width:number,height:number)=>{
    const pixels=this.raster();for(let row=y;row<y+height;row++)pixels.fill(0,(row*this.width+x)*4,(row*this.width+x+width)*4);
   },
   fillRect:(x:number,y:number,width:number,height:number)=>{
    const pixels=this.raster();for(let row=y;row<y+height;row++)for(let col=x;col<x+width;col++)pixels.set([255,255,255,255],(row*this.width+col)*4);
   },
   createImageData:(width:number,height:number)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),
   putImageData:(image:FakeImageData)=>{this.pixels=image.data.slice();},
   getImageData:(x:number,y:number,width:number,height:number)=>{
    const original=this.raster(),data=new Uint8ClampedArray(width*height*4);
    for(let row=0;row<height;row++)for(let col=0;col<width;col++){
     const src=((y+row)*this.width+x+col)*4;data.set(original.subarray(src,src+4),(row*width+col)*4);
    }
    return {data};
   },
  };}
 }
 globalThis.Worker=FakeWorker as unknown as typeof Worker;
 globalThis.ImageData=FakeImageData as unknown as typeof ImageData;
 globalThis.document={createElement:()=>new FakeCanvas()} as unknown as Document;
 const reader=createReader(cards,undefined,signal,policy==='default'?undefined:{rawResultPolicy:policy});
 const source=new FakeCanvas(true) as unknown as HTMLCanvasElement;
 return {state,reader,source,createSource:(shift:number)=>new FakeCanvas(true,new Map([[0,labelPixels(shift)]])) as unknown as HTMLCanvasElement,
  createBlankSource:()=>new FakeCanvas(true,new Map([[0,new Uint8ClampedArray(128*36*4)]])) as unknown as HTMLCanvasElement,
  restore(){globalThis.Worker=previous.Worker;globalThis.document=previous.document;globalThis.ImageData=previous.ImageData;}};
}
async function fixture(run:(value:ReturnType<typeof setup>)=>Promise<void>,policy:'continue'|'resample'|'default'='continue',signal?:AbortSignal,createReader=createNameReader){
 const value=setup(policy,signal,createReader);
 try{await value.reader.ready();await run(value);}finally{await value.reader.dispose();value.restore();}
}

test('continuation consumes the shared prefix once, then runs remaining raw, gray and soft recipes',async()=>{
 await fixture(async({reader,source,state})=>{
  const attempts:NameAttempt[]=[],quick:unknown[]=[],metrics:ReturnType<typeof reader.nameOcrMetrics>[]=[];
  const result=await reader.matchForIdentify(source,{allowRaw:true,allowGrayNameFallback:true,
   onAttempt:attempt=>attempts.push(attempt),onMetrics:value=>metrics.push(value),acceptQuick:value=>{quick.push(value);return false;}});
  assert.equal(result?.card.id,'raw');assert.equal(result?.rawText,'벨루마트');assert.equal(result?.exact,false);
  assert.equal(quick.length,1);assert.equal((quick[0] as {rawText:string}).rawText,'벨루마트');
  assert.deepEqual(phases(state.requests),['raw-first','raw-second','raw-full','gray-first','soft','soft']);
  assert.deepEqual(state.requests.map(v=>[v.width,v.height,v.useLexicon,v.nameLine?.line]),
   [[128,18,true,0],[128,18,false,1],[128,36,true,undefined],[128,18,false,undefined],
    [128,18,true,undefined],[128,18,true,undefined]]);
  assert.equal(state.requests[0].nameLine?.group,state.requests[1].nameLine?.group);
  assert.deepEqual(state.requests[3].data,createGrayNameFirstLine(labelPixels()));
  const soft=softNamePixels(labelPixels(),2).slice(0,128*18*4);
  assert.deepEqual(state.requests[4].data,soft);
  assert.deepEqual(state.requests[5].data,normalizeSoftNamePixels(soft));
  assert.equal(attempts.filter(attempt=>attempt.variant==='원본 첫 줄').length,1);
  assert.equal(attempts.filter(attempt=>attempt.variant===NAME_GRAY_FIRST_RECIPE).length,1);
  assert.ok(state.canvases.filter(canvas=>!canvas.external).every(canvas=>canvas.width===0));
  assert.equal(metrics.length,1);
  const aggregate=reader.nameOcrMetrics();assert.deepEqual(metrics[0],aggregate);
  assert.equal(aggregate.scope,'korean-neural-name-request-await');assert.equal(aggregate.policy,'continue');
  assert.equal(aggregate.invocations,1);assert.equal(aggregate.continued,1);assert.equal(aggregate.quickAccepted,0);
  assert.equal(aggregate.requests,state.requests.length);assert.equal(aggregate.reusedRequests,1);
  assert.equal(aggregate.failedRequests,0);assert.equal(aggregate.invocationFailures,0);
  assert.equal(aggregate.recipes.find(value=>value.recipe==='raw-first-line')?.requests,1);
  assert.equal(aggregate.recipes.find(value=>value.recipe==='raw-first-line')?.reusedRequests,1);
  assert.ok(Number.isFinite(aggregate.wallAwaitMs)&&aggregate.wallAwaitMs>=0);
  assert.ok(Object.isFrozen(metrics[0])&&Object.isFrozen(metrics[0].recipes));
  assert.ok(metrics[0].recipes.every(Object.isFrozen));
 });
});

test('accepted quick identity skips every remaining full recipe',async()=>{
 await fixture(async({reader,source,state})=>{
  state.reply=()=>reading('벨루마테');let accepted=0;
  const result=await reader.matchForIdentify(source,{allowRaw:true,allowGrayNameFallback:true,acceptQuick:value=>{
   accepted++;assert.equal(value?.exact,true);return true;
  }});
  assert.equal(result?.card.id,'raw');assert.equal(accepted,1);assert.deepEqual(phases(state.requests),['raw-first']);
  const metrics=reader.nameOcrMetrics();assert.equal(metrics.quickAccepted,1);assert.equal(metrics.continued,0);
  assert.equal(metrics.requests,1);assert.equal(metrics.reusedRequests,0);
 });
});

test('optional metrics observer failure does not change an accepted identity',async()=>{
 await fixture(async({reader,source,state})=>{
  state.reply=()=>reading('벨루마테');
  const result=await reader.matchForIdentify(source,{allowRaw:true,acceptQuick:()=>true,onMetrics:()=>{throw new Error('observer failed');}});
  assert.equal(result?.card.id,'raw');assert.equal(reader.nameOcrMetrics().invocationFailures,0);
  assert.deepEqual(phases(state.requests),['raw-first']);
 });
});

test('rejecting an already confirmed raw reading preserves the full algorithm confirmation threshold',async()=>{
 await fixture(async({reader,source,state})=>{
  state.reply=()=>reading('벨루마테');
  const result=await reader.matchForIdentify(source,{allowRaw:true,acceptQuick:()=>false});
  assert.equal(result?.exact,true);assert.equal(result?.card.id,'raw');assert.deepEqual(phases(state.requests),['raw-first']);
 });
});

test('full false returns the rejected quick candidate without running a full recipe',async()=>{
 await fixture(async({reader,source,state})=>{
  let callbacks=0;
  const result=await reader.matchForIdentify(source,{full:false,allowRaw:true,allowGrayNameFallback:true,
   acceptQuick:value=>{callbacks++;assert.equal(value?.exact,false);return false;}});
  assert.equal(result?.rawText,'벨루마트');assert.equal(callbacks,1);assert.deepEqual(phases(state.requests),['raw-first']);
 });
});

test('no quick candidate continues after all three raw recipes directly into the gray fallback',async()=>{
 await fixture(async({reader,source,state})=>{
  let callbacks=0;state.reply=request=>reading(phase(request)==='gray-first'?'벨루마테':'');
  const result=await reader.matchForIdentify(source,{allowRaw:true,allowGrayNameFallback:true,acceptQuick:value=>{
   callbacks++;assert.equal(value,null);return false;
  }});
  assert.equal(result?.card.id,'raw');assert.equal(result?.preprocessing,NAME_GRAY_FIRST_RECIPE);assert.equal(callbacks,1);
  assert.deepEqual(phases(state.requests),['raw-first','raw-second','raw-full','gray-first']);
  assert.equal(reader.nameOcrMetrics().requests,4);assert.equal(reader.nameOcrMetrics().reusedRequests,3);
 });
});

for(const candidateAt of ['raw-second','raw-full'] as const)test(`continuation resumes after a quick candidate found by ${candidateAt}`,async()=>{
 await fixture(async({reader,source,state})=>{
  state.reply=request=>{
   const current=phase(request);
   return reading(candidateAt==='raw-second'?(current==='raw-first'?'벨루':current==='raw-second'?'마트':''):
    current==='raw-full'?'벨루마트':'');
  };
  let callbacks=0;
  const result=await reader.matchForIdentify(source,{allowRaw:true,allowGrayNameFallback:true,acceptQuick:value=>{
   callbacks++;assert.equal(value?.rawText,'벨루마트');return false;
  }});
  assert.equal(result?.card.id,'raw');assert.equal(result?.exact,false);assert.equal(callbacks,1);
  assert.deepEqual(phases(state.requests),['raw-first','raw-second','raw-full','gray-first','soft','soft']);
  assert.equal(reader.nameOcrMetrics().reusedRequests,candidateAt==='raw-second'?2:3);
 });
});

test('no quick candidate can be confirmed by the existing soft recipe without replaying raw requests',async()=>{
 await fixture(async({reader,source,state})=>{
  state.reply=request=>reading(phase(request)==='soft'?'아크투루스':'');
  const result=await reader.matchForIdentify(source,{allowRaw:true,allowGrayNameFallback:true,acceptQuick:()=>false});
  assert.equal(result?.card.id,'other');assert.equal(result?.exact,true);assert.equal(result?.preprocessing,'soft-rarity');
  assert.deepEqual(phases(state.requests),['raw-first','raw-second','raw-full','gray-first','soft']);
 });
});

test('full false with no quick candidate stops after the raw prefix and invokes the gate once with null',async()=>{
 await fixture(async({reader,source,state})=>{
  state.reply=()=>reading('');let callbacks=0;
  const result=await reader.matchForIdentify(source,{full:false,allowRaw:true,allowGrayNameFallback:true,acceptQuick:value=>{
   callbacks++;assert.equal(value,null);return false;
  }});
  assert.equal(result,null);assert.equal(callbacks,1);assert.deepEqual(phases(state.requests),['raw-first','raw-second','raw-full']);
 });
});

test('continuation state stays local across repeated calls, cards, offsets and options',async()=>{
 await fixture(async({reader,source,state,createSource})=>{
  const otherSource=createSource(4),observations:{offset:number;allowRaw:boolean;pixels:Uint8ClampedArray}[]=[];
  const identify=async(input:HTMLCanvasElement,offsetY=0,allowRaw=true,gray=false)=>{
   const before=state.requests.length;
   const result=await reader.matchForIdentify(input,{offsetY,allowRaw,allowGrayNameFallback:gray,
    observeLabel:(pixels,recipe)=>observations.push({offset:recipe.offsetY,allowRaw:recipe.allowRaw,pixels:pixels.data.slice()}),
    acceptQuick:()=>false});
   const requests=state.requests.slice(before);
   assert.deepEqual(phases(requests),['raw-first','raw-second','raw-full',...(gray?['gray-first']:[]),'soft','soft']);
   assert.equal(result?.complete,allowRaw);return {result,first:requests[0]};
  };
  const first=await identify(source),same=await identify(source);
  assert.deepEqual(first.first.data,same.first.data);assert.notEqual(first.result?.readingId,same.result?.readingId);
  state.reply=request=>reading(phase(request)==='raw-first'?'아크투루수':'');
  const other=await identify(otherSource);assert.equal(other.result?.card.id,'other');
  assert.notDeepEqual(other.first.data,first.first.data);assert.notEqual(other.result?.fingerprint,first.result?.fingerprint);
  const shifted=await identify(source,2);assert.deepEqual(shifted.first.data,labelPixels(2).slice(0,128*18*4));
  assert.notEqual(shifted.result?.fingerprint,first.result?.fingerprint);
  await identify(source,0,false);await identify(source,0,true,true);
  assert.ok(observations.some(value=>value.offset===2&&value.allowRaw));
  assert.ok(observations.some(value=>value.offset===0&&!value.allowRaw));
  const metrics=reader.nameOcrMetrics();assert.equal(metrics.invocations,6);assert.equal(metrics.continued,6);
  assert.equal(metrics.requests,state.requests.length);assert.equal(metrics.reusedRequests,6);
 });
});

for(const policy of ['resample','default'] as const)test(`${policy} policy resamples adaptive provider output explicitly`,async()=>{
 await fixture(async({reader,source,state})=>{
  let firstReads=0,callbacks=0;
  state.reply=request=>reading(phase(request)==='raw-first'?(++firstReads===1?'벨루마트':'아크투루스'):'');
  const result=await reader.matchForIdentify(source,{allowRaw:true,acceptQuick:value=>{
   callbacks++;assert.equal(value?.rawText,'벨루마트');return false;
  }});
  assert.equal(result?.card.id,'other');assert.equal(result?.exact,true);assert.equal(callbacks,1);
  assert.deepEqual(phases(state.requests),['raw-first','raw-first']);
  assert.deepEqual(state.requests[0].data,state.requests[1].data);
  const metrics=reader.nameOcrMetrics();assert.equal(metrics.policy,'resample');assert.equal(metrics.requests,2);
  assert.equal(metrics.reusedRequests,0);
 },policy);
});

test('continuation failure rejects instead of returning its retained quick candidate',async()=>{
 await fixture(async({reader,source,state})=>{
  state.reply=request=>phase(request)==='raw-first'?reading('벨루마트'):{error:'synthetic OCR failure'};
  let outcome='pending';const metrics:ReturnType<typeof reader.nameOcrMetrics>[]=[];
  const result=reader.matchForIdentify(source,{allowRaw:true,acceptQuick:()=>false,onMetrics:value=>metrics.push(value)}).then(value=>{outcome='resolved';return value;},error=>{
   outcome='rejected';throw error;
  });
  await assert.rejects(result,/synthetic OCR failure/);state.deliveries.at(-1)!();await Promise.resolve();
  assert.equal(outcome,'rejected');assert.deepEqual(phases(state.requests),['raw-first','raw-second']);
  assert.equal(metrics.length,1);assert.equal(metrics[0].invocationFailures,1);assert.equal(metrics[0].requests,2);
  assert.equal(metrics[0].reusedRequests,1);assert.equal(metrics[0].failedRequests,1);
 });
});

test('abort during continuation rejects and ignores a late exact response',async()=>{
 const controller=new AbortController();
 await fixture(async({reader,source,state})=>{
  state.reply=request=>phase(request)==='raw-first'?reading('벨루마트'):'hang';
  state.onRequest=request=>{if(phase(request)==='raw-second')queueMicrotask(()=>controller.abort());};
  let outcome='pending';
  const result=reader.matchForIdentify(source,{allowRaw:true,acceptQuick:()=>false}).then(value=>{outcome='resolved';return value;},error=>{
   outcome='rejected';throw error;
  });
  await assert.rejects(result,/OCR 종료/);state.deliveries.at(-1)!();await Promise.resolve();
  assert.equal(outcome,'rejected');assert.deepEqual(phases(state.requests),['raw-first','raw-second']);
  assert.ok(state.workers.some(worker=>worker.terminations>0));
 },'continue',controller.signal);
});

test('an exact response after the shared budget expires cannot replace timeout with a late outcome',async()=>{
 await fixture(async({reader,source,state})=>{
  state.cost=2;state.reply=request=>reading(phase(request)==='raw-first'?'벨루마트':phase(request)==='raw-full'?'아크투루스':'');
  const budget=new CardReadBudget(5,()=>state.clock);
  await assert.rejects(reader.matchForIdentify(source,{allowRaw:true,allowGrayNameFallback:true,budget,acceptQuick:()=>false}),CardReadTimeout);
  assert.equal(state.clock,6);assert.equal(budget.remaining(),0);
  assert.deepEqual(phases(state.requests),['raw-first','raw-second','raw-full']);
 });
});

test('a rejected quick gate consuming the remaining budget cannot return its retained candidate',async()=>{
 await fixture(async({reader,source,state})=>{
  const budget=new CardReadBudget(5,()=>state.clock);let callbacks=0;
  await assert.rejects(reader.matchForIdentify(source,{allowRaw:true,budget,acceptQuick:value=>{
   callbacks++;assert.equal(value?.rawText,'벨루마트');assert.equal(value?.exact,false);
   state.clock=5;return false;
  }}),CardReadTimeout);
  assert.equal(callbacks,1);assert.equal(budget.remaining(),0);
  assert.deepEqual(phases(state.requests),['raw-first']);
  const metrics=reader.nameOcrMetrics();assert.equal(metrics.invocationFailures,1);
  assert.equal(metrics.requests,1);assert.equal(metrics.reusedRequests,0);assert.equal(metrics.quickAccepted,0);
  assert.ok(state.canvases.filter(canvas=>!canvas.external).every(canvas=>canvas.width===0));
 });
});

test('a hanging continuation uses the original budget and cannot leak its prefix into the next call',async()=>{
 await fixture(async({reader,source,state})=>{
  state.cost=2;state.reply=request=>phase(request)==='raw-first'?reading('벨루마트'):'hang';
  const budget=new CardReadBudget(5,()=>state.clock);
  await assert.rejects(reader.matchForIdentify(source,{allowRaw:true,budget,acceptQuick:()=>false}),CardReadTimeout);
  assert.equal(state.clock,4);assert.equal(budget.remaining(),1);assert.ok(state.workers.some(worker=>worker.terminations>0));
  const failed=reader.nameOcrMetrics();assert.equal(failed.invocationFailures,1);assert.equal(failed.failedRequests,1);
  assert.equal(failed.requests,2);assert.equal(failed.reusedRequests,1);
  state.deliveries.at(-1)!();await Promise.resolve();
  state.reply=()=>reading('아크투루스');
  const next=await reader.matchForIdentify(source,{allowRaw:true,budget:new CardReadBudget(100,()=>state.clock),acceptQuick:()=>true});
  assert.equal(next?.card.id,'other');assert.equal(next?.exact,true);
  assert.deepEqual(phases(state.requests),['raw-first','raw-second','raw-first']);
 });
});

type EquivalenceCase={name:string;responses:Partial<Record<Phase,NeuralReading>>;allowRaw:boolean;gray?:boolean;
 expected:{rawText:string;exact:boolean;ctc?:NameReading['ctc'];preprocessing?:NameReading['preprocessing']}};
const equivalenceCases:EquivalenceCase[]=[
 {name:'whole exact first line',allowRaw:true,responses:{'raw-first':reading('벨루마테')},expected:{rawText:'벨루마테',exact:true}},
 ...[false,true].map(allowRaw=>({name:`unconfirmed full-label candidate with allowRaw ${allowRaw}`,allowRaw,
  responses:{'raw-full':reading('벨루마트')},expected:{rawText:'벨루마트',exact:false}})),
 {name:'partial name combined from both raw lines',allowRaw:true,responses:{'raw-first':reading('벨루'),'raw-second':reading('마트')},
  expected:{rawText:'벨루마트',exact:false}},
 {name:'full label exact strengthens the partial first line',allowRaw:true,
  responses:{'raw-first':reading('벨루마트'),'raw-full':reading('벨루마테')},expected:{rawText:'벨루마테',exact:true}},
 {name:'retained CTC hypothesis keeps its evidence',allowRaw:true,responses:{'raw-first':{text:'벨루마대',confidence:.98,
  candidates:[{id:'raw',name:'벨루마테',relativeLikelihood:.97,margin:.95}]}},
  expected:{rawText:'벨루마대',exact:false,ctc:{relativeLikelihood:.97,margin:.95}}},
 {name:'exact gray fallback',allowRaw:true,gray:true,responses:{'gray-first':reading('벨루마테')},
  expected:{rawText:'벨루마테',exact:true,preprocessing:NAME_GRAY_FIRST_RECIPE}},
 {name:'exact soft fallback',allowRaw:true,responses:{soft:reading('벨루마테')},
  expected:{rawText:'벨루마테',exact:true,preprocessing:'soft-rarity'}},
];
for(const scenario of equivalenceCases)test(`deterministic policies select equal evidence for ${scenario.name}`,async()=>{
 const results=new Map<'continue'|'resample',ReturnType<typeof evidence>>();
 for(const policy of ['continue','resample'] as const)await fixture(async({reader,source,state})=>{
  state.reply=request=>structuredClone(scenario.responses[phase(request)]??reading(''));
  let callbacks=0;
  // This checks deterministic selection with ample time, not parity under a
  // deadline where avoiding repeated model work can change the available time.
  const result=await reader.matchForIdentify(source,{allowRaw:scenario.allowRaw,allowGrayNameFallback:scenario.gray,
   budget:new CardReadBudget(10000),acceptQuick:()=>{callbacks++;return false;}});
  assert.equal(callbacks,1);assert.ok(result);assert.equal(result.card.id,'raw');
  assert.equal(result.rawText,scenario.expected.rawText);assert.equal(result.exact,scenario.expected.exact);
  assert.equal(result.complete,scenario.allowRaw);assert.deepEqual(result.ctc,scenario.expected.ctc);
  assert.equal(result.preprocessing,scenario.expected.preprocessing);results.set(policy,evidence(result));
 },policy);
 assert.deepEqual(results.get('continue'),results.get('resample'));
});

test('flat no-mask quality rejection invokes the null gate once and dispatches no OCR',async()=>{
 await fixture(async({reader,state,createBlankSource})=>{
  let callbacks=0;const attempts:NameAttempt[]=[];
  const result=await reader.matchForIdentify(createBlankSource(),{allowRaw:false,onAttempt:value=>attempts.push(value),acceptQuick:value=>{
   callbacks++;assert.equal(value,null);return false;
  }});
  assert.equal(result,null);assert.equal(callbacks,1);assert.equal(state.requests.length,0);
  assert.equal(attempts.filter(value=>value.engine==='quality').length,1);
  assert.equal(reader.nameOcrMetrics().requests,0);assert.equal(reader.nameOcrMetrics().invocationFailures,0);
  assert.ok(state.canvases.filter(canvas=>!canvas.external).every(canvas=>canvas.width===0));
 });
});

test('a second reader cannot inherit another reader raw prefix for the same source',async()=>{
 await fixture(async({reader,source,state})=>{
  const second=createNameReader(cards,undefined,undefined,{rawResultPolicy:'continue'});
  try{
   await second.ready();
   const first=await reader.matchForIdentify(source,{allowRaw:true,budget:new CardReadBudget(10000),acceptQuick:()=>false});
   const firstMetrics=reader.nameOcrMetrics();assert.equal(first?.card.id,'raw');assert.equal(firstMetrics.requests,5);
   state.reply=request=>reading(phase(request)==='raw-first'?'아크투루수':'');
   const next=await second.matchForIdentify(source,{allowRaw:true,budget:new CardReadBudget(10000),acceptQuick:()=>false});
   assert.equal(next?.card.id,'other');assert.notEqual(next?.readingId,first?.readingId);
   assert.deepEqual(phases(state.requests),['raw-first','raw-second','raw-full','soft','soft',
    'raw-first','raw-second','raw-full','soft','soft']);
   assert.deepEqual(state.requests[0].data,state.requests[5].data);
   assert.deepEqual(reader.nameOcrMetrics(),firstMetrics);
   const nextMetrics=second.nameOcrMetrics();assert.equal(nextMetrics.invocations,1);assert.equal(nextMetrics.requests,5);
   assert.equal(nextMetrics.reusedRequests,1);
  }finally{await second.dispose();}
 });
});

test('a label observer abort before the first OCR dispatch releases every internal canvas',async()=>{
 const controller=new AbortController();
 await fixture(async({reader,source,state})=>{
  const metrics:ReturnType<typeof reader.nameOcrMetrics>[]=[],budget=new CardReadBudget(10000);
  await assert.rejects(reader.matchForIdentify(source,{allowRaw:true,budget,acceptQuick:()=>false,
   observeLabel:()=>controller.abort(),onMetrics:value=>metrics.push(value)}),error=>error===controller.signal.reason);
  assert.equal(state.requests.length,0);assert.ok(state.canvases.filter(canvas=>!canvas.external).every(canvas=>canvas.width===0));
  assert.equal(metrics.length,1);assert.equal(metrics[0].invocationFailures,1);assert.equal(metrics[0].requests,0);
 },'continue',controller.signal);
});

test('a label observer exhausting the budget before the first OCR dispatch releases every internal canvas',async()=>{
 await fixture(async({reader,source,state})=>{
  const metrics:ReturnType<typeof reader.nameOcrMetrics>[]=[],budget=new CardReadBudget(10000,()=>state.clock);
  await assert.rejects(reader.matchForIdentify(source,{allowRaw:true,budget,acceptQuick:()=>false,
   observeLabel:()=>{state.clock=10000;},onMetrics:value=>metrics.push(value)}),CardReadTimeout);
  assert.equal(state.requests.length,0);assert.equal(budget.remaining(),0);
  assert.ok(state.canvases.filter(canvas=>!canvas.external).every(canvas=>canvas.width===0));
  assert.equal(metrics.length,1);assert.equal(metrics[0].invocationFailures,1);assert.equal(metrics[0].requests,0);
 });
});

test('an exact Tesseract mask result arriving after abort cannot become an accepted outcome',async()=>{
 const controller=new AbortController(),bridgeKey='__loaCardTestTesseractLateAbort';
 const globals=globalThis as unknown as Record<string,unknown>;
 const previous={location:globalThis.location,bridge:globals[bridgeKey],hadBridge:Object.hasOwn(globals,bridgeKey)};
 let began!:()=>void,complete!:(result:{data:{text:string;confidence:number}})=>void;
 const started=new Promise<void>(resolve=>{began=resolve;}),response=new Promise<{data:{text:string;confidence:number}}>(resolve=>{complete=resolve;});
 let tesseractCalls=0,terminated=0,providedBase=false;
 globals[bridgeKey]=()=>({setParameters:async()=>{},terminate:async()=>{terminated++;},recognize:async()=>{
  tesseractCalls++;began();return response;
 }});
 globalThis.location={href:'https://loacard.test/'} as Location;
 const virtualModule='loacard-test:tesseract-late-abort';
 const moduleUrl=new URL('../src/features/card-scanner/name-reader.ts?test=tesseract-late-abort',import.meta.url).href;
 const hooks=registerHooks({
  resolve(specifier,context,nextResolve){return specifier==='tesseract.js'?{url:virtualModule,shortCircuit:true}:nextResolve(specifier,context);},
  load(url,context,nextLoad){
   if(url===virtualModule)return {format:'module',shortCircuit:true,
    source:`export async function createWorker(){return globalThis[${JSON.stringify(bridgeKey)}]();}`};
   const result=nextLoad(url,context);
   if(url===moduleUrl){
    const source=String(result.source);assert.ok(source.includes('import.meta.env.BASE_URL'));providedBase=true;
    return {...result,source:source.replaceAll('import.meta.env.BASE_URL',"'/'")};
   }
   return result;
  },
 });
 try{
  const fresh=await import(moduleUrl) as typeof import('../src/features/card-scanner/name-reader');
  assert.equal(providedBase,true);
  await fixture(async({reader,source,state})=>{
   state.reply=()=>reading('');let outcome='pending';const budget=new CardReadBudget(10000),attempts:NameAttempt[]=[];
   const result=reader.matchForIdentify(source,{allowRaw:true,budget,onAttempt:value=>attempts.push(value),acceptQuick:()=>false})
    .then(value=>{outcome='resolved';return value;},error=>{outcome='rejected';throw error;});
   await started;assert.equal(tesseractCalls,1);
   assert.deepEqual(phases(state.requests),['raw-first','raw-second','raw-full','soft','soft']);
   controller.abort();complete({data:{text:'벨루마테',confidence:99}});
   await assert.rejects(result,error=>error===controller.signal.reason&&error instanceof Error&&error.name==='AbortError');
   assert.equal(outcome,'rejected');assert.ok(budget.remaining()>0);
   assert.equal(attempts.some(value=>value.engine==='tesseract'),false);
   assert.ok(state.canvases.filter(canvas=>!canvas.external).every(canvas=>canvas.width===0));
   const metrics=reader.nameOcrMetrics();assert.equal(metrics.invocationFailures,1);assert.equal(metrics.requests,5);
   assert.equal(metrics.failedRequests,0,'a cancelled Tesseract request is outside the Korean neural wrapper request counters');
  },'continue',controller.signal,fresh.createNameReader);
  assert.equal(terminated,1);
 }finally{
  hooks.deregister();globalThis.location=previous.location;
  if(previous.hadBridge)globals[bridgeKey]=previous.bridge;else delete globals[bridgeKey];
 }
});

test('all-empty deterministic policies exhaust Tesseract fallback without inventing an identity',async()=>{
 const bridgeKey='__loaCardTestTesseractAllEmpty',globals=globalThis as unknown as Record<string,unknown>;
 const previous={location:globalThis.location,bridge:globals[bridgeKey],hadBridge:Object.hasOwn(globals,bridgeKey)};
 let tesseractCalls=0,created=0,terminated=0,providedBase=false;
 globals[bridgeKey]=()=>{created++;return {setParameters:async()=>{},terminate:async()=>{terminated++;},recognize:async()=>{
  tesseractCalls++;return {data:{text:'',confidence:0}};
 }};};
 globalThis.location={href:'https://loacard.test/'} as Location;
 const virtualModule='loacard-test:tesseract-all-empty';
 const moduleUrl=new URL('../src/features/card-scanner/name-reader.ts?test=tesseract-all-empty',import.meta.url).href;
 const hooks=registerHooks({
  resolve(specifier,context,nextResolve){return specifier==='tesseract.js'?{url:virtualModule,shortCircuit:true}:nextResolve(specifier,context);},
  load(url,context,nextLoad){
   if(url===virtualModule)return {format:'module',shortCircuit:true,
    source:`export async function createWorker(){return globalThis[${JSON.stringify(bridgeKey)}]();}`};
   const result=nextLoad(url,context);
   if(url===moduleUrl){
    const source=String(result.source);assert.ok(source.includes('import.meta.env.BASE_URL'));providedBase=true;
    return {...result,source:source.replaceAll('import.meta.env.BASE_URL',"'/'")};
   }
   return result;
  },
 });
 try{
  const fresh=await import(moduleUrl) as typeof import('../src/features/card-scanner/name-reader');
  assert.equal(providedBase,true);
  const fallbackCalls=new Map<'continue'|'resample',number>();
  for(const policy of ['continue','resample'] as const)await fixture(async({reader,source,state})=>{
   const attempts:NameAttempt[]=[],before=tesseractCalls;let callbacks=0;
   state.reply=()=>reading('');
   const result=await reader.matchForIdentify(source,{allowRaw:true,budget:new CardReadBudget(10000),
    onAttempt:value=>attempts.push(value),acceptQuick:value=>{callbacks++;assert.equal(value,null);return false;}});
   assert.equal(result,null);assert.equal(callbacks,1);
   const raw=['raw-first','raw-second','raw-full'];
   assert.deepEqual(phases(state.requests),[...raw,...(policy==='resample'?raw:[]),'soft','soft']);
   const metrics=reader.nameOcrMetrics();
   assert.equal(metrics.requests,policy==='continue'?5:8);assert.equal(metrics.reusedRequests,policy==='continue'?3:0);
   assert.equal(metrics.invocationFailures,0);assert.equal(metrics.failedRequests,0);assert.equal(metrics.quickAccepted,0);
   assert.ok(attempts.some(value=>value.engine==='tesseract'));
   assert.deepEqual(attempts.filter(value=>value.engine==='tesseract').slice(-2).map(value=>value.variant),
    ['흑백 원본 · 18px','흑백 원본 · 36px']);
   assert.ok(attempts.every(value=>value.text===''&&value.candidates.length===0));
   fallbackCalls.set(policy,tesseractCalls-before);assert.ok(fallbackCalls.get(policy)!>0);
   assert.ok(state.canvases.filter(canvas=>!canvas.external).every(canvas=>canvas.width===0));
  },policy,undefined,fresh.createNameReader);
  assert.equal(fallbackCalls.get('continue'),fallbackCalls.get('resample'));
  assert.equal(created,2);assert.equal(terminated,2);
 }finally{
  hooks.deregister();globalThis.location=previous.location;
  if(previous.hadBridge)globals[bridgeKey]=previous.bridge;else delete globals[bridgeKey];
 }
});
