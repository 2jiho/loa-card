// Compare the portrait pixels exercised by the screenshot regression fixture
// with the references used by the matcher. This is not a ground-truth audit.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
function load(path){
  const bytes=readFileSync(resolve(root,path));
  return {data:JSON.parse(bytes.toString('utf8')),sha256:createHash('sha256').update(bytes).digest('hex')};
}
const fixture=load('tests/fixtures/screen-portrait-regression.json');
const references=load('public/scanner/screen-artwork-details.json');
let labelled=0,available=0,identical=0,invalid=0;
for(const row of fixture.data.rows){
  if(!row.expected)continue;
  labelled++;
  const encoded=references.data.cards[row.expected];
  if(typeof encoded!=='string')continue;
  available++;
  const input=Buffer.from(row.gray,'base64'),reference=Buffer.from(encoded,'base64');
  if(input.length!==24*32||reference.length!==200){invalid++;continue;}
  const region=Buffer.alloc(200);
  for(let y=0;y<10;y++)input.copy(region,y*20,(y+9)*24+2,(y+9)*24+22);
  if(region.equals(reference))identical++;
}
console.log(JSON.stringify({scope:'same-ID 20x10 regression features; not independent labels or accuracy',
  fixtureSha256:fixture.sha256,referencesSha256:references.sha256,labelled,available,identical,invalid},null,2));
if(invalid)process.exitCode=1;
