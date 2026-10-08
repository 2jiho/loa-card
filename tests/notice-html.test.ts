import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotice } from '../scripts/notice-html.mjs';
test('notice tables and local license links render with working destinations', () => {
  const html = renderNotice('# 고지\n\n|구성|권리|\n|---|---|\n|LoaCard|[MIT](LICENSE)|\n\n[검토](docs/legal-review.md)');
  assert.match(html, /<table>/); assert.match(html, /href="LICENSE-LoaCard.txt.html"/); assert.match(html, /href="legal-review.txt.html"/);
});
test('raw HTML, active URLs and remote image embeds do not execute in notices', () => {
  const html = renderNotice('<script>alert(1)</script>\n\n[x](javascript:alert) ![image](https://example.com/pixel.png) [source](https://example.com)');
  assert.doesNotMatch(html, /<script|href="javascript:|<img/); assert.match(html, /href="https:\/\/example.com"/);
});
