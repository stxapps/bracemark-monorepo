import { normalizeUrl } from '../url/url';
import type { ImportedLink, ImportObserver } from './bundle';

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

export function parseUrlText(
  text: string,
  options: { linesOnly?: boolean; observer?: ImportObserver } = {},
): ImportedLink[] {
  const links: ImportedLink[] = [];
  if (options.linesOnly) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const raw = line.trim();
      const url = /^(https?:\/\/|www\.)\S+$/i.test(raw) ? normalizeUrl(raw) : null;
      options.observer?.row(index + 1, url === null ? 'Not one web address per line' : undefined);
      if (url !== null) links.push({ url, tagNames: [], folderPath: [] });
    }
    return links;
  }
  for (const match of text.matchAll(URL_TOKEN_RE)) {
    const url = normalizeUrl(stripTrailingPunctuation(match[0]));
    if (url === null) continue;
    links.push({ url, tagNames: [], folderPath: [] });
  }
  return links;
}
