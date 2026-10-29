import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNameReader} from '../src/features/card-scanner/name-reader';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/card-read-budget';
import {createGrayNameFirstLine,NAME_GRAY_FIRST_RECIPE} from '../src/features/card-scanner/name-gray-first';
import type {CatalogName} from '../src/features/card-scanner/card-dictionary';
import type {NameAttempt} from '../src/features/card-scanner/name-diagnostics';
import type {NeuralReading} from '../src/features/card-scanner/neural-reader';

type Request={id:number;type:string;model:string;width:number;height:number;data:Uint8ClampedArray;useLexicon:boolean;nameLine?:{group:string;line:number}};
const catalog=[{id:'raw',name:'벨루마테',rarity:2},{id:'other',name:'아크투루스',rarity:2}];
const isGrayFallback=(request:Request)=>request.height===18&&request.width===128&&request.useLexicon===false&&request.nameLine===undefined;
function labelPixels(){
 const data=new Uint8ClampedArray(128*36*4);
 for(let y=2;y<14;y++)for(let x=12;x<72;x++)if(x%5<2){const p=(y*128+x)*4;data.set([20,180,220,255],p);}
 return data;
}
async function fixture(run:(state:ReturnType<typeof setup>)=>Promise<void>,cards:(CatalogName&{feature?:string})[]=catalog){
 const state=setup(cards);
 try{await state.reader.ready();await run(state);}finally{await state.reader.dispose();state.restore();}
}
function setup(cards:(CatalogName&{feature?:string})[],contrastNameFallback=false){
 const previous={Worker:globalThis.Worker,document:globalThis.document,ImageData:globalThis.ImageData};
 const state={raw:'벨루마트',gray:'벨루마테',grayConfidence:.98,grayCandidates:undefined as NeuralReading['candidates'],
  rawCost:0,clock:0,hangGray:false,visible:true,artwork:new Uint8ClampedArray(24*32*4),label:labelPixels(),
  requests:[] as Request[],workers:[] as FakeWorker[],canvases:[] as FakeCanvas[]};
 class FakeWorker {
  onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;terminations=0;
  constructor(){state.workers.push(this);}
  postMessage(value:unknown,transfer:Transferable[]=[]){
   const request=structuredClone(value,{transfer}) as Request;
   if(request.type==='ready'){queueMicrotask(()=>this.onmessage?.({data:{id:request.id,result:null}}));return;}
   state.requests.push(request);const gray=isGrayFallback(request);
   if(gray&&state.hangGray)return;
   if(!gray)state.clock+=state.rawCost;
   queueMicrotask(()=>this.onmessage?.({data:{id:request.id,result:{text:gray?state.gray:state.raw,
    confidence:gray?state.grayConfidence:.98,...(gray&&state.grayCandidates?{candidates:state.grayCandidates}:{})}}}));
  }
  terminate(){this.terminations++;}
 }
 class FakeImageData {constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}}
 class FakeCanvas {
  width=140;height=210;private pixels=new Uint8ClampedArray();grayPaint=false;
  constructor(readonly external=false){state.canvases.push(this);}
  private raster(){if(this.pixels.length!==this.width*this.height*4)this.pixels=new Uint8ClampedArray(this.width*this.height*4);return this.pixels;}
  getContext(){return {
   drawImage:(source:FakeCanvas,...args:number[])=>{
    if(source.external){this.pixels=(this.width===24&&this.height===32?state.artwork:state.visible?state.label:new Uint8ClampedArray(128*36*4)).slice();return;}
    const [sx,sy,sw,sh,dx,dy,dw,dh]=args.length===8?args:[0,0,source.width,source.height,args[0]??0,args[1]??0,args[2]??source.width,args[3]??source.height];
    const original=source.raster(),output=this.raster();
    for(let y=0;y<dh;y++)for(let x=0;x<dw;x++){
     const src=((sy+Math.floor(y*sh/dh))*source.width+sx+Math.floor(x*sw/dw))*4;
     const dst=((dy+y)*this.width+dx+x)*4;output.set(original.subarray(src,src+4),dst);
    }
   },
   clearRect:(x:number,y:number,width:number,height:number)=>{const pixels=this.raster();for(let row=y;row<y+height;row++)pixels.fill(0,(row*this.width+x)*4,(row*this.width+x+width)*4);},
   createImageData(width:number,height:number){return {width,height,data:new Uint8ClampedArray(width*height*4)};},
   putImageData:(image:FakeImageData)=>{this.pixels=image.data.slice();this.grayPaint=this.width===128&&this.height===18&&image.data.every((v,i)=>i%4===3||v===image.data[i-i%4]);},
   getImageData:(x:number,y:number,width:number,height:number)=>{const original=this.raster(),data=new Uint8ClampedArray(width*height*4);
    for(let row=0;row<height;row++)for(let col=0;col<width;col++){const src=((y+row)*this.width+x+col)*4;data.set(original.subarray(src,src+4),(row*width+col)*4);}return {data};},
  };}
 }
 globalThis.Worker=FakeWorker as unknown as typeof Worker;globalThis.ImageData=FakeImageData as unknown as typeof ImageData;
 globalThis.document={createElement:()=>new FakeCanvas()} as unknown as Document;
 const reader=createNameReader(cards,undefined,undefined,{contrastNameFallback}),source=new FakeCanvas(true) as unknown as HTMLCanvasElement;
 const read=(flag=false,quick=false,bypass=true,budget=new CardReadBudget(1000),attempts:NameAttempt[]=[])=>reader.match(source,quick,0,true,a=>attempts.push(a),budget,bypass,undefined,flag);
 return {state,reader,source,read,restore(){globalThis.Worker=previous.Worker;globalThis.document=previous.document;globalThis.ImageData=previous.ImageData;}};
}

test('opt-in contrast retry accepts only exact greedy text and keeps raw matches first',async()=>{
 for(const exact of [true,false]){
  const f=setup(catalog,true);
  try{
   for(let i=3;i<f.state.label.length;i+=4)f.state.label[i]=255;
   f.state.gray=exact?'벨루마테':'벨루마트';await f.reader.ready();
   const result=await f.read(false);
   assert.equal(result?.preprocessing,exact?'stretch-first-v1':undefined);
   assert.equal(f.state.requests.filter(isGrayFallback).length,1);
   f.state.raw='벨루마테';f.state.requests.length=0;
   assert.equal((await f.read(false))?.card.id,'raw');assert.equal(f.state.requests.filter(isGrayFallback).length,0);
  }finally{await f.reader.dispose();f.restore();}
 }
});

test('contrast retry skips quick/non-bypass reads and cannot prime their name cache',async()=>{
 const f=setup(catalog,true);
 try{
  for(let i=3;i<f.state.label.length;i+=4)f.state.label[i]=255;
  await f.reader.ready();
  assert.equal((await f.read())?.preprocessing,'stretch-first-v1');
  for(const [quick,bypass] of [[true,true],[false,false]]){
   f.state.requests.length=0;
   const attempts:NameAttempt[]=[];
   const result=await f.read(false,quick,bypass,new CardReadBudget(1000),attempts);
   assert.equal(result?.exact,false);
   assert.equal(f.state.requests.filter(isGrayFallback).length,0);
   assert.equal(attempts.some(a=>a.engine==='cache'),false);
  }
 }finally{await f.reader.dispose();f.restore();}
});

test('contrast retry requires the greedy string itself and rejects lexicon-only or cleaned matches',async()=>{
 for(const text of ['아크투루수','XY벨루마테']){
  const f=setup(catalog,true);
  try{
   for(let i=3;i<f.state.label.length;i+=4)f.state.label[i]=255;
   f.state.gray=text;f.state.grayCandidates=[{id:'other',name:'아크투루스',relativeLikelihood:1,margin:1}];
   await f.reader.ready();const result=await f.read();
   assert.equal(result?.rawText,'벨루마트');assert.equal(result?.exact,false);
   assert.equal(result?.preprocessing,undefined);
  }finally{await f.reader.dispose();f.restore();}
 }
});

test('contrast retry shares the card deadline and frees its raster when OCR hangs',async()=>{
 const f=setup(catalog,true);
 try{
  for(let i=3;i<f.state.label.length;i+=4)f.state.label[i]=255;
  f.state.rawCost=2;f.state.hangGray=true;await f.reader.ready();
  const budget=new CardReadBudget(10,()=>f.state.clock);
  await assert.rejects(f.read(false,false,true,budget),CardReadTimeout);
  assert.equal(f.state.requests.filter(isGrayFallback).length,1);
  assert.equal(budget.remaining(),4);
  assert.ok(f.state.workers.some(w=>w.terminations>0));
  assert.ok(f.state.canvases.filter(c=>c.grayPaint).every(c=>c.width===0&&c.height===0));
 }finally{await f.reader.dispose();f.restore();}
});

test('flag off preserves raw fallback and adds no greedy grayscale request',async()=>{
 await fixture(async({read,state})=>{
  const result=await read();assert.equal(result?.rawText,'벨루마트');assert.equal(result?.exact,false);
  assert.equal(state.requests.filter(isGrayFallback).length,0);assert.equal('preprocessing' in result!,false);
 });
});

test('raw exact remains authoritative even if gray would choose another name',async()=>{
 await fixture(async({read,state})=>{
  state.raw='벨루마테';state.gray='아크투루스';const result=await read(true);
  assert.equal(result?.card.id,'raw');assert.equal(result?.rawText,'벨루마테');assert.equal(state.requests.length,1);
  assert.equal(state.requests.filter(isGrayFallback).length,0);assert.equal('preprocessing' in result!,false);
 });
});

test('quick and non-bypass calls skip the opt-in precision-only gray fallback',async()=>{
 for(const [quick,bypass] of [[true,true],[false,false]])await fixture(async({read,state})=>{
  await read(true,quick,bypass);assert.equal(state.requests.filter(isGrayFallback).length,0);
 });
});

test('one exact grayscale greedy read uses the actual first-line recipe and original budget after raw failure',async()=>{
 await fixture(async({read,state})=>{
  const attempts:NameAttempt[]=[],before=state.label.slice(),budget=new CardReadBudget(1000);
  const result=await read(true,false,true,budget,attempts),gray=state.requests.filter(isGrayFallback);
  assert.equal(result?.card.id,'raw');assert.equal(result?.exact,true);assert.equal(result?.rawText,'벨루마테');
  assert.equal(result?.preprocessing,NAME_GRAY_FIRST_RECIPE);assert.equal(result?.ctc,undefined);
  assert.equal(gray.length,1);assert.equal(state.requests.length,4);
  assert.deepEqual(state.requests.slice(0,3).map(v=>[v.height,v.useLexicon,v.nameLine?.line]),[[18,true,0],[18,false,1],[36,true,undefined]]);
  assert.deepEqual(gray[0].data,createGrayNameFirstLine(before));assert.equal(gray[0].nameLine,undefined);assert.equal(gray[0].useLexicon,false);
  assert.deepEqual(state.label,before);assert.equal(attempts.filter(a=>a.variant===NAME_GRAY_FIRST_RECIPE).length,1);
  assert.ok(result?.fingerprint,'the existing label-family diagnostic key is retained');
  assert.ok(state.canvases.filter(c=>c.grayPaint).every(c=>c.width===0&&c.height===0));
 });
});

test('unconfirmed gray candidates cannot replace a retained raw candidate or be promoted by lexicon scores',async()=>{
 await fixture(async({read,state})=>{
  state.gray='아크투루수';state.grayCandidates=[{id:'other',name:'아크투루스',relativeLikelihood:1,margin:1}];
  const result=await read(true);assert.equal(result?.card.id,'raw');assert.equal(result?.rawText,'벨루마트');
  assert.equal(result?.exact,false);assert.equal('preprocessing' in result!,false);assert.equal(state.requests.filter(isGrayFallback).length,1);
 });
});

test('derived gray input keeps the original label-family observation instead of emitting a new capture',async()=>{
 await fixture(async({reader,source,state})=>{
  let observations=0;
  const result=await reader.match(source,false,0,true,undefined,new CardReadBudget(1000),true,(pixels,recipe)=>{
   observations++;assert.equal(pixels.width,128);assert.equal(pixels.height,36);assert.deepEqual(pixels.data,state.label);
   assert.equal(recipe.region,'initial-name-label');
  },true);
  assert.equal(result?.preprocessing,NAME_GRAY_FIRST_RECIPE);assert.equal(observations,1);
 });
});

test('gray needs the greedy canonical name itself, not the raw path ASCII-cleaning shortcut',async()=>{
 await fixture(async({read,state})=>{
  state.gray='XY벨루마테';const result=await read(true);assert.equal(result?.rawText,'벨루마트');assert.equal(result?.exact,false);
  assert.equal('preprocessing' in result!,false);
 });
});

test('a successful gray input cannot populate the ordinary name-mask cache for a flag-off call',async()=>{
 await fixture(async({read,state})=>{
  assert.equal((await read(true))?.preprocessing,NAME_GRAY_FIRST_RECIPE);
  const previousCalls=state.requests.length,attempts:NameAttempt[]=[];
  const next=await read(false,true,false,new CardReadBudget(1000),attempts);
  assert.equal(next?.exact,false);assert.equal(next?.rawText,'벨루마트');assert.equal(state.requests.length,previousCalls+1);
  assert.equal(attempts.some(a=>a.engine==='cache'),false);
 });
});

test('shared budget timeout cancels a hanging gray read and releases its Canvas without a fresh budget',async()=>{
 await fixture(async({read,state})=>{
  state.rawCost=2;state.hangGray=true;const budget=new CardReadBudget(10,()=>state.clock);
  await assert.rejects(read(true,false,true,budget),CardReadTimeout);
  assert.equal(state.requests.filter(isGrayFallback).length,1);assert.equal(state.clock,6);assert.equal(budget.remaining(),4);
  assert.ok(state.workers.some(w=>w.terminations>0));assert.ok(state.canvases.filter(c=>c.grayPaint).every(c=>c.width===0&&c.height===0));
 });
});

function artwork(kind:number){const bytes=new Uint8Array(720),rgba=new Uint8ClampedArray(24*32*4);
 for(let i=0;i<100;i++){const value=kind===0?(i*37)%256:(i*11+51)%256;
  for(let c=0;c<3;c++){bytes[120+3*i+c]=value;rgba[((8+Math.floor(i/20))*24+2+i%20)*4+c]=value;}}
 return {feature:Buffer.from(bytes).toString('base64'),rgba};
}
test('independently corroborated raw artwork returns before any gray request',async()=>{
 const a=artwork(0),b=artwork(1),cards=[{id:'art',name:'영원의 아크 카양겔',rarity:4,feature:a.feature},
  {id:'other',name:'빛을 맞이하는 실리안',rarity:4,feature:b.feature}];
 await fixture(async({read,state})=>{
  state.raw='영원의 아크 카양';state.gray='빛을 맞이하는 실리안';state.artwork=a.rgba;
  const result=await read(true);assert.equal(result?.card.id,'art');assert.ok(result?.artwork);
  assert.equal(state.requests.length,3);assert.equal(state.requests.filter(isGrayFallback).length,0);
 },cards);
});
