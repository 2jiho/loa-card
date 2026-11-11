// Repackage a reviewed client-derived feature; never obtain or alter game files.
// Generate the input separately using build-client-card-art.py --experimental-all
// in work/, then pass its artwork-details.json and a new output path here.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node scripts/build-portrait-competitors.mjs <experimental-artwork-details.json> <new-output.json>');
const expected=JSON.parse(await readFile(new URL('../src/features/card-scanner/portrait-competitor-pins.json',import.meta.url),'utf8'));
const features=JSON.parse(await readFile(input,'utf8')),cards={};
for(const [id,hash] of Object.entries(expected)){
  const encoded=features[id];if(typeof encoded!=='string')throw Error(`Missing feature: ${id}`);
  const raw=Buffer.from(encoded,'base64');
  if(raw.length!==200||createHash('sha256').update(raw).digest('hex')!==hash)throw Error(`Unreviewed feature: ${id}`);
  cards[id]=encoded;
}
const payload={version:1,kind:'client-atlas-competitor-only',cards};
await writeFile(output,JSON.stringify(payload)+'\n',{flag:'wx'});
console.log(`Wrote ${Object.keys(cards).length} competitor-only reference(s); existing files are never overwritten.`);
