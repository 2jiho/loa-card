import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompletionDrainReservation} from '../src/features/card-scanner/session/completion-drain-reservation';

test('expiry reopens admission while delayed OCR result keeps its old invalid token',async()=>{
 const released:string[]=[],reservation=new CompletionDrainReservation(reason=>released.push(reason),20);
 const first=reservation.start();assert.equal(reservation.valid(first),true);
 await new Promise(resolve=>setTimeout(resolve,60));
 assert.equal(reservation.active,false);assert.deepEqual(released,['expired']);
 const second=reservation.start();assert.notEqual(first,second);
 assert.equal(reservation.finish(first,'finished'),false,'late OCR cannot finish a newer reservation');
 assert.equal(reservation.valid(second),true);
 assert.equal(reservation.finish(second,'invalidated'),true);
 assert.deepEqual(released,['expired','invalidated']);
 reservation.dispose();assert.equal(released.length,2);
});

test('cancellation releases once and a completed reservation cannot fire its timeout',async()=>{
 const released:string[]=[],reservation=new CompletionDrainReservation(reason=>released.push(reason),20);
 reservation.start();reservation.dispose();reservation.dispose();
 assert.deepEqual(released,['disposed']);
 const next=reservation.start();reservation.finish(next,'finished');
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.deepEqual(released,['disposed','finished']);
 assert.throws(()=>new CompletionDrainReservation(()=>{},0));
});
