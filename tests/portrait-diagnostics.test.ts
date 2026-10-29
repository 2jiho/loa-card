import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_PORTRAIT_DIAGNOSTIC_CALLS,MAX_PORTRAIT_DIAGNOSTIC_BYTES,
 parsePortraitDiagnostics,readPortraitDiagnostics} from '../src/features/card-scanner/portrait-diagnostics';

const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const numericChecks=()=>({upper:true,lower:true,correlation:false,margin:false,left:null as boolean|null,right:null as boolean|null});
const textChecks=()=>({...numericChecks(),visibleLength:true,complete:true as boolean|null,hangulComplete:true as boolean|null,
 ocrConfidence:true,score:true,gap:false});
function candidate(second=false,masked=false){return {
 id:second?'card-runner-up':'card-winner',idTruncated:false,upper:.925,lower:.913,
 left:masked?.92:null,right:masked?.91:null,correlation:second?.901:.937,margin:second?-.036:.036,
 evaluatedForAcceptance:!second,registration:{dx:0,dy:0,interpolation:'integer'},
 roi:{upper:{x:2,y:9,width:20,height:5},lower:{x:2,y:14,width:20,height:masked?2:5},
  left:masked?{x:2,y:9,width:10,height:5}:null,right:masked?{x:12,y:9,width:10,height:5}:null}};}
function stage(name='normal',accepted=false){const masked=name.endsWith('above-badge');return {
 stage:name,queryCount:9,candidates:[candidate(false,masked),candidate(true,masked)],
 decision:{textIdMatches:true as boolean|null,
  independent:{evaluated:true,passed:false as boolean|null,checks:numericChecks()},
  text:{evaluated:true,passed:accepted as boolean|null,checks:textChecks()},accepted}};}
function packet(){return {version:1,coordinateSpace:'gray-grid-24x32',outcome:'rejected',reason:'all-stages-rejected',
 fractionalRegistration:true,referenceIdentities:550,
 text:{id:'card-winner',idTruncated:false,ocrConfidence:87.25 as number|null,score:.94 as number|null,gap:.18 as number|null,
  complete:true as boolean|null,visibleNameLength:3,canonicalNameLength:3},
 stages:['normal','above-badge','refined-normal','refined-above-badge'].map(name=>stage(name))};}
const call=()=>({source:'computed',mode:'visual',diagnostic:packet()});
const unavailable=()=>({source:'computed',mode:'visual',diagnostic:{version:1,coordinateSpace:'gray-grid-24x32',
 outcome:'unavailable',reason:'invalid-gray-size',fractionalRegistration:false,referenceIdentities:2,text:null,stages:[]}});
function at(input:unknown,path:readonly (string|number)[],value:unknown):unknown {
 const copy=structuredClone(input);let owner=copy as Record<string|number,unknown>;
 for(const key of path.slice(0,-1))owner=owner[key] as Record<string|number,unknown>;
 owner[path[path.length-1]]=value;return copy;
}
function reject(value:unknown):void{let result:unknown;assert.doesNotThrow(()=>{result=parsePortraitDiagnostics(value);});assert.equal(result,null);}
function frozen(value:unknown):void{if(!value||typeof value!=='object')return;assert.equal(Object.isFrozen(value),true);
 for(const child of Object.values(value))frozen(child);}

test('absent diagnostics remain unavailable while an explicit empty call list is preserved',()=>{
 for(const value of [undefined,null,false,0,'',{},new Uint8Array(0)])reject(value);
 const empty=parsePortraitDiagnostics([]);assert.deepEqual(empty,[]);assert.ok(Object.isFrozen(empty));
 assert.notEqual(empty,parsePortraitDiagnostics([]));
});

test('full rejected packets preserve stages top-two signed margins and individual gate evidence',()=>{
 const input=[call()],parsed=parsePortraitDiagnostics(input);assert.deepEqual(parsed,input);assert.ok(parsed);
 assert.deepEqual(parsed[0].diagnostic.stages.map(value=>value.stage),['normal','above-badge','refined-normal','refined-above-badge']);
 assert.equal(parsed[0].diagnostic.stages[0].candidates[1].margin,-.036);
 assert.equal(parsed[0].diagnostic.stages[0].decision.independent.passed,false);
 assert.equal(parsed[0].diagnostic.stages[0].decision.independent.checks?.left,null);
 assert.equal(parsed[0].diagnostic.stages[0].decision.text.checks?.gap,false);
 assert.equal(parsed[0].diagnostic.stages[1].candidates[0].roi?.lower.height,2);
});

test('unavailable and accepted calls retain exact zero null cached source and reader mode',()=>{
 const zero={...unavailable(),diagnostic:{...unavailable().diagnostic,reason:'insufficient-identities',referenceIdentities:0}};
 const accepted={source:'cached',mode:'refined',diagnostic:{...packet(),outcome:'accepted',reason:'accepted',stages:[stage('refined-normal',true)]}};
 const text={...call(),mode:'text',diagnostic:{...packet(),text:{...packet().text,ocrConfidence:0,score:0,gap:0,complete:null,
  visibleNameLength:0,canonicalNameLength:0}}};
 const parsed=parsePortraitDiagnostics([zero,accepted,text]);assert.ok(parsed);
 assert.equal(parsed[0].diagnostic.referenceIdentities,0);assert.equal(parsed[0].diagnostic.text,null);
 assert.deepEqual(parsed[0].diagnostic.stages,[]);assert.equal(parsed[1].source,'cached');assert.equal(parsed[1].mode,'refined');
 assert.equal(parsed[1].diagnostic.stages[0].decision.accepted,true);assert.equal(parsed[2].mode,'text');
 assert.equal(parsed[2].diagnostic.text?.ocrConfidence,0);assert.equal(parsed[2].diagnostic.text?.complete,null);
 const unknown=parsePortraitDiagnostics([{...call(),diagnostic:{...packet(),text:{...packet().text,ocrConfidence:null,score:null,gap:null}}}]);
 assert.ok(unknown);assert.equal(unknown[0].diagnostic.text?.score,null);
});

test('parser detaches and deeply freezes calls candidates registrations regions and checks',()=>{
 const input=[call()],parsed=parsePortraitDiagnostics(input);assert.ok(parsed);const expected=structuredClone(parsed);
 input[0].source='cached';input[0].diagnostic.text.id='changed';input[0].diagnostic.stages[0].candidates[0].upper=0;
 input[0].diagnostic.stages[0].candidates[0].registration.dx=1;input[0].diagnostic.stages[0].candidates[0].roi.upper.x=0;
 input[0].diagnostic.stages[0].decision.text.checks.gap=true;input.push(call());
 assert.deepEqual(parsed,expected);assert.notEqual(parsed,input);assert.notEqual(parsed[0].diagnostic,input[0].diagnostic);
 frozen(parsed);assert.throws(()=>Object.assign(parsed[0],{mode:'text'}),TypeError);
 assert.throws(()=>Object.assign(parsed[0].diagnostic.stages[0].candidates[0].roi!.upper,{x:0}),TypeError);
});

test('call stage and candidate arrays have exact bounded dense shapes',()=>{
 assert.equal(MAX_PORTRAIT_DIAGNOSTIC_CALLS,3);assert.equal(parsePortraitDiagnostics([call(),call(),call()])?.length,3);
 reject([call(),call(),call(),call()]);
 reject(at([call()],[0,'diagnostic','stages'],Array.from({length:5},()=>stage())));
 reject(at([call()],[0,'diagnostic','stages',0,'candidates'],[candidate(),candidate(true),candidate()]));
 for(const path of [[],[0,'diagnostic','stages'],[0,'diagnostic','stages',0,'candidates']] as const){
  for(const invalid of [new Array(1),Object.assign([],{extra:1}),new Uint8Array(1),{length:1,0:call()}]){
   if(!path.length)reject(invalid);else reject(at([call()],path,invalid));
  }
 }
 const candidates=parsePortraitDiagnostics(at([call()],[0,'diagnostic','stages',0,'candidates'],[]));assert.ok(candidates);
 assert.deepEqual(candidates[0].diagnostic.stages[0].candidates,[]);
});

test('nonfinite values and invalid scalar types never enter the diagnostic projection',()=>{
 const numericPaths=[['referenceIdentities'],['text','ocrConfidence'],['text','score'],['text','gap'],['text','visibleNameLength'],
  ['stages',0,'queryCount'],['stages',0,'candidates',0,'upper'],['stages',0,'candidates',0,'lower'],
  ['stages',0,'candidates',0,'left'],['stages',0,'candidates',0,'right'],['stages',0,'candidates',0,'correlation'],
  ['stages',0,'candidates',0,'margin'],['stages',0,'candidates',0,'registration','dx'],
  ['stages',0,'candidates',0,'roi','upper','x'],['stages',0,'candidates',0,'roi','upper','height']];
 for(const path of numericPaths)for(const value of [NaN,Infinity,-Infinity,'0',undefined])reject(at([call()],[0,'diagnostic',...path],value));
 for(const patch of [{source:'remote'},{source:null},{mode:'ocr'},{mode:undefined},{diagnostic:null}])reject([{...call(),...patch}]);
 for(const [path,value] of [[['version'],2],[['version'],'1'],[['coordinateSpace'],'pixels'],[['outcome'],'unknown'],
  [['reason'],'missing'],[['fractionalRegistration'],1],[['stages',0,'decision','accepted'],null],
  [['stages',0,'decision','independent','evaluated'],null],[['text','complete'],'true']] as const)
  reject(at([call()],[0,'diagnostic',...path],value));
});

test('numeric boundaries preserve Float32 measurement precision signed gaps and bounded counts',()=>{
 const input=[call()];const d=input[0].diagnostic;d.referenceIdentities=20_000;d.text.visibleNameLength=65_536;d.text.canonicalNameLength=65_536;
 d.text.ocrConfidence=100;d.text.score=-2;d.text.gap=2;d.stages[0].queryCount=81;
 const c=d.stages[0].candidates[0];c.upper=-1.0001;c.lower=1.0001;c.correlation=1.0001;c.margin=-2.0002;c.left=-1.0001;c.right=1.0001;
 const parsed=parsePortraitDiagnostics(input);assert.ok(parsed);assert.equal(parsed[0].diagnostic.stages[0].candidates[0].correlation,1.0001);
 assert.equal(parsed[0].diagnostic.stages[0].candidates[0].margin,-2.0002);assert.equal(parsed[0].diagnostic.text?.score,-2);
 for(const [path,values] of [
  [['referenceIdentities'],[-1,20_001,.5]],[['text','visibleNameLength'],[-1,65_537,1.5]],[['text','canonicalNameLength'],[-1,65_537,1.5]],
  [['text','ocrConfidence'],[-.0001,100.0001]],[['text','score'],[-2.0001,2.0001]],[['text','gap'],[-2.0001,2.0001]],
  [['stages',0,'queryCount'],[-1,82,.5]],[['stages',0,'candidates',0,'upper'],[-1.0001001,1.0001001]],
  [['stages',0,'candidates',0,'margin'],[-2.0002001,2.0002001]]] as const)
  for(const value of values)reject(at([call()],[0,'diagnostic',...path],value));
 assert.ok(parsePortraitDiagnostics(at([call()],[0,'diagnostic','stages',0,'queryCount'],0)));
});

test('registration offsets stay bounded quarter-grid measurements rather than arbitrary transforms',()=>{
 for(const dx of [-1,-.75,-.5,-.25,0,.25,.5,.75,1]){
  const registration={dx,dy:0,interpolation:Number.isInteger(dx)?'integer':'bilinear'};
  const parsed=parsePortraitDiagnostics(at([call()],[0,'diagnostic','stages',0,'candidates',0,'registration'],registration));
  assert.ok(parsed);assert.deepEqual(parsed[0].diagnostic.stages[0].candidates[0].registration,registration);
 }
 for(const registration of [{dx:1.25,dy:0,interpolation:'bilinear'},{dx:0,dy:-1.25,interpolation:'bilinear'},
  {dx:.1,dy:0,interpolation:'bilinear'},{dx:0,dy:0,interpolation:'cubic'},{dx:0,dy:0},
  {dx:0,dy:0,interpolation:'integer',pixels:new Uint8Array(0)}])
  reject(at([call()],[0,'diagnostic','stages',0,'candidates',0,'registration'],registration));
 for(const registration of [{dx:0,dy:0,interpolation:'bilinear'},{dx:.25,dy:0,interpolation:'integer'}])
  reject(at([call()],[0,'diagnostic','stages',0,'candidates',0,'registration'],registration));
 reject(at([call()],[0,'diagnostic','stages',0,'candidates',0,'registration'],null));
 const noRegistration=at(at([call()],[0,'diagnostic','stages',0,'candidates',0,'registration'],null),[0,'diagnostic','stages',0,'candidates',0,'roi'],null);
 const parsed=parsePortraitDiagnostics(noRegistration);
 assert.ok(parsed);assert.equal(parsed[0].diagnostic.stages[0].candidates[0].registration,null);
});

test('ROI coordinates are grid-bounded metadata and cannot carry source pixels or unconstrained boxes',()=>{
 const path=[0,'diagnostic','stages',0,'candidates',0,'roi','upper'] as const;
 const full={x:0,y:0,width:24,height:32};assert.ok(parsePortraitDiagnostics(at([call()],path,full)));
 for(const box of [{...full,x:-.01},{...full,y:-.01},{...full,x:.01},{...full,y:.01},
  {...full,width:0},{...full,height:0},{...full,width:24.01},{...full,height:32.01},{...full,pixels:[]}])reject(at([call()],path,box));
 reject(at([call()],[0,'diagnostic','stages',0,'candidates',0,'roi'],null));
 const nullRoi=parsePortraitDiagnostics(at(at([call()],[0,'diagnostic','stages',0,'candidates',0,'roi'],null),
  [0,'diagnostic','stages',0,'candidates',0,'registration'],null));assert.ok(nullRoi);
 assert.equal(nullRoi[0].diagnostic.stages[0].candidates[0].roi,null);
});

test('identifiers retain explicit truncation metadata and reject controls oversized and missing names',()=>{
 for(const path of [[0,'diagnostic','text','id'],[0,'diagnostic','stages',0,'candidates',0,'id']] as const){
  assert.ok(parsePortraitDiagnostics(at([call()],path,'한'.repeat(96))));
  for(const value of ['',undefined,null,'x'.repeat(97),'bad\nname','bad\u0085name'])reject(at([call()],path,value));
 }
 const input=at([call()],[0,'diagnostic','stages',0,'candidates',0,'idTruncated'],true);
 const parsed=parsePortraitDiagnostics(input);assert.ok(parsed);assert.equal(parsed[0].diagnostic.stages[0].candidates[0].idTruncated,true);
 reject(at([call()],[0,'diagnostic','text','idTruncated'],1));
});

test('unknown fields binary arrays and cycles cannot become an accidental recording payload',()=>{
 const paths=[[],[0],[0,'diagnostic'],[0,'diagnostic','text'],[0,'diagnostic','stages',0],
  [0,'diagnostic','stages',0,'candidates',0],[0,'diagnostic','stages',0,'candidates',0,'registration'],
  [0,'diagnostic','stages',0,'candidates',0,'roi'],[0,'diagnostic','stages',0,'candidates',0,'roi','upper'],
  [0,'diagnostic','stages',0,'decision'],[0,'diagnostic','stages',0,'decision','independent'],
  [0,'diagnostic','stages',0,'decision','independent','checks'],[0,'diagnostic','stages',0,'decision','text','checks']];
 for(const path of paths)reject(at([call()],[...path,'pixels'],new Uint8Array(1)));
 for(const value of [new ArrayBuffer(4),new DataView(new ArrayBuffer(4)),new Map(),new Set(),new Date()])reject(value);
 const cyclic=[call()];Object.assign(cyclic[0].diagnostic,{cycle:cyclic});reject(cyclic);
 const stageCycle=[call()];(stageCycle[0].diagnostic.stages as unknown[]).push(stageCycle);reject(stageCycle);
});

test('accessors and executable serialization hooks are rejected without running user code',()=>{
 let called=0;const paths=[[],[0],[0,'diagnostic'],[0,'diagnostic','text'],[0,'diagnostic','stages'],
  [0,'diagnostic','stages',0],[0,'diagnostic','stages',0,'candidates'],[0,'diagnostic','stages',0,'candidates',0],
  [0,'diagnostic','stages',0,'candidates',0,'registration'],[0,'diagnostic','stages',0,'candidates',0,'roi','upper'],
  [0,'diagnostic','stages',0,'decision','independent','checks']];
 for(const path of paths){
  const input=[call()];let target:unknown=input;for(const key of path)target=(target as Record<string|number,unknown>)[key];
  const obj=target as Record<string,unknown>,key=Array.isArray(target)?'0':Object.keys(obj)[0];
  Object.defineProperty(obj,key,{enumerable:true,configurable:true,get(){called++;throw new Error('must not execute');}});reject(input);
 }
 for(const hook of ['toJSON','valueOf','toString']){
  const input=[call()];Object.defineProperty(input[0].diagnostic,hook,{enumerable:true,value(){called++;return {};}});reject(input);
 }
 assert.equal(called,0);
});

test('nonenumerable symbol custom prototype and iterator injection is rejected at nested boundaries',()=>{
 let called=0;
 for(const path of [[],[0],[0,'diagnostic'],[0,'diagnostic','stages',0,'candidates',0]] as const){
  for(const kind of ['hidden','symbol','prototype','iterator']){
   const input=[call()];let target:unknown=input;for(const key of path)target=(target as Record<string|number,unknown>)[key];
   if(kind==='hidden')Object.defineProperty(target,'extra',{value:1});
   if(kind==='symbol')Object.defineProperty(target,Symbol('extra'),{value:1});
   if(kind==='prototype')Object.setPrototypeOf(target,{get inherited(){called++;return 1;}});
   if(kind==='iterator')Object.defineProperty(target,Symbol.iterator,{value(){called++;throw new Error('must not iterate');}});
   reject(input);
  }
 }
 assert.equal(called,0);
 const plain=call();Object.setPrototypeOf(plain,null);Object.setPrototypeOf(plain.diagnostic,null);
 assert.ok(parsePortraitDiagnostics([plain]));
});

test('maximum bounded packet stays below64KiB and arbitrary padding is not truncated into validity',()=>{
 assert.equal(MAX_PORTRAIT_DIAGNOSTIC_BYTES,65_536);
 const input=Array.from({length:3},()=>call());
 for(const value of input){value.diagnostic.text.id='한'.repeat(96);
  for(const s of value.diagnostic.stages)for(const c of s.candidates)c.id='한'.repeat(96);}
 const parsed=parsePortraitDiagnostics(input);assert.ok(parsed);assert.ok(bytes(parsed)<=MAX_PORTRAIT_DIAGNOSTIC_BYTES);
 const oversized=at(input,[0,'diagnostic','text','id'],'x'.repeat(MAX_PORTRAIT_DIAGNOSTIC_BYTES+1));reject(oversized);
 const padded=at(input,[0,'diagnostic','padding'],'x'.repeat(MAX_PORTRAIT_DIAGNOSTIC_BYTES));reject(padded);
 assert.deepEqual(parsePortraitDiagnostics(input),parsed);
});

test('outer projection only reads its own data property without invoking inherited or accessor hooks',()=>{
 const input=[call()],outer={portraitDiagnostics:input};const parsed=readPortraitDiagnostics(outer);assert.deepEqual(parsed,input);assert.ok(parsed);
 input[0].diagnostic.referenceIdentities=0;assert.equal(parsed[0].diagnostic.referenceIdentities,550);
 for(const value of [undefined,null,{},[],{portraitDiagnostics:undefined},{portraitDiagnostics:null},{portraitDiagnostics:[{source:'bad'}]}])
  assert.equal(readPortraitDiagnostics(value),null);
 assert.deepEqual(readPortraitDiagnostics({portraitDiagnostics:[]}),[]);
 let called=0;const accessor=Object.defineProperty({},'portraitDiagnostics',{enumerable:true,get(){called++;return [call()];}});
 const inherited=Object.create({get portraitDiagnostics(){called++;return [call()];}});
 assert.equal(readPortraitDiagnostics(accessor),null);assert.equal(readPortraitDiagnostics(inherited),null);assert.equal(called,0);
 const hidden=Object.defineProperty({},'portraitDiagnostics',{value:[call()]});assert.equal(readPortraitDiagnostics(hidden),null);
 const unrelated=Object.defineProperty({portraitDiagnostics:[call()]},'image',{enumerable:true,get(){called++;throw new Error('must not read');}});
 Object.defineProperty(unrelated,'toJSON',{value(){called++;throw new Error('must not serialize');}});
 assert.ok(readPortraitDiagnostics(unrelated));assert.equal(called,0);
 const own=Object.assign(Object.create(null),{portraitDiagnostics:[call()]});assert.ok(readPortraitDiagnostics(own));
});
