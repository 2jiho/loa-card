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

test('every shipped portrait and display image has verified client provenance',()=>{
 assert.equal(catalog.source,'local-client:SeasonCard/GameMsg');
 assert.equal(provenance.pixelSource,'local-client-atlas');
 assert.equal(catalog.cards.length,420);
 const refs=new Map<string,{file:string;thumbnailSha256:string;featureSha256:string;portraitSha256:string}>(provenance.cards.map((c:{id:string})=>[c.id,c]));
 assert.equal(refs.size,388);
 assert.deepEqual(Object.keys(atlas).sort(),[...refs.keys()].sort());
 assert.deepEqual(readdirSync('public/scanner/artwork').sort(),[...refs.values()].map(c=>c.file).sort());
 for(const card of catalog.cards){
  assert.equal(card.nameSource,'local-client:SeasonCard/GameMsg');
  assert.ok(Number.isInteger(card.clientId));
  const ref=refs.get(card.id);
  if(!ref){
   assert.equal(card.feature,undefined);assert.equal(card.artwork,undefined);assert.equal(card.artSource,undefined);
   assert.equal(matchCardName(card.name,catalog.cards)?.card.id,card.id,'cards without verified artwork remain name-readable');
   continue;
  }
  assert.equal(card.artSource,'local-client-atlas');
  assert.match(ref.file,/^\d+\.webp$/);
  assert.equal(card.artwork,ref.file);
  const bytes=readFileSync(`public/scanner/artwork/${ref.file}`);
  assert.equal(bytes.toString('ascii',8,12),'WEBP');
  assert.equal(sha(bytes),ref.thumbnailSha256);
  const feature=Buffer.from(card.feature,'base64');
  assert.equal(feature.length,720);assert.equal(sha(feature),ref.featureSha256);
  assert.equal(Buffer.from(atlas[card.id],'base64').length,200);
  assert.equal(sha(Buffer.from(atlas[card.id],'base64')),ref.portraitSha256);
 }
});
