import test from 'node:test';
import assert from 'node:assert/strict';
import {toPartialSnapshot} from '../src/partial-snapshot';
import type {ScannerState} from '../src/features/card-scanner/orchestration/scanner';
import {sanitizePartialSnapshot} from '../src/features/card-scanner/persistence/partial-store';

test('partial projection strips pixels and marks unresolved fields without inventing certainty',()=>{
 const card=(id:string,options:Record<string,unknown>={})=>({id,name:id,awakening:4,extraCopies:5,countReliable:true,review:[],image:'secret-pixels',nameEvidence:[{secret:'ocr'}],...options});
 const state={expected:4,growthPoints:{current:12,maximum:100},cards:[card('ok'),card('review',{review:['이름 확인'],extraCopies:10}),card('count',{countReliable:false}),card('impossible',{extraCopies:10})]} as unknown as ScannerState;
 const out=sanitizePartialSnapshot(toPartialSnapshot(state));
 assert.deepEqual(out.cards[0],{id:'ok',name:'ok',identityUncertain:false,awakening:4,extraCopies:5});
 assert.deepEqual(out.cards[1],{id:'review',name:'review',identityUncertain:true,awakening:null,extraCopies:null});
 assert.equal(out.cards[2].extraCopies,null);assert.equal(out.cards[3].extraCopies,null);
 assert.ok(!JSON.stringify(out).includes('secret'));assert.equal(out.cards.length,4);
});
