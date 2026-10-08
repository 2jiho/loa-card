import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const files = [];
async function walk(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isDirectory()) await walk(join(directory, item.name), name + '/');
    else if (name !== 'site-manifest.json') {
      const bytes = await readFile(join(directory, item.name));
      files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await walk('dist');
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile('dist/site-manifest.json', JSON.stringify({ version: 1, files }) + '\n');
console.log(`Prepared deployment checksums for ${files.length} files.`);
