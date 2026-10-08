import { build } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

// This checks module inclusion, not whether a license grants redistribution.
// Native WASM contents and game asset rights require separate review.
const modules = new Set();
const collect = () => ({
  name: 'distribution-module-inventory',
  generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') {
      for (const id of Object.keys(chunk.modules)) modules.add(relative(process.cwd(), id).replaceAll('\\', '/'));
    }
  },
});
await build({ logLevel: 'warn', plugins: [collect()], worker: { plugins: () => [collect()] }, build: { write: false } });
const maps = {};
for (const file of ['node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs.map', 'node_modules/tesseract.js/dist/worker.min.js.map']) {
  maps[file] = JSON.parse(await readFile(file, 'utf8')).sources;
}
const inventory = JSON.parse(await readFile('public/licenses/inventory.json', 'utf8'));
const all = [...modules, ...Object.values(maps).flat()];
const missing = inventory.filter(item => item.missingLicenseText).map(({ name, version }) => ({
  name, version, references: all.filter(id => id.includes(`/${name}/`)),
}));
await mkdir('work/legal-review', { recursive: true });
await writeFile('work/legal-review/bundle-audit.json', JSON.stringify({
  checked: new Date().toISOString(), modules: [...modules].sort(), prebuiltSourceMaps: maps, missingLicensePackages: missing,
}, null, 2) + '\n');
console.log(JSON.stringify({ moduleCount: modules.size, missingLicensePackages: missing }, null, 2));
if (missing.some(item => item.references.length)) throw new Error('A package with missing license text appears in the web build. Review its license before distribution.');
