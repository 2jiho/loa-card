import { renderNotice, noticeStyle } from './notice-html.mjs';
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'public/licenses');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const knownMissing = new Set(['guid-typescript@1.0.9', 'tr46@0.0.3']);
const inventory = [];
const notices = [];
await mkdir(output, { recursive: true });

for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path || entry.dev) continue;
  const folder = join(root, path);
  let pkg;
  try { pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')); }
  catch (error) { if (entry.optional && error.code === 'ENOENT') continue; throw error; }
  if (pkg.version !== entry.version) throw new Error(`Install npm ci first: ${path}`);
  const names = (await readdir(folder, { withFileTypes: true }))
    .filter(file => file.isFile() && /^(licen[sc]e|copying|notice)(\.|$|[-_])/i.test(file.name))
    .map(file => file.name).sort();
  const texts = await Promise.all(names.map(async name => `${name}\n${await readFile(join(folder, name), 'utf8')}`));
  if (!texts.length && ['onnxruntime-common', 'onnxruntime-web'].includes(pkg.name)) {
    texts.push(await readFile(join(root, 'public/scanner/LICENSE-ONNX-Runtime.txt'), 'utf8'));
  }
  const missingLicenseText = !texts.length;
  const id = `${pkg.name}@${pkg.version}`;
  if (missingLicenseText && !knownMissing.has(id)) throw new Error(`Review missing license text: ${id}`);
  const item = { name: pkg.name, version: pkg.version, license: pkg.license ?? 'UNKNOWN',
    source: entry.resolved, integrity: entry.integrity, missingLicenseText };
  inventory.push(item);
  notices.push(`${id}\nLicense: ${item.license}\nPackage source: ${item.source}\n\n${texts.join('\n\n') || 'The npm package declares this license but does not contain its full text. Review required before public distribution.'}`);
}

// Prebuilt workers/WASM embed code that is absent from our npm dependency tree.
// Preserve separately audited upstream notices; never invent missing license text.
const supplementalFolder = join(root, 'licenses/third-party');
const supplemental = JSON.parse(await readFile(join(supplementalFolder, 'manifest.json'), 'utf8'));
const sha256 = data => createHash('sha256').update(data).digest('hex');
for (const [name, version] of Object.entries(supplemental.packageVersions)) {
  const pkg = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error(`Review embedded notices after updating ${name}`);
}
if (sha256(await readFile(join(root, 'node_modules/@techstark/opencv-js/dist/opencv.js'))) !== supplemental.opencvSha256) {
  throw new Error('Review OpenCV embedded notices after replacing the runtime');
}
if (sha256(await readFile(join(root, 'node_modules/lz4-wasm/lz4_wasm_bg.wasm'))) !== supplemental.lz4WasmSha256) {
  throw new Error('Review LZ4 WASM embedded notices after replacing the recording compressor');
}
const workerMap = JSON.parse(await readFile(join(root, 'node_modules/tesseract.js/dist/worker.min.js.map'), 'utf8'));
await mkdir(join(output, 'supplemental'), { recursive: true });
for (const item of supplemental.items) {
  if (!/^[\w.-]+$/.test(item.file)) throw new Error('Invalid supplemental notice filename');
  const body = await readFile(join(supplementalFolder, item.file));
  if (sha256(body) !== item.sha256) throw new Error(`Notice checksum mismatch: ${item.file}`);
  if (item.sourceMapPath) {
    const index = workerMap.sources.indexOf(item.sourceMapPath);
    if (index < 0 || sha256(workerMap.sourcesContent[index].trim()) !== item.sourceSha256) {
      throw new Error(`Review embedded worker library: ${item.component}`);
    }
  }
  await writeFile(join(output, 'supplemental', item.file), body);
  notices.push(`${item.component} (${item.version})\nSource: ${item.source}\n\n${body.toString('utf8')}`);
}
await copyFile(join(supplementalFolder, 'manifest.json'), join(output, 'supplemental/manifest.json'));
notices.push('Tesseract core includes software based in part on the work of the Independent JPEG Group.');

// Mediabunny's npm package contains the original TypeScript source. Ship that
// exact installed version alongside the executable bundle, under its own MPL.
const media = inventory.find(item => item.name === 'mediabunny');
if (!media || media.license !== 'MPL-2.0') throw new Error('Review Mediabunny license/source distribution');
const sourcePath = `mediabunny-source/${media.version}`;
const sourceFolder = join(output, sourcePath);
await mkdir(sourceFolder, { recursive: true });
await cp(join(root, 'node_modules/mediabunny/src'), join(sourceFolder, 'src'), { recursive: true });
for (const name of ['LICENSE', 'package.json', 'README.md']) {
  await copyFile(join(root, 'node_modules/mediabunny', name), join(sourceFolder, name));
}
const sourceFiles = [];
async function listSources(folder, prefix = '') {
  for (const file of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${prefix}${file.name}`;
    if (file.isDirectory()) await listSources(join(folder, file.name), `${relative}/`);
    else sourceFiles.push(relative);
  }
}
await listSources(sourceFolder);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// Plain-text hosting may omit a charset. Keep upstream bytes intact and offer
// an explicitly UTF-8 HTML view rather than relying on browser auto-detection.
async function textPage(file, title, body, download = encodeURIComponent(file.split('/').at(-1)), markdown = false) {
  const back = '../'.repeat(file.split('/').length - 1) + 'index.html';
  await writeFile(join(output, `${file}.html`), `<!doctype html>
<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>${noticeStyle}</style>
<nav><a href="${back}">라이선스 목록</a><a href="${escape(download)}" download>원문 다운로드</a></nav>
<main>${markdown ? renderNotice(body) : `<h1>${escape(title)}</h1><pre>${escape(body)}</pre>`}</main></html>\n`);
}
const missing = inventory.filter(item => item.missingLicenseText).map(item => `${item.name}@${item.version}`);
await writeFile(join(output, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
const combinedNotices = `${notices.join('\n\n' + '='.repeat(72) + '\n\n')}\n`;
const assetNotices = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
// BOM also fixes direct links to our generated text exports on static hosts.
await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), `\uFEFF${combinedNotices}`);
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE-LoaCard.txt'));
await writeFile(join(output, 'asset-notices.txt'), `\uFEFF${assetNotices}`);
await textPage('asset-notices.txt', '외부 자산·모델 고지와 적용 범위', assetNotices, undefined, true);
const legalReview = await readFile(join(root, 'docs/legal-review.md'), 'utf8');
await writeFile(join(output, 'legal-review.txt'), `\uFEFF${legalReview}`);
await textPage('legal-review.txt', '권리 검토', legalReview, undefined, true);
await textPage('THIRD_PARTY_NOTICES.txt', '의존성 라이선스 원문 모음', combinedNotices);
await textPage('LICENSE-LoaCard.txt', 'LoaCard MIT 라이선스', await readFile(join(root, 'LICENSE'), 'utf8'));
for (const item of supplemental.items) {
  await textPage(`supplemental/${item.file}`, `${item.component} ${item.version}`, await readFile(join(supplementalFolder, item.file), 'utf8'));
}
await textPage('mediabunny-license.txt', `Mediabunny ${media.version} 라이선스`, await readFile(join(sourceFolder, 'LICENSE'), 'utf8'), `${sourcePath}/LICENSE`);
await writeFile(join(output, 'index.html'), `<!doctype html>
<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LoaCard 라이선스 및 권리 안내</title>
<style>${noticeStyle}</style>
<nav><a href="../">LoaCard로 돌아가기</a></nav>
<h1>LoaCard 라이선스 및 권리 안내</h1>
<p>LoaCard는 무료·비상업 팬 제작 도구입니다. 스마일게이트의 공식 서비스가 아니며 제휴·보증을 받지 않습니다.</p>
<p>로스트아크 이미지·게임 데이터의 권리는 스마일게이트 등 각 권리자에게 있습니다. 기능에 사용하는 가공 자료도 원권리자의 권리를 유지하며, LoaCard의 MIT 라이선스 적용 대상이 아닙니다.</p>
<p>LoaCard 작성 코드·문서는 MIT입니다. 외부 소프트웨어와 게임 유래 자료는 별도 조건을 따릅니다.</p>
<ul><li><a href="LICENSE-LoaCard.txt.html">LoaCard MIT 원문</a></li>
<li><a href="asset-notices.txt.html">외부 자산·모델 고지와 적용 범위</a></li>
<li><a href="THIRD_PARTY_NOTICES.txt.html">의존성 라이선스 원문 모음</a></li>
<li><a href="inventory.json">버전·출처·원문 누락 보고서</a></li>
<li><a href="supplemental/manifest.json">워커·WASM·모델 추가 고지 출처와 해시</a></li>
<li><a href="../ocr/worker.min.js.LICENSE.txt">Tesseract 워커의 원본 고지</a></li>
<li><a href="../scanner/NOTICE.txt">스캐너 자료 출처</a></li></ul>
<h2>사전 빌드된 라이브러리·모델 고지</h2>
<p>상위 프로젝트의 전체 고지에는 이번 웹 빌드에 포함되지 않은 구성도 있을 수 있습니다. 해당 파일은 전체 바이너리 구성표를 대신하지 않습니다.</p>
<ul>${supplemental.items.map(item => `<li><a href="supplemental/${encodeURIComponent(item.file)}.html">${escape(item.component)} ${escape(item.version)}</a></li>`).join('\n')}</ul>
<h2>Mediabunny ${escape(media.version)} 소스</h2>
<p>배포에 사용한 수정 없는 소스이며 MPL-2.0이 적용됩니다. npm 패키지의 원본 src와 라이선스를 함께 제공합니다.</p>
<ul>${sourceFiles.map(file => `<li><a href="${file === 'LICENSE' ? 'mediabunny-license.txt.html' : `${sourcePath}/${file.split('/').map(encodeURIComponent).join('/')}`}">${escape(file)}</a></li>`).join('\n')}</ul>
</html>\n`);
console.log(`Prepared notices for ${inventory.length} packages and Mediabunny source (${sourceFiles.length} files).`);
if (missing.length) console.warn(`License text not bundled upstream: ${missing.join(', ')}. See THIRD_PARTY_NOTICES.md.`);
