import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLiveRunReport,createLiveRunReporter} from '../src/features/card-scanner/reproduction/live-run-report';
import {comparabilityIssues} from '../dev/recording-runs';
import type {RunReport} from '../dev/recording-runs';

const state={status:'카드 스캔 중',currentRunRead:364,expected:398,unidentified:[1,2],
  cards:[{id:'a',name:'가',awakening:3,extraCopies:null,extra:'ignored'},{id:'b',name:'나',awakening:null,extraCopies:0}]};

test('the live report has the replay report shape; null and zero stay distinct', () => {
  const report=buildLiveRunReport({recordingId:'r',startedAt:'s',now:'n',state,build:'x',final:false});
  assert.equal(report.summary.mode,'live');
  assert.equal(report.summary.read,364);assert.equal(report.summary.unidentified,2);
  assert.match(report.status,/^\(진행 중\)/);
  assert.deepEqual(report.cards,[{id:'a',name:'가',awakening:3,extraCopies:null},{id:'b',name:'나',awakening:null,extraCopies:0}]);
  assert.equal(report.recording.sha256,null,'unknown until the recording is sealed');
  const final=buildLiveRunReport({recordingId:'r',startedAt:'s',now:'n',state,build:'x',final:true,meta:{sha256:'a'.repeat(64),complete:true,frames:276}});
  assert.equal(final.status,'카드 스캔 중');assert.equal(final.recording.sha256,'a'.repeat(64));assert.equal(final.recording.frames,276);
});

test('updates are sent at most once per interval with the newest state; finish sends the final report', async()=>{
  const sent:{url:string;body:{status:string;live:{final:boolean;timeline:{read:number;queued:number}[]};recording:{sha256:string|null}}}[]=[];
  const request=(async(url:string,init:RequestInit)=>{sent.push({url,body:JSON.parse(init.body as string)});return new Response('{}');}) as unknown as typeof fetch;
  const reporter=createLiveRunReporter({recordingId:'rec 1',build:'b',intervalMs:20,request});
  reporter.update({...state,status:'one'});reporter.update({...state,status:'two'});reporter.update({...state,status:'three'});
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(sent.length,1,'three updates inside one interval make one request');
  assert.match(sent[0].body.status,/three/);assert.equal(sent[0].body.live.final,false);
  assert.equal(sent[0].url,'/__rec/rec%201/runs/live');
  reporter.update({...state,status:'four'});
  await reporter.finish({sha256:'b'.repeat(64),complete:true,frames:5});
  assert.equal(sent.length,2,'finish replaces the pending update');
  assert.equal(sent[1].body.live.final,true);assert.equal(sent[1].body.recording.sha256,'b'.repeat(64));
  assert.equal(sent[1].body.live.timeline.length,2,'one progress point per report, kept across reports');
  assert.equal(sent[1].body.live.timeline[0].read,364);
  reporter.update(state);await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(sent.length,2,'nothing is sent after the final report');
});

test('a failing server never throws into the scan', async()=>{
  const request=(async()=>{throw new Error('offline');}) as unknown as typeof fetch;
  const reporter=createLiveRunReporter({recordingId:'r',build:'b',intervalMs:5,request});
  reporter.update(state);await new Promise(resolve=>setTimeout(resolve,20));
  await assert.doesNotReject(reporter.finish(null));
});

test('a live result and its replay are comparable despite different timing, but only for a complete recording', () => {
  const make=(mode:'live'|'sequential',complete:boolean):RunReport=>({kind:'recording-replay',version:1,startedAt:'',finishedAt:'',
    recording:{id:'r',sha256:'c'.repeat(64),complete,frames:10},delivery:null,status:'',cards:[],
    summary:{build:'b',read:0,expected:null,unidentified:0,meanLateMs:0,maxLateMs:0,lateOver33Ms:0,deliveredRatio:1,mode,faithful:true}});
  assert.deepEqual(comparabilityIssues(make('live',true),make('sequential',true)),[]);
  assert.equal(comparabilityIssues(make('live',false),make('sequential',false)).length,1);
});
