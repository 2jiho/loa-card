// Run with: node --import tsx scripts/audit-withheld-cards.mjs --report=path.json
// Leave each true identity out of the catalog, then test its real screenshot.
// This is an open-set boundary check, not a guarantee for future game artwork.
import fs from 'node:fs';
import path from 'node:path';
import {createPortraitMatcher} from '../src/features/card-scanner/portrait-matcher.ts';
import {matchCardName} from '../src/features/card-scanner/card-dictionary.ts';
import {confirmName,confirmCatalogName} from '../src/features/card-scanner/name-confidence.ts';
const root=path.resolve(import.meta.dirname,'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const {cards}=read('public/scanner/cards.json');
const atlas=read('public/scanner/artwork-details.json');
const supplement=read('public/scanner/screen-artwork-details.json').cards;
const sources=[
 {name:'screenshots-1',rows:read('tests/fixtures/artwork-detail-samples.json').map(row=>({
  ...row,id:cards.find(card=>card.name===row.expected)?.id}))},
 {name:'screenshots-2',rows:read('tests/fixtures/screen-portrait-holdout.json').rows.map(row=>({...row,id:row.expected}))},
];
const portraits=[];
for(const source of sources){
 const report={source:source.name,tested:0,rejected:0,misidentified:[]};
 for(const row of source.rows){
  if(!row.id)continue;
  const remaining=object=>Object.fromEntries(Object.entries(object).filter(([id])=>id!==row.id));
  const result=createPortraitMatcher(cards.filter(card=>card.id!==row.id),remaining(atlas),remaining(supplement))
   (Uint8Array.from(Buffer.from(row.gray,'base64')));
  report.tested++;
  if(result)report.misidentified.push({removedId:row.id,actualId:result.card.id,name:result.card.name,evidence:result.portrait});
  else report.rejected++;
 }
 portraits.push(report);
}
const names={tested:cards.length,candidates:[]};
for(const removed of cards){
 const result=matchCardName(removed.name,cards.filter(card=>card.id!==removed.id));
 if(!result)continue;
 const evidence={...result,rawText:removed.name,complete:true,ocrConfidence:100};
 names.candidates.push({removed:removed.name,actual:result.card.name,score:result.score,gap:result.gap,
  textOnlyConfirmed:confirmName(evidence,true),identityConfirmed:confirmCatalogName(evidence,true)});
}
const report={portraits,names,limitations:[
 'Name inputs are exact catalog strings, not fresh OCR model outputs.',
 'Known cards are withheld one at a time; future cards with reused artwork are not represented.',
 'This probes portrait and OCR-to-catalog boundaries, not end-to-end acquisition or UI.',
]};
const output=process.argv.find(arg=>arg.startsWith('--report='))?.slice(9);
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(portraits.some(row=>row.misidentified.length)||names.candidates.some(row=>row.identityConfirmed))process.exitCode=1;
