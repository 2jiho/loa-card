import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {UnknownLifecycle,UnknownSourceLifecycle,parseUnknownFact} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS,type UnknownFact} from '../src/features/card-scanner/session/unknown-lifecycle-types';

// Optional private state-event regression. It does not authenticate pixels,
// OCR, same-card identity, or demonstrate a premature live-share stop.
const expectedHash='0e1bca2468a8b50cb857e182957d6104e0af9084ee0fe6c333c68fb4fb01141a';
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
type Chunk={data:string;bytes:number;events:number};
type Run={execution:{version:number;codec:string;complete:boolean;dropped:number;events:number;chunkCount:number;lastSeq:number;chunks:Chunk[]}};
type Event={seq:number;type:string;value:unknown};

test('optional private video5 events preserve distinct unknown sources when replayed under v2',
  {skip:!process.env.LOACARD_VIDEO5_POLICY_REPORT},async()=>{
    const path=process.env.LOACARD_VIDEO5_POLICY_REPORT!;
    const bytes=await readFile(path);
    assert.equal(sha(bytes),expectedHash,'input report must be the audited immutable case');
    const {execution}=JSON.parse(bytes.toString('utf8')) as Run;
    assert.equal(execution.version,2);assert.equal(execution.codec,'gzip');
    assert.equal(execution.complete,true);assert.equal(execution.dropped,0);
    assert.equal(execution.chunkCount,142);assert.equal(execution.chunks.length,execution.chunkCount);
    let last=0;
    const selected:Event[]=[];
    for(const chunk of execution.chunks){
      assert.ok(typeof chunk.data==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data));
      const decoded=gunzipSync(Buffer.from(chunk.data,'base64'),{maxOutputLength:8*1024*1024});
      assert.equal(decoded.byteLength,chunk.bytes);
      const lines=decoded.toString('utf8').split('\n').filter(Boolean);
      assert.equal(lines.length,chunk.events);
      for(const line of lines){
        const event=JSON.parse(line) as Event;
        assert.equal(event.seq,++last,'source event stream must be ordered and contiguous');
        const value=event.value as {key?:{kind?:string;group?:number}}|null;
        if(event.type==='unknown-event'&&value?.key?.kind==='group'&&value.key.group===217)selected.push(event);
      }
    }
    assert.equal(last,execution.events);assert.equal(last,execution.lastSeq);assert.equal(last,34535);
    assert.deepEqual(selected.map(event=>event.seq),[6107,6984,9274,24997]);
    assert.ok(selected.every(event=>event.type==='unknown-event'));
    const facts:UnknownFact[]=selected.map(event=>parseUnknownFact(event.value));
    const [first,repeat,proof,failed]=facts;
    assert.ok(first.kind==='upsert'&&repeat.kind==='upsert'&&proof.kind==='retire'&&failed.kind==='upsert');
    assert.ok(first.key.kind==='group'&&repeat.key.kind==='group'&&proof.key.kind==='group'&&failed.key.kind==='group');
    const sessionId=first.key.sessionId,group=first.key.group;
    assert.equal(group,217);
    assert.ok(facts.every(fact=>fact.key.kind==='group'&&fact.key.group===group&&fact.key.sessionId===sessionId));
    assert.ok(first.source&&repeat.source&&failed.source);
    assert.equal(first.source.observationId,'460');assert.equal(repeat.source.observationId,first.source.observationId);
    assert.equal(proof.proof.source.observationId,first.source.observationId);
    assert.equal(failed.source.observationId,'3700');assert.notEqual(failed.source.observationId,proof.proof.source.observationId);
    assert.equal(proof.proof.source.phase,'input');assert.equal(failed.source.phase,'recovery');
    assert.equal(failed.pending,false);assert.ok(failed.source.captureTime<proof.proof.source.captureTime);
    assert.ok(failed.source.captureOrder<proof.proof.source.captureOrder);
    const v1=new UnknownLifecycle({version:1,sessionId,origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS});
    const v2=new UnknownSourceLifecycle({version:2,sessionId,origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS});
    for(const fact of facts){v1.apply(fact);v2.apply(fact);}
    assert.equal(v1.active().length,0,'legacy fuzzy-group proof suppresses the later delivered failure');
    assert.equal(v2.unresolved(),1,'source-scoped replay preserves the distinct failure');
    assert.equal(v2.active()[0].source?.observationId,failed.source.observationId);
    assert.equal(sha(await readFile(path)),expectedHash,'input report changed during validation');
  });
