import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inventoryCsv,parseInventoryCsv} from '../src/inventory-csv';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';
const card=(name:string,awakening:number|null,extraCopies:number|null):ScannedCard=>({id:name,name,awakening,extraCopies,countReliable:true,review:[],confidence:1,image:'private pixels',time:0,observations:1});
test('CSV presence means ownership and retains zero extra copies with exactly three columns',()=>{
 assert.equal(inventoryCsv([card('세리아',5,0),card('실리안',0,12)]),'\uFEFF이름,각수,카드수\r\n세리아,5,0\r\n실리안,0,12\r\n');
 assert.equal(inventoryCsv([]),'\uFEFF이름,각수,카드수\r\n');
});
test('unread fields remain blank rather than becoming zero and metadata stays out of CSV',()=>{
 const csv=inventoryCsv([card('카드',null,null)]);
 assert.equal(csv,'\uFEFF이름,각수,카드수\r\n카드,,\r\n');
 assert.doesNotMatch(csv,/private|confidence|observations/);
});
test('names with delimiters or formulas remain a single literal spreadsheet cell',()=>{
 assert.equal(inventoryCsv([card('이름,"별명"\n다음',1,2)]),'\uFEFF이름,각수,카드수\r\n"이름,""별명""\n다음",1,2\r\n');
 assert.match(inventoryCsv([card('=1+1',0,0)]),/\r\n'=1\+1,0,0/);
});

const catalog=[{id:'seria',name:'세리아',rarity:1,maxAwakening:5,icon:'https://example.com/seria.png'},
 {id:'sillian',name:'실리안',rarity:4,maxAwakening:5},{id:'special',name:'특별 카드',rarity:3,maxAwakening:0}];
test('CSV imports canonical identities, explicit zero counts and no fabricated capture evidence',()=>{
 const result=parseInventoryCsv('\uFEFF이름,각수,카드수\r\n세리아,4,5\r\n실리안,5,0\r\n특별 카드,0,0',catalog);
 assert.deepEqual(result.map(c=>[c.id,c.awakening,c.extraCopies]),[['seria',4,5],['sillian',5,0],['special',0,0]]);
 assert.ok(result.every(c=>c.observations===0&&c.countReliable&&c.review.length===0));
 // Even an older catalog containing an external icon must not supply capture evidence.
 assert.ok(result.every(c=>c.image===''));
 assert.equal(inventoryCsv(result),'\uFEFF이름,각수,카드수\r\n세리아,4,5\r\n실리안,5,0\r\n특별 카드,0,0\r\n');
});
test('CSV accepts standard quoted cells, LF and normalized Korean names',()=>{
 const result=parseInventoryCsv(`"이름","각수","카드수"\n" ${'세리아'.normalize('NFD')} ",0,15\n\n`,catalog);
 assert.equal(result[0].name,'세리아');assert.equal(result[0].extraCopies,15);
});
test('every awakening level enforces its remaining extra-copy limit',()=>{
 for(let awakening=0;awakening<=5;awakening++) {
   const limit=15-awakening*(awakening+1)/2;
   assert.equal(parseInventoryCsv(`이름,각수,카드수\n세리아,${awakening},${limit}`,catalog)[0].extraCopies,limit);
   assert.throws(()=>parseInventoryCsv(`이름,각수,카드수\n세리아,${awakening},${limit+1}`,catalog));
 }
 assert.throws(()=>parseInventoryCsv('이름,각수,카드수\n세리아,4,10',catalog),/최대 보유량/);
});
test('a bad row prevents the entire import and names cannot be fuzzy matched',()=>{
 for(const row of ['세리야,0,0','세리아,,0','세리아,0,','세리아,6,0','세리아,-1,0','세리아,1.5,0',
   ',,','세리아,0,1e1','세리아,0,NaN','세리아,0,Infinity','세리아,0,-1','세리아,0,16','세리아,0,0,1',
   '특별 카드,1,0','특별 카드,0,1']) {
   assert.throws(()=>parseInventoryCsv(`이름,각수,카드수\n실리안,5,0\n${row}`,catalog),/3행/);
 }
 assert.throws(()=>parseInventoryCsv('이름,각수,카드수\n세리아,0,0\n세리아,0,0',catalog),/중복/);
});
test('empty, malformed or unsupported files never replace the inventory',()=>{
 for(const source of ['', 'name,awakening,copies\na,0,0','이름,각수,카드수\n',
  '이름,각수,카드수\n"세리아,0,0','이름,각수,카드수\n"세리아"x,0,0'])
  assert.throws(()=>parseInventoryCsv(source,catalog));
 assert.throws(()=>parseInventoryCsv('x'.repeat(1_048_577),catalog),/1MB/);
 assert.throws(()=>parseInventoryCsv('이름,각수,카드수\n세리아,0,0',[]),/DB/);
});
