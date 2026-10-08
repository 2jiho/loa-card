import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const catalogPath=process.argv.find(a=>a.startsWith('--catalog='))?.slice(10) ?? path.join(root,'public/scanner/cards.json');
const input=process.argv.find(a=>a.startsWith('--client='))?.slice(9) ?? path.join(root,'work/client-assets/db/card-image-mapping.json');
const catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'));
const records=JSON.parse(fs.readFileSync(input,'utf8'));
const normalize=s=>s.normalize('NFKC').replace(/\s/g,'');
const comparable=s=>normalize(s).replace(/카드$/,'');
const report={catalog:catalog.cards.length,clientRecords:records.length,matched:[],materials:[],legacyVariants:[],uncovered:[],ambiguous:[],conflicts:[],aliases:[],growthUpdates:[],unmappedCatalog:[],duplicateCatalogIds:[],duplicateCanonicalNames:[]};
const duplicateKeys=key=>{
 const groups=new Map();
 for(const card of catalog.cards){const value=key(card);groups.set(value,[...(groups.get(value)??[]),card.id]);}
 return [...groups].filter(([,ids])=>ids.length>1).map(([value,ids])=>({value,ids}));
};
report.duplicateCatalogIds=duplicateKeys(card=>card.id);
report.duplicateCanonicalNames=duplicateKeys(card=>comparable(card.name));
for(const row of records){
 if(row.Image.startsWith('Card_Exp_')){report.materials.push(row.KoreanName);continue;}
 const matches=catalog.cards.filter(c=>comparable(c.name)===comparable(row.KoreanName));
 if(!matches.length){report.uncovered.push(row);continue;}
 if(matches.length!==1){report.ambiguous.push(row);continue;}
 const card=matches[0];
 if(String(row.PrimaryKey)!==card.id&&records.some(r=>String(r.PrimaryKey)===card.id)){
  report.legacyVariants.push({id:row.PrimaryKey,name:row.KoreanName,currentId:card.id});continue;
 }
 if(String(row.PrimaryKey)===card.id&&card.rarity===row.Grade-1&&row.MaxWakeUp===0&&card.maxAwakening===undefined){
  report.growthUpdates.push({id:card.id,name:card.name,maxAwakening:0});
  if(process.argv.includes('--apply-aliases')){
   card.maxAwakening=0;card.growthSource='local-client:SeasonCard(SecondaryKey=0)';
   card.growthClientEvidence={primaryKeys:[row.PrimaryKey],grade:row.Grade,maxWakeUp:0};
  }
 }
 if(card.rarity!==row.Grade-1||(card.maxAwakening??5)!==row.MaxWakeUp){report.conflicts.push({name:row.KoreanName,id:card.id});continue;}
 report.matched.push({id:card.id,name:row.KoreanName,primaryKey:row.PrimaryKey});
 if(normalize(card.name)!==normalize(row.KoreanName)){
  report.aliases.push({id:card.id,canonical:card.name,alias:row.KoreanName});
  if(process.argv.includes('--apply-aliases'))card.aliases=[...new Set([...(card.aliases??[]),row.KoreanName.trim()])];
 }
}
const matchedIds=new Set(report.matched.map(card=>card.id));
report.unmappedCatalog=catalog.cards.filter(card=>!matchedIds.has(card.id)).map(({id,name})=>({id,name}));
if(process.argv.includes('--apply-aliases'))fs.writeFileSync(catalogPath,JSON.stringify(catalog));
const output=process.argv.find(a=>a.startsWith('--report='))?.slice(9);
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,matched:report.matched.length,legacyVariants:report.legacyVariants.length},null,2));
if(report.uncovered.length||report.ambiguous.length||report.conflicts.length||report.unmappedCatalog.length||report.duplicateCatalogIds.length||report.duplicateCanonicalNames.length)process.exitCode=1;
