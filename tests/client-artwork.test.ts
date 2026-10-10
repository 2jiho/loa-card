import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {matchCardName} from '../src/features/card-scanner/card-dictionary';

const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const catalog=json('public/scanner/cards.json');
const atlas=json('public/scanner/artwork-details.json');
const provenance=json('public/scanner/artwork-provenance.json');
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
interface ArtworkReference {
 id:string;
 file:string;
 thumbnailSha256:string;
 featureSha256?:string;
 portraitSha256?:string;
 usage?:'display-only';
 labelEvidence?:{method:string;note:string};
}

test('every shipped portrait and display image has verified client provenance',()=>{
 assert.equal(catalog.source,'local-client:SeasonCard/GameMsg');
 assert.equal(provenance.pixelSource,'local-client-atlas');
 assert.equal(catalog.cards.length,420);
 const refs=new Map<string,ArtworkReference>(provenance.cards.map((c:ArtworkReference)=>[c.id,c]));
 assert.equal(refs.size,catalog.cards.length,'every catalog card has display artwork');
 assert.equal(refs.size,provenance.cards.length,'no duplicate ID mappings');
 const recognitionRefs=[...refs.values()].filter(c=>c.usage!=='display-only');
 assert.equal(recognitionRefs.length,388);
 assert.deepEqual(Object.keys(atlas).sort(),recognitionRefs.map(c=>c.id).sort());
 assert.deepEqual(readdirSync('public/scanner/artwork').sort(),[...refs.values()].map(c=>c.file).sort());
 for(const card of catalog.cards){
  assert.equal(card.nameSource,'local-client:SeasonCard/GameMsg');
  assert.ok(Number.isInteger(card.clientId));
  const ref=refs.get(card.id);
  assert.ok(ref,card.name);
  assert.match(ref.file,/^\d+\.webp$/);
  assert.equal(card.artwork,ref.file);
  const bytes=readFileSync(`public/scanner/artwork/${ref.file}`);
  assert.equal(bytes.toString('ascii',8,12),'WEBP');
  assert.equal(sha(bytes),ref.thumbnailSha256);
  if(ref.usage==='display-only'){
   assert.ok(ref.labelEvidence?.method && ref.labelEvidence.note,'display mapping has its own identity evidence');
   assert.equal(card.feature,undefined);assert.equal(card.artSource,undefined);
   assert.equal(atlas[card.id],undefined);
   assert.equal(ref.featureSha256,undefined);assert.equal(ref.portraitSha256,undefined);
   assert.equal(matchCardName(card.name,catalog.cards)?.card.id,card.id,'display-only cards remain name-readable');
   continue;
  }
  assert.equal(card.artSource,'local-client-atlas');
  const feature=Buffer.from(card.feature,'base64');
  assert.equal(feature.length,720);assert.equal(sha(feature),ref.featureSha256);
  assert.equal(Buffer.from(atlas[card.id],'base64').length,200);
  assert.equal(sha(Buffer.from(atlas[card.id],'base64')),ref.portraitSha256);
 }
});

test('display recovery does not change the previously validated recognition references',()=>{
 // Baseline before adding the 32 display-only portraits (client-2026-10-08).
 const references=catalog.cards.filter((c:{feature?:string})=>c.feature)
  .map((c:{id:string;feature:string})=>[c.id,c.feature]);
 assert.equal(sha(Buffer.from(JSON.stringify(references))),
  '343c39e2d78afb364b1cbe842d03a43727148843f41b5cbc8f1a724129cf37fc');
});

test('shared portraits can be displayed without claiming a unique card identity',()=>{
 const sol=catalog.cards.find((c:{id:string})=>c.id==='3200208');
 const grande=catalog.cards.find((c:{id:string})=>c.id==='3200157');
 assert.notEqual(sol.artwork,grande.artwork,'display paths retain the separate card IDs');
 assert.deepEqual(readFileSync(`public/scanner/artwork/${sol.artwork}`),readFileSync(`public/scanner/artwork/${grande.artwork}`));
 assert.equal(sol.feature,undefined);assert.equal(grande.feature,undefined);
});
