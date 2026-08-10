import { normalizeUrl } from '../url/url';
import type { ImportedLink } from './bundle';

// Plain-text URL scanner — the read mirror of export/text.ts and the fallback
// when a file is neither bookmarks HTML nor a links CSV. Pulls every URL-shaped
// token out of arbitrary prose: explicit http(s) URLs plus schemeless `www.`
// hosts (the one schemeless shape that's unambiguously a URL — normalizeUrl
// prepends https:// and vets the rest). No folder/tag/date signal exists in
// plain text, so rows carry only the URL.

// A token runs to whitespace or an HTML-ish delimiter; trailing prose
// punctuation ("see https://x.com/a, then…") is stripped after the match. A
// closing paren is only stripped when unbalanced, so Wikipedia-style
// `/wiki/Foo_(bar)` URLs survive.
const URL_TOKEN_RE = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi;

function stripTrailingPunctuation(token: string): string {
  let out = token.replace(/[.,;:!?…]+$/, '');
  while (out.endsWith(')') && !out.includes('(')) out = out.slice(0, -1);
  return out;
}

export function parseUrlText(text: string): ImportedLink[] {
  const links: ImportedLink[] = [];
  for (const match of text.matchAll(URL_TOKEN_RE)) {
    const url = normalizeUrl(stripTrailingPunctuation(match[0]));
    if (url === null) continue;
    links.push({ url, tagNames: [], folderPath: [] });
  }
  return links;
}
