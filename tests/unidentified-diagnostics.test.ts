import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_RETAINED_DIAGNOSTIC_IMAGES,MAX_UNIDENTIFIED_DIAGNOSTIC_BYTES,MAX_UNIDENTIFIED_DIAGNOSTIC_ENTRIES,MAX_UNIDENTIFIED_NAME_ATTEMPTS,summarizeUnidentified} from '../src/features/card-scanner/unidentified-diagnostics';

const uri=(index:number)=>`data:image/png;base64,${index}privatePixels`;
const source=(index:number)=>({sessionId:'session-1',frameId:100+index,observationId:`observation-${index}`,captureOrder:200+index,
 captureTime:3,phase:'recovery' as const,slot:index%40,frame:`frame-key-${index}`,image:uri(1000+index),canvas:{privatePixels:uri(2000+index)}});
const input=(index:number)=>({image:uri(index),time:3,captureOrder:200+index,group:index,pending:false,reason:`failure-${index}`,
 location:{percent:50,column:index%10+1,row:20+Math.floor(index/10)},source:source(index)});
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('all 14 unidentified groups remain diagnosable when only 12 exact preview images were retained',()=>{
 const entries=Array.from({length:14},(_,index)=>input(index)),retained=entries.slice(0,12).map(({image,time})=>({image,time,reason:'thumbnail'}));
 const summary=summarizeUnidentified(entries,retained);
 assert.equal(summary.entries.length,14);assert.equal(summary.omitted,0);
 assert.deepEqual(summary.entries.map(entry=>entry.group),Array.from({length:14},(_,index)=>index));
 assert.deepEqual(summary.entries.map(entry=>entry.retainedImageIndex),[0,1,2,3,4,5,6,7,8,9,10,11,null,null]);
 assert.ok(summary.entries.every(entry=>entry.recognitionImageIndex===null));
 assert.equal(summary.entries[12].source?.observationId,'observation-12');assert.equal(summary.entries[13].source?.frameId,113);
 assert.equal(summary.entries[12].time,3);assert.equal(summary.entries[13].time,3);
 assert.equal('frame' in summary.entries[0].source!,false);assert.doesNotMatch(JSON.stringify(summary),/privatePixels|data:image|frame-key/);
});

test('exact duplicate images reuse the first retained index without merging equal-time groups or sources',()=>{
 const first=input(0),second={...input(1),image:first.image};
 const summary=summarizeUnidentified([first,second],[{image:first.image},{image:first.image},{image:uri(5),time:3}]);
 assert.deepEqual(summary.entries.map(entry=>entry.retainedImageIndex),[0,0]);
 assert.deepEqual(summary.entries.map(entry=>entry.group),[0,1]);
 assert.deepEqual(summary.entries.map(entry=>entry.source?.observationId),['observation-0','observation-1']);
 const absent=summarizeUnidentified([input(2)],[{image:uri(500),time:3}]);assert.equal(absent.entries[0].retainedImageIndex,null,'equal capture time does not link another image');
});

test('recognition and preview indices distinguish reused, separate and quota-excluded original crops',()=>{
 const a=input(0),b=input(1),c=input(2);
 const summary=summarizeUnidentified([{...a,recognitionImage:a.image},{...b,recognitionImage:uri(11)},{...c,recognitionImage:uri(12)}],
  [{image:a.image},{image:b.image},{image:uri(11)},{image:c.image}]);
 assert.deepEqual(summary.entries.map(entry=>[entry.retainedImageIndex,entry.recognitionImageIndex]),[[0,0],[1,2],[3,null]]);
});

test('14 different recognition/preview pairs keep all 28 indices inside the 32-image lookup bound',()=>{
 const entries=Array.from({length:14},(_,index)=>({...input(index),recognitionImage:uri(100+index)}));
 const retained=entries.flatMap(entry=>[{image:entry.recognitionImage},{image:entry.image}]);
 const summary=summarizeUnidentified(entries,retained);
 assert.deepEqual(summary.entries.map(entry=>[entry.recognitionImageIndex,entry.retainedImageIndex]),entries.map((_,index)=>[index*2,index*2+1]));
 const images=Array.from({length:MAX_RETAINED_DIAGNOSTIC_IMAGES+1},(_,index)=>({image:uri(index)}));
 assert.equal(summarizeUnidentified([{image:uri(32),recognitionImage:uri(31)}],images).entries[0].retainedImageIndex,null);
 assert.equal(summarizeUnidentified([{image:uri(32),recognitionImage:uri(31)}],images).entries[0].recognitionImageIndex,31);
});

test('output snapshots contain no input objects or image strings and survive later source/location mutations',()=>{
 const entry=input(0),images=[{image:entry.image}],summary=summarizeUnidentified([entry],images),snapshot=JSON.stringify(summary);
 entry.source.frameId=999;entry.source.observationId='changed';entry.location.row=99;entry.reason='changed';entry.image=uri(99);images[0].image=uri(100);
 assert.equal(JSON.stringify(summary),snapshot);assert.notEqual(summary.entries[0].source,entry.source);assert.notEqual(summary.entries[0].location,entry.location);
 assert.ok(Object.isFrozen(summary));assert.ok(Object.isFrozen(summary.entries));assert.ok(Object.isFrozen(summary.entries[0]));
 assert.ok(Object.isFrozen(summary.entries[0].source));assert.ok(Object.isFrozen(summary.entries[0].location));
 assert.doesNotMatch(snapshot,/privatePixels|data:image|canvas|image"/);
});

test('malformed metadata stays unknown while valid fields and other diagnostic rows remain available',()=>{
 const good=input(0),bad={image:uri(1),time:NaN,captureOrder:-1,group:'0',pending:'false',reason:42,
  location:{percent:50,column:2,row:-1},source:{...source(1),slot:40}};
 const summary=summarizeUnidentified([null,bad,good],[]);
 assert.equal(summary.entries.length,3);assert.equal(summary.omitted,0);
 assert.deepEqual(summary.entries[0],{group:null,captureOrder:null,time:null,pending:null,reason:null,location:null,source:null,retainedImageIndex:null,recognitionImageIndex:null,nameAttempts:null,nameAttemptsOmitted:null,portraitDiagnostics:null});
 assert.deepEqual(summary.entries[1],{group:null,captureOrder:null,time:null,pending:null,reason:null,location:{percent:50,column:2},source:null,retainedImageIndex:null,recognitionImageIndex:null,nameAttempts:null,nameAttemptsOmitted:null,portraitDiagnostics:null});
 assert.equal(summary.entries[2].source?.frameId,100);
 for(const invalidSource of [{...source(0),sessionId:'x'.repeat(161)},{...source(0),observationId:''},{...source(0),frameId:Infinity},
  {...source(0),captureTime:-1},{...source(0),phase:'unknown'},{...source(0),slot:-1}]){
  const entry=summarizeUnidentified([{...good,source:invalidSource}],[]).entries[0];assert.equal(entry.source,null);assert.equal(entry.group,0);assert.equal(entry.reason,'failure-0');
 }
});

test('explicit zero metadata is preserved and missing source fields are never filled from the top-level entry',()=>{
 const zero={group:0,captureOrder:0,time:0,pending:false,source:{sessionId:'s',observationId:'o',frameId:0,captureOrder:0,captureTime:0,phase:'input',slot:0},
  location:{percent:0,column:1,row:1}};
 const summary=summarizeUnidentified([zero,{...zero,source:{...zero.source,captureTime:undefined}}],[]);
 assert.equal(summary.entries[0].time,0);assert.equal(summary.entries[0].source?.frameId,0);assert.equal(summary.entries[0].source?.captureTime,0);
 assert.equal(summary.entries[1].source,null);assert.equal(summary.entries[1].time,0);
});

test('reason and source bounds cap metadata without truncating identifiers into another identity',()=>{
 const entry={...input(0),reason:'한'.repeat(400),source:{...source(0),sessionId:'가'.repeat(160),observationId:'나'.repeat(160)}};
 const summary=summarizeUnidentified([entry],[]);assert.equal(summary.entries[0].reason?.length,300);assert.equal(summary.entries[0].source?.sessionId.length,160);
 assert.equal(summarizeUnidentified([{...entry,source:{...entry.source,observationId:'나'.repeat(161)}}],[]).entries[0].source,null);
});

test('UTF-8 cap covers the complete summary envelope and reports every excluded suffix entry',()=>{
 const entry={...input(0),reason:'한'.repeat(300),source:{...source(0),sessionId:'가'.repeat(160),observationId:'나'.repeat(160)}};
 const exactOne=bytes(summarizeUnidentified([entry],[])),entries=Array.from({length:5},()=>entry);
 const limited=summarizeUnidentified(entries,[],{maxBytes:exactOne});
 assert.equal(limited.entries.length,1);assert.equal(limited.omitted,4);assert.equal(bytes(limited),exactOne);
 assert.ok(bytes(limited)>JSON.stringify(limited).length,'Korean UTF8 uses more than one byte per code unit');
 const all=summarizeUnidentified(Array.from({length:1200},()=>entry),[]);
 assert.ok(all.entries.length<MAX_UNIDENTIFIED_DIAGNOSTIC_ENTRIES);assert.equal(all.omitted,1200-all.entries.length);assert.ok(bytes(all)<=MAX_UNIDENTIFIED_DIAGNOSTIC_BYTES);
});

test('entry limits and optional smaller test budgets cannot exceed fixed production upper bounds',()=>{
 const entries=Array.from({length:1001},(_,index)=>({group:index})),summary=summarizeUnidentified(entries,[]);
 assert.equal(summary.entries.length,1000);assert.equal(summary.omitted,1);
 assert.deepEqual(summarizeUnidentified(entries,[],{maxEntries:0}),{entries:[],omitted:1001});
 const two=summarizeUnidentified(entries,[],{maxEntries:2});assert.deepEqual(two.entries.map(entry=>entry.group),[0,1]);assert.equal(two.omitted,999);
 for(const limits of [{maxEntries:1001},{maxEntries:-1},{maxEntries:.5},{maxBytes:MAX_UNIDENTIFIED_DIAGNOSTIC_BYTES+1},{maxBytes:0}])assert.throws(()=>summarizeUnidentified(entries,[],limits),/상한/);
});

test('only bounded exact data URIs link retained slots and unknown image/canvas fields are never traversed',()=>{
 const tricky={...source(0),get unknownImage(){assert.fail('unknown source field must not be read');}},invalidSource={...source(1)};
 Object.defineProperty(invalidSource,'slot',{get(){throw Error('broken source');}});
 const summary=summarizeUnidentified([{...input(0),source:tricky},{...input(1),source:invalidSource},{image:'https://example.com/card.png'},
  {image:'data:image/png;base64,'+'x'.repeat(262_144)}], [{image:uri(0)},{image:'https://example.com/card.png'},
  {image:'data:image/png;base64,'+'x'.repeat(262_144)}]);
 assert.equal(summary.entries[0].retainedImageIndex,0);assert.equal(summary.entries[0].source?.slot,0);assert.equal(summary.entries[1].source,null);
 assert.equal(summary.entries[2].retainedImageIndex,null);assert.equal(summary.entries[3].retainedImageIndex,null);
 assert.doesNotMatch(JSON.stringify(summary),/data:image|example\.com|unknownImage|privatePixels/);
});

const attempt=()=>({text:'하누마탄',confidence:48.5,engine:'ppocr',variant:'grayscale',reason:'OCR 신뢰도 부족',
 candidates:[{id:'card-1',name:'하누마탄',score:.98},{id:'card-2',name:'다른 카드',score:.3}],image:uri(999),canvas:{privatePixels:uri(1000)}});

test('OCR text, confidence, rejection reason and candidate values are preserved as diagnostic metadata only',()=>{
 const summary=summarizeUnidentified([{...input(0),nameAttempts:[attempt()]}],[]),row=summary.entries[0];
 assert.equal(row.nameAttemptsOmitted,0);assert.deepEqual(row.nameAttempts,[{text:'하누마탄',confidence:48.5,engine:'ppocr',variant:'grayscale',reason:'OCR 신뢰도 부족',
  candidates:[{id:'card-1',name:'하누마탄',score:.98},{id:'card-2',name:'다른 카드',score:.3}],candidatesOmitted:0}]);
 assert.equal(row.group,0);assert.doesNotMatch(JSON.stringify(summary),/privatePixels|data:image|canvas|"image"/);
});

test('missing OCR attempts stay null while explicitly zero attempts stay an empty array',()=>{
 const summary=summarizeUnidentified([{},{nameAttempts:undefined},{nameAttempts:null},{nameAttempts:'[]'},{nameAttempts:[]}],[]);
 for(const row of summary.entries.slice(0,4)){assert.equal(row.nameAttempts,null);assert.equal(row.nameAttemptsOmitted,null);}
 assert.deepEqual(summary.entries[4].nameAttempts,[]);assert.equal(summary.entries[4].nameAttemptsOmitted,0);
});

test('attempt and candidate arrays have fixed independent caps and never execute custom array iterators',()=>{
 const candidates=Array.from({length:8},(_,index)=>({id:`card-${index}`,name:`후보 ${index}`,score:index/10}));
 const attempts=Array.from({length:30},()=>({...attempt(),candidates}));
 attempts[Symbol.iterator]=function*(){assert.fail('attempt iterator must not run');};
 candidates[Symbol.iterator]=function*(){assert.fail('candidate iterator must not run');};
 const row=summarizeUnidentified([{nameAttempts:attempts}],[]).entries[0];
 assert.equal(row.nameAttempts?.length,MAX_UNIDENTIFIED_NAME_ATTEMPTS);assert.equal(row.nameAttemptsOmitted,6);
 for(const item of row.nameAttempts!){assert.equal(item.candidates?.length,3);assert.equal(item.candidatesOmitted,5);}
 assert.deepEqual(row.nameAttempts?.[0].candidates?.map(candidate=>candidate.id),['card-0','card-1','card-2']);
});

test('malformed attempt fields preserve unknown values without fabricating numeric zero or discarding other attempts',()=>{
 const bad={text:44,confidence:NaN,engine:{},variant:null,reason:false,candidates:[{id:'x'.repeat(161),name:false,score:Infinity},null,
  {id:'known',name:'후보',score:0}]};
 const row=summarizeUnidentified([{nameAttempts:[null,bad,{...attempt(),confidence:0,candidates:[]}]}],[]).entries[0];
 assert.equal(row.nameAttemptsOmitted,0);assert.equal(row.nameAttempts?.length,3);
 assert.deepEqual(row.nameAttempts?.[0],{text:null,confidence:null,engine:null,variant:null,reason:null,candidates:null,candidatesOmitted:null});
 assert.deepEqual(row.nameAttempts?.[1],{text:null,confidence:null,engine:null,variant:null,reason:null,candidates:[
  {id:null,name:null,score:null},{id:null,name:null,score:null},{id:'known',name:'후보',score:0}],candidatesOmitted:0});
 assert.equal(row.nameAttempts?.[2].confidence,0);assert.deepEqual(row.nameAttempts?.[2].candidates,[]);
});

test('OCR strings are bounded, candidate IDs are not truncated into another identity, and snapshots detach input mutations',()=>{
 const original={text:'한'.repeat(1000),confidence:77,engine:'e'.repeat(100),variant:'v'.repeat(100),reason:'사'.repeat(1000),
 candidates:[{id:'i'.repeat(160),name:'이'.repeat(500),score:.6}]};
 const summary=summarizeUnidentified([{nameAttempts:[original]}],[]),snapshot=JSON.stringify(summary),row=summary.entries[0].nameAttempts![0];
 assert.equal(row.text?.length,120);assert.equal(row.engine?.length,32);assert.equal(row.variant?.length,64);assert.equal(row.reason?.length,300);
 assert.equal(row.candidates?.[0].id?.length,160);assert.equal(row.candidates?.[0].name?.length,160);
 original.text='changed';original.confidence=0;original.candidates[0].id='changed';original.candidates.push({id:'new',name:'new',score:0});
 assert.equal(JSON.stringify(summary),snapshot);assert.ok(Object.isFrozen(summary.entries[0].nameAttempts));assert.ok(Object.isFrozen(row));
 assert.ok(Object.isFrozen(row.candidates));assert.ok(Object.isFrozen(row.candidates?.[0]));
});

const portrait=()=>[{source:'computed',mode:'visual',diagnostic:{version:1,coordinateSpace:'gray-grid-24x32',outcome:'unavailable',reason:'insufficient-identities',
 fractionalRegistration:false,referenceIdentities:0,text:null,stages:[]}}];

test('portrait projection preserves explicit no calls while legacy and invalid metadata stay null',()=>{
 const values=[undefined,null,{},'[]',[],portrait()];
 const summary=summarizeUnidentified(values.map(portraitDiagnostics=>({...input(0),nameAttempts:[attempt()],portraitDiagnostics})),[]);
 for(const row of summary.entries.slice(0,4))assert.equal(row.portraitDiagnostics,null);
 assert.deepEqual(summary.entries[4].portraitDiagnostics,[]);assert.deepEqual(summary.entries[5].portraitDiagnostics,portrait());
 for(const row of summary.entries){assert.equal(row.group,0);assert.equal(row.pending,false);assert.equal(row.nameAttempts?.[0].text,'하누마탄');}
 assert.doesNotMatch(JSON.stringify(summary),/privatePixels|data:image|canvas/);
});

test('portrait projection rejects accessor, cyclic, nonfinite and unsupported data without suppressing the warning',()=>{
 let accessed=0;const accessor={...input(0),nameAttempts:[attempt()],get portraitDiagnostics(){accessed++;throw Error('diagnostic getter');}};
 const cyclic:unknown[]=[];cyclic.push(cyclic);
 const bad=[cyclic,[{...portrait()[0],diagnostic:{...portrait()[0].diagnostic,referenceIdentities:Infinity}}],
  [{...portrait()[0],diagnostic:{...portrait()[0].diagnostic,pixels:[0,1,2]}}]];
 const summary=summarizeUnidentified([accessor,...bad.map(portraitDiagnostics=>({...input(0),nameAttempts:[attempt()],portraitDiagnostics}))],[]);
 assert.equal(accessed,0);assert.equal(summary.entries.length,4);assert.equal(summary.omitted,0);
 for(const row of summary.entries){assert.equal(row.portraitDiagnostics,null);assert.equal(row.reason,'failure-0');assert.equal(row.nameAttempts?.length,1);}
});

test('portrait diagnostic snapshots detach input and share the unchanged complete-envelope byte and row caps',()=>{
 const calls=portrait(),entry={...input(0),portraitDiagnostics:calls};
 const snapshot=summarizeUnidentified([entry],[]),saved=JSON.stringify(snapshot);
 calls[0].diagnostic.referenceIdentities=7;assert.equal(JSON.stringify(snapshot),saved);
 const oneBytes=bytes(snapshot),limited=summarizeUnidentified([entry,entry],[],{maxBytes:oneBytes});
 assert.equal(limited.entries.length,1);assert.equal(limited.omitted,1);assert.ok(bytes(limited)<=oneBytes);
 const largeCalls=Array.from({length:3},()=>({...portrait()[0],diagnostic:{...portrait()[0].diagnostic,
  text:{id:'한'.repeat(96),idTruncated:false,ocrConfidence:null,score:null,gap:null,complete:null,visibleNameLength:0,canonicalNameLength:0}}}));
 const many=summarizeUnidentified(Array.from({length:1200},()=>({...input(0),portraitDiagnostics:largeCalls})),[]);
 assert.ok(many.entries.length>0);assert.ok(many.entries.length<MAX_UNIDENTIFIED_DIAGNOSTIC_ENTRIES);
 assert.equal(many.omitted,1200-many.entries.length);assert.ok(bytes(many)<=MAX_UNIDENTIFIED_DIAGNOSTIC_BYTES);
 assert.equal(MAX_RETAINED_DIAGNOSTIC_IMAGES,32);
});

test('OCR attempt metadata is included in the existing whole-summary UTF-8 byte bound',()=>{
 const fullAttempt={text:'한'.repeat(120),confidence:88,engine:'검'.repeat(32),variant:'형'.repeat(64),reason:'유'.repeat(300),
 candidates:Array.from({length:3},(_,index)=>({id:'a'.repeat(159)+index,name:'이'.repeat(160),score:.5}))};
 const entry={...input(0),nameAttempts:Array.from({length:24},()=>fullAttempt)};
 const exactOne=bytes(summarizeUnidentified([entry],[])),limited=summarizeUnidentified([entry,entry,entry],[],{maxBytes:exactOne});
 assert.equal(limited.entries.length,1);assert.equal(limited.omitted,2);assert.equal(bytes(limited),exactOne);
 const production=summarizeUnidentified(Array.from({length:14},()=>entry),[]);
 assert.ok(bytes(production)<=MAX_UNIDENTIFIED_DIAGNOSTIC_BYTES);assert.equal(production.omitted,14-production.entries.length);
 assert.ok(production.entries.length<14,'oversized OCR text cannot bypass the shared metadata budget');
});
