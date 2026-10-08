import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script=fileURLToPath(new URL('../scripts/audit-card-catalog.mjs',import.meta.url));
const card={id:'100',name:'테스트',rarity:0};
const client={PrimaryKey:100,KoreanName:'테스트 카드',Grade:1,MaxWakeUp:5,Image:'Card_Test'};
function audit(cards:unknown[],records:unknown[]) {
 const dir=mkdtempSync(join(tmpdir(),'loacard-catalog-audit-'));
 try {
  const catalog=join(dir,'cards.json'),input=join(dir,'client.json');
  writeFileSync(catalog,JSON.stringify({cards}));writeFileSync(input,JSON.stringify(records));
  const result=spawnSync(process.execPath,[script,`--catalog=${catalog}`,`--client=${input}`],{encoding:'utf8'});
  assert.equal(result.error,undefined);
  return {status:result.status,report:JSON.parse(result.stdout)};
 } finally {rmSync(dir,{recursive:true,force:true});}
}

test('catalog audit excludes legacy variants and experience materials from missing cards',()=>{
 const {status,report}=audit([card],[client,{...client,PrimaryKey:99},{...client,PrimaryKey:200,KoreanName:'경험치',Image:'Card_Exp_Test'}]);
 assert.equal(status,0);assert.equal(report.matched,1);assert.equal(report.legacyVariants,1);
 assert.deepEqual(report.unmappedCatalog,[]);assert.equal(report.materials.length,1);
});

test('catalog audit fails when the DB has a card absent from the client evidence',()=>{
 const {status,report}=audit([card,{id:'101',name:'누락 카드',rarity:0}],[client]);
 assert.equal(status,1);assert.deepEqual(report.unmappedCatalog,[{id:'101',name:'누락 카드'}]);
});

test('catalog audit rejects duplicate IDs even when every client name matches',()=>{
 const {status,report}=audit([card,{...card,name:'다른 이름'}],[client,{...client,PrimaryKey:101,KoreanName:'다른 이름 카드'}]);
 assert.equal(status,1);assert.equal(report.duplicateCatalogIds.length,1);
});

test('catalog audit rejects normalized duplicate names and unmatched client cards',()=>{
 const duplicate=audit([card,{...card,id:'101',name:'테 스 트'}],[client]);
 assert.equal(duplicate.status,1);assert.equal(duplicate.report.duplicateCanonicalNames.length,1);
 const missing=audit([card],[client,{...client,PrimaryKey:101,KoreanName:'새 카드'}]);
 assert.equal(missing.status,1);assert.equal(missing.report.uncovered.length,1);
});
