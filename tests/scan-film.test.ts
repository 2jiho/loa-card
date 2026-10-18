import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScanFilm} from '../src/features/card-scanner/scan-film';
import type {ScanActivityItem} from '../src/features/card-scanner/scan-activity';
const items=(start:number,count:number):ScanActivityItem[]=>Array.from({length:count},(_,i)=>({id:start+i,image:`crop-${start+i}`,status:'reading'}));
test('bursts and status updates do not replace the active incoming card',()=>{
 const film=new ScanFilm();film.ingest(items(0,4));film.prepare(4);
 film.ingest(items(4,10));const before=film.prepare(4);assert.equal(before.incomingId,4);
 film.ingest([{...items(4,1)[0],status:'read',name:'resolved'},...items(14,10)]);
 const during=film.prepare(4);assert.equal(during.incomingId,4);
 assert.deepEqual(during.items.map(i=>i.id),[0,1,2,3,4]);assert.equal(during.items[4].name,'resolved');
 film.complete();assert.deepEqual(film.prepare(4).items.map(i=>i.id),[1,2,3,4,8]);
});
test('paused bursts retain visible items and bound pending thumbnails',()=>{
 const film=new ScanFilm();film.ingest(items(0,4));const frozen=film.prepare(4);
 for(let i=4;i<1000;i+=16)film.ingest(items(i,16));
 assert.deepEqual(film.snapshot().items.map(i=>i.id),frozen.items.map(i=>i.id));
 let steps=0;while(film.prepare(4).incomingId!==null){film.complete();steps++;}
 assert.equal(steps,16);assert.equal(film.snapshot().items.length,4);
});
test('duplicate snapshots do not restart completed animations',()=>{
 const film=new ScanFilm();const source=items(0,6);film.ingest(source);film.prepare(4);
 film.complete();film.prepare(4);film.complete();film.ingest(source);
 assert.equal(film.prepare(4).incomingId,null);assert.deepEqual(film.snapshot().items.map(i=>i.id),[2,3,4,5]);
});
test('reduced motion consumes pending work without an animation and resize stays bounded',()=>{
 const film=new ScanFilm();film.ingest(items(0,16));film.prepare(10);const reduced=film.prepare(4,true);
 assert.equal(reduced.incomingId,null);assert.deepEqual(reduced.items.map(i=>i.id),[12,13,14,15]);
 assert.equal(film.prepare(2).items.length,2);
});

test('flow accelerates with backlog without changing an active move',()=>{
 const film=new ScanFilm();film.ingest(items(0,4));film.prepare(4);
 film.ingest(items(4,1));const normal=film.prepare(4);assert.ok(normal.durationMs<=240);
 film.ingest(items(5,16));const active=film.prepare(4);
 assert.equal(active.durationMs,normal.durationMs);assert.equal(active.incomingId,normal.incomingId);
 film.complete();const fast=film.prepare(4);assert.equal(fast.durationMs,100);
 let duration=0,steps=0;
 while(film.snapshot().incomingId!==null){duration+=film.snapshot().durationMs;steps++;film.complete();film.prepare(4);}
 assert.equal(steps,16);assert.ok(duration<3000,`backlog took ${duration}ms`);
});
