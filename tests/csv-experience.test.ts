import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {csvInventoryState,parseCsvExperience,parseInventoryCsv,inventoryCsv} from '../src/inventory-csv';
import {createScanBackup} from '../src/features/card-scanner/scan-backup';

const cards=()=>parseInventoryCsv('이름,각수,카드수\n세리아,0,15',[{id:'seria',name:'세리아',rarity:1}]);

test('CSV experience accepts integers and thousands separators, preserving unknown versus zero',()=>{
  for(const [input,value] of [['',null],['  ',null],['0',0],['000',0],[' 1,234,567 ',1234567],['1234567',1234567]] as const)
    assert.equal(parseCsvExperience(input),value);
  for(const input of ['-1','1.5','1e6','+5','NaN','Infinity','12,34','1,','1 234','123원','9007199254740992'])
    assert.throws(()=>parseCsvExperience(input),/정수/);
});

test('CSV import validates XP before replacing state and does not fabricate a capacity or scan history',async()=>{
  const factory=new IDBFactory(),backup=createScanBackup(()=>factory);
  await backup.load();
  await backup.save({...csvInventoryState(cards(),'999'),growthPointsEstimated:true});
  assert.throws(()=>csvInventoryState(cards(),'-1'));
  assert.equal((await backup.load())?.growthPoints?.current,999);
  const imported=csvInventoryState(cards(),'1,234,567');
  assert.deepEqual(imported.growthPoints,{current:1234567,maximum:null});
  assert.equal(imported.growthHistory,undefined);
  assert.equal(imported.growthPointsEstimated,undefined);
  await backup.save(imported);
  assert.deepEqual((await backup.load())?.growthPoints,imported.growthPoints);
  await backup.save(csvInventoryState(cards(),'0'));
  assert.equal((await backup.load())?.growthPoints?.current,0);
  await backup.save(csvInventoryState(cards(),''));
  assert.equal((await backup.load())?.growthPoints,null);
  assert.equal(inventoryCsv(imported.cards),'\uFEFF이름,각수,카드수\r\n세리아,0,15\r\n');
});
