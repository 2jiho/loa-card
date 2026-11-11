import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCountSourceDiagnostics} from '../dev/count-source-diagnostics';
import {analyzeCountSourceProbe} from '../scripts/analyze-count-source-probe.mjs';

test('bounded count metadata records omissions and closes without retaining pixels',()=>{
 const sink=createCountSourceDiagnostics({maxEvents:1});
 const event={version:1,source:{},raster:null} as any;
 assert.equal(sink.record(event),true);assert.equal(sink.record(event),false);
 sink.close();assert.equal(sink.record(event),false);
 const e=sink.snapshot();assert.equal(e.recorded,1);assert.equal(e.omitted,1);assert.equal(e.physicalSourceVerified,false);
 assert.equal(analyzeCountSourceProbe({countSourceEvidence:e,validation:{countSourceProbeRequested:true}}).status,'partial');
});
test('unknown historical reports and incomplete records cannot imply source proof',()=>{
 assert.equal(analyzeCountSourceProbe({}).requested,null);
 const hash='a'.repeat(64),e={events:[{version:1,source:{},raster:null}],attempted:1,recorded:1,omitted:0,retainedEveryDeliveredCallback:true};
 const report={validation:{countSourceProbeRequested:true,completed:true,sourceChanged:false,sourceStart:{sourceDigest:hash},sourceEnd:{sourceDigest:hash}},countSourceEvidence:e,
  performance:{countSourceProbe:{measured:0,reused:0,missing:1,recordingComplete:true}}};
 assert.equal(analyzeCountSourceProbe(report).status,'observed-callbacks');
 assert.match(analyzeCountSourceProbe(report).scope,/do not establish physical/);
 report.performance.countSourceProbe.recordingComplete=false;
 assert.equal(analyzeCountSourceProbe(report).status,'partial');
});
