import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseNotes(tag, pkg, lock, changelog) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error('Use a stable version tag such as v0.1.0');
  if (tag !== `v${pkg.version}` || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('Tag, package.json and package-lock.json versions must match');
  const heading = `## ${tag}`;
  const section = changelog.split(/\r?\n/);
  const start = section.findIndex(line => line === heading || line.startsWith(`${heading} - `));
  if (start < 0) throw new Error(`Missing changelog entry for ${tag}`);
  const end = section.findIndex((line, index) => index > start && line.startsWith('## '));
  const notes = section.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  if (!notes) throw new Error('Release notes must not be empty');
  return notes + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : process.argv[2];
  const notes = releaseNotes(tag ?? '', JSON.parse(readFileSync('package.json', 'utf8')), JSON.parse(readFileSync('package-lock.json', 'utf8')), readFileSync('CHANGELOG.md', 'utf8'));
  if (process.env.RELEASE_NOTES_PATH) writeFileSync(process.env.RELEASE_NOTES_PATH, notes);
  console.log(`Validated ${tag}`);
}
