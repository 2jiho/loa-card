import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {borderIntegrity} from '../src/features/card-scanner/acquisition/border-integrity';
import {FreshnessEvidence,type FreshnessBinding} from '../src/features/card-scanner/session/freshness-evidence';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';

/** The crop is real, but all source associations below are synthetic. This is
 * a boundary demonstration, not a replay of the original live session. */
test('a real tooltip crop is rejected, while a reused group alone can currently retire unknown debt',()=>{
 const samples=JSON.parse(readFileSync(new URL('./fixtures/border-integrity-samples.json',import.meta.url),'utf8'));
 const tooltip=samples.find((sample:{name:string})=>sample.name==='하이비 집행관 · 툴팁 가림');
 assert.ok(tooltip);
 assert.equal(borderIntegrity(Uint8Array.from(Buffer.from(tooltip.rgba,'base64')),tooltip.width,tooltip.height,tooltip.box).intact,false);
 const source=(n:number,slot:number):ObservationSource=>({sessionId:'synthetic',frameId:n,observationId:`obs-${n}`,
  captureOrder:n*100,captureTime:n,phase:'input',slot});
 const binding:FreshnessBinding={key:'unrelated-card',order:200,frame:'other-view',stable:true};
 const fields=new Map<string,number>([['other-card',200]]);
 const tracker=new FreshnessEvidence({version:1,sessionId:'synthetic',limits:{groups:10,facts:100}},{confirmedFields:()=>fields});
 tracker.apply({version:1,kind:'rejected',group:1,time:1,source:source(1,2),binding:null,pixelKey:'tooltip-pixels'});
 assert.equal(tracker.guard('capture').settled,false);
 // The group number here is deliberately reused; it proves no continuity of
 // card identity. The existing reducer replaces the prior unresolved debt.
 tracker.apply({version:1,kind:'accepted',group:1,time:2,source:source(2,5),binding,pixelKey:'different-card',fieldRevision:null,requiresProof:true});
 tracker.apply({version:1,kind:'identity-linked',binding,source:source(2,5),pixelKey:'different-card',id:'other-card',review:[]});
 assert.equal(tracker.guard('capture').settled,true,'documents current unsafe group replacement, not a safe completion policy');
});
