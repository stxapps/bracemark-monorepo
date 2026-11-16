import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

// A page whose read-mode copy sits at the ceiling the iOS share extension can be
// handed — served on this Mac's LAN address for a phone's Safari to share.
//
//   npm run measure:capped-page            # build, check, serve on :8790
//   npm run measure:capped-page -- --check # build and check only
//
// NOT A TEST. It is the page SHARE-IOS-MEMORY-RELEASE-001 (e2e/mobile/RELEASE.md)
// shares for its capped-copy run. The copy is bounded at the capture — the walk
// stops at READER_DOC_MAX_CHARS (1,000,000) or READER_DOC_MAX_BLOCKS (10,000),
// and `__bracemarkReaderDocJson` drops a serialised copy over 3,000,000
// characters — and that serialised string is what Safari hands the share
// extension (docs/share-sheet.md, _300 lists and 300 tags, and a copy at the
// cap_). An ordinary long article reaches a fraction of it (Wikipedia's mobile
// World War II page: 19 K), so the ceiling has to be built:
//
//   - Japanese text, so the string is not Latin-1 and costs two bytes a
//     character in every runtime that holds it;
//   - quotes and backslashes, which JSON escaping doubles;
//   - BEL characters, which it turns into six (`\u0007`).
//
// 9,600 paragraphs of ~105 characters put the text at the walk's 1,000,000-
// character cap, and the escaping carries the JSON to ~2.85M of the 3M allowed. The check below runs the app's OWN capture —
// apps/bracemark-expo/share-extension/preprocessing.js, the generated file Safari
// runs — in Chromium, and refuses to serve a page whose copy is dropped (over
// 3M) or has drifted far under it (a change to the walk or the generator).
// Chromium is not WebKit; the device's own `copy-file` line is the reading that
// counts, and the check is only the guard against serving the wrong page.

const PORT = 8790;
const PARAGRAPHS = 9_600;
const JSON_CEILING = 3_000_000;
const JSON_FLOOR = 2_700_000;

const PREPROCESSING = fileURLToPath(
  new URL('../../apps/bracemark-expo/share-extension/preprocessing.js', import.meta.url),
);

export function cappedCopyPage(): string {
  const japanese = 'これは共有シートのメモリを測るための長い記事の段落です';
  const escape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = Array.from({ length: PARAGRAPHS }, (_, i) => {
    const text = `${japanese.slice(0, 30)} ${String(i).padStart(5, '0')} ${'"\\'.repeat(25)}${'\u0007'.repeat(18)}`;
    return `<p>${escape(text)}</p>`;
  });
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Share sheet memory: a page at the read-mode cap</title></head>
<body><header><h1>Share sheet memory: a page at the read-mode cap</h1></header>
<article><h2>Introduction</h2>
${paragraphs.join('\n')}
</article></body></html>`;
}

async function measure(page: string): Promise<{ jsonChars: number | null; blocks?: number }> {
  const script = await readFile(PREPROCESSING, 'utf8');
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    await tab.setContent(page);
    await tab.addScriptTag({ content: script });
    return await tab.evaluate(() => {
      const capture = (globalThis as { __bracemarkReaderDocJson?: () => string | null })
        .__bracemarkReaderDocJson;
      const json = capture?.() ?? null;
      if (json === null) return { jsonChars: null };
      const parsed = JSON.parse(json) as { doc?: { blocks?: unknown[] } };
      return { jsonChars: json.length, blocks: parsed.doc?.blocks?.length };
    });
  } finally {
    await browser.close();
  }
}

function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

const page = cappedCopyPage();
const { jsonChars, blocks } = await measure(page);
if (jsonChars === null) {
  throw new Error(`the capture dropped the copy (over ${JSON_CEILING} characters): not at the cap`);
}
if (jsonChars < JSON_FLOOR) {
  throw new Error(`the copy is ${jsonChars} characters, under ${JSON_FLOOR}: the page has drifted`);
}
console.log(`copy: ${jsonChars} JSON characters in ${blocks} blocks (ceiling ${JSON_CEILING})`);

if (!process.argv.includes('--check')) {
  const body = Buffer.from(page, 'utf8');
  createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
  }).listen(PORT, '0.0.0.0', () => {
    console.log(`serving on http://${lanAddress() ?? '<this Mac>'}:${PORT}/ — ⌃C to stop`);
  });
}
