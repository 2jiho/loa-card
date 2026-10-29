import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankPortraitPair} from '../src/features/card-scanner/portrait-ranking';

type Candidate={card:{id:string};correlation:number;reference:number};
function original(values:Candidate[]) {
  const best=new Map<string,Candidate>();
  for(const value of values)if(!best.has(value.card.id)||value.correlation>best.get(value.card.id)!.correlation)best.set(value.card.id,value);
  return [...best.values()].sort((a,b)=>b.correlation-a.correlation).slice(0,2);
}
test('top pair preserves stable catalog ties and strongest distinct identities',()=>{
  const values=[['a',.2],['b',.8],['a',.8],['c',.8],['b',.8],['d',.9]] as const;
  const rows=values.map(([id,correlation],reference)=>({card:{id},correlation,reference}));
  assert.deepEqual(rankPortraitPair(rows),original(rows));
  assert.equal(rankPortraitPair(rows)[1],rows[2]);
  assert.deepEqual(rankPortraitPair([]),[]);
  assert.deepEqual(rankPortraitPair(rows.slice(0,1)),rows.slice(0,1));
});
test('linear pair selection matches stable full sorting across duplicate reference catalogs',()=>{
  let seed=12345;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let run=0;run<200;run++) {
    const rows=Array.from({length:1000},(_,reference)=>({card:{id:String(random()%550)},
      correlation:(random()%201-100)/100,reference}));
    const result=rankPortraitPair(rows),expected=original(rows);
    assert.deepEqual(result,expected);
    assert.equal(result[0],expected[0]);assert.equal(result[1],expected[1]);
  }
});
