import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const path=process.argv[2];if(!path)throw new Error('Usage: node scripts/prepare-screen-portraits.mjs calibration.json');
const bytes=await readFile(path),input=JSON.parse(bytes),catalog=JSON.parse(await readFile('public/scanner/cards.json','utf8'));
if(input.errors?.length||input.skipped?.length)throw new Error('Calibration contains unverified or skipped cells');
const byId=new Map(catalog.cards.map(card=>[card.id,card])),cards={},slots=new Set();
for(const row of input.records??[]){
 const card=byId.get(row.id),slot=row.page+'/'+row.slot;
 if(!card||card.name!==row.name||cards[row.id]||slots.has(slot)||(!Number.isFinite(row.alignment)||row.alignment<.8)||
  !Number.isInteger(row.page)||row.page<1||row.page>10||!Number.isInteger(row.slot)||row.slot<0||row.slot>=40||
  Buffer.from(row.portrait,'base64').length!==200)throw new Error('Invalid calibration cell: '+slot);
 slots.add(slot);cards[row.id]=row.portrait;
}
if(!Object.keys(cards).length)throw new Error('No verified portraits');
const result={version:1,source:{kind:'provided-screen-calibration',set:'screenshots-1',sha256:createHash('sha256').update(bytes).digest('hex'),cards:Object.keys(cards).length},
 region:{normalizedWidth:24,normalizedHeight:32,x:2,y:9,width:20,height:10},cards};
await writeFile('public/scanner/screen-artwork-details.json',JSON.stringify(result));
console.log('Prepared '+result.source.cards+' supplemental screen portraits; calibration inputs are not independent test inputs.');
