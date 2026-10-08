import { Marked } from 'marked';
export const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const localLinks = new Map([['LICENSE', 'LICENSE-LoaCard.txt.html'], ['docs/legal-review.md', 'legal-review.txt.html'], ['../THIRD_PARTY_NOTICES.md', 'asset-notices.txt.html']]);
// Build-time documents only. Never allow raw HTML, external images or active URLs.
const markdown = new Marked({ renderer: {
  html({ text }) { return escapeHtml(text); },
  image({ text }) { return escapeHtml(text); },
  link({ href, tokens }) {
    const label = this.parser.parseInline(tokens);
    const target = localLinks.get(href) ?? (/^https:\/\//i.test(href) ? href : null);
    return target ? `<a href="${escapeHtml(target)}" rel="noopener noreferrer">${label}</a>` : label;
  },
} });
export function renderNotice(body) { return markdown.parse(body); }
export const noticeStyle = `html{color-scheme:light dark}body{font:16px/1.7 system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 20px;overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit}nav{display:flex;gap:20px;flex-wrap:wrap}h1{font-size:1.7rem}h2{margin-top:2em;font-size:1.25rem}a{color:light-dark(#175c9e,#8ac5ff)}table{border-collapse:collapse;width:100%;font-size:.9rem}td,th{border:1px solid light-dark(#d4d7dc,#4c5058);padding:9px;text-align:left}th{background:light-dark(#f2f4f6,#272a30)}code{font-size:.9em}li{margin:5px 0}p,li{line-height:1.8}@media(max-width:600px){body{padding:0 16px}table{display:block;overflow-x:auto}}`;
