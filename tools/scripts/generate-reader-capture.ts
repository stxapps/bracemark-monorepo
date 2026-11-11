// Emits the two scripts that take a read-mode copy inside a live page on iOS/Android,
// both from ONE bundle of the converter the browser extension uses
// (@stxapps/web-react/lib/reader-doc-from-page — Readability, then sanitized blocks):
//
//   apps/bracemark-expo/share-extension/preprocessing.js
//       The iOS share extension's NSExtensionJavaScriptPreprocessingFile. Safari runs
//       it INSIDE the page being shared, before the sheet opens, and hands its result
//       to the sheet as `preprocessingResults` — `{ title, url, readMode }`, the copy
//       as JSON text. It has to be a self-contained file Safari can evaluate (no
//       Metro, no imports) whose `ExtensionPreprocessingJS` is a GLOBAL-object
//       property, hence the `var`.
//
//   apps/bracemark-expo/src/features/capture/page-capture-script.generated.ts
//       A SECOND, larger bundle, for expo's capture screen to inject into its WebView:
//       the same converter, plus the page-metadata collector and the in-page image
//       fetch and encoders (@stxapps/web-react/lib/webview-capture). It answers one
//       request per injection through `window.ReactNativeWebView` — the protocol is
//       @stxapps/shared reader/page-capture.ts. Two bundles, not one, because
//       preprocessing.js runs in EVERY page shared from Safari before the sheet opens
//       and must stay small (docs/share-sheet.md), while the capture screen's script
//       runs only on a tap.
//
// Both are CHECKED IN and generated, never hand-edited. Each carries a hash of the
// sources it was built from, and web-react's reader-capture-generated.spec.ts fails
// when they drift — in the package where the converter lives, so editing it fails
// beside the edit (the contract-vectors arrangement: tools/scripts/
// generate-contract-vectors.ts). docs/link-extraction-keep.md, _expo_.
//
//   npx tsx tools/scripts/generate-reader-capture.ts

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// What the bundles' behaviour depends on. The spec hashes the same list.
export const READER_CAPTURE_HASH_INPUTS = [
  'packages/web-react/src/lib/reader-doc-from-page.ts',
  'packages/web-react/src/lib/webview-capture.ts',
  'packages/web-react/src/lib/page-meta.ts',
  'packages/web-react/src/lib/reader-images.ts',
  'packages/web-react/src/lib/reader-image.ts',
  'packages/web-react/src/lib/resize-image.ts',
  'packages/shared/src/reader/reader-doc-from-dom.ts',
  'packages/shared/src/reader/reader-doc.ts',
  'packages/shared/src/reader/reader-doc-core.ts',
  'packages/shared/src/reader/reader-images.ts',
  'packages/shared/src/reader/page-capture.ts',
  'packages/shared/src/image/sniff.ts',
  'packages/shared/src/image/preview.ts',
  'node_modules/@mozilla/readability/package.json',
  'tools/scripts/generate-reader-capture.ts',
];

export function readerCaptureSourceHash(root = ROOT): string {
  const hash = createHash('sha256');
  for (const input of READER_CAPTURE_HASH_INPUTS) {
    hash.update(input);
    hash.update(readFileSync(join(root, input)));
  }
  return hash.digest('hex').slice(0, 16);
}

// The preprocessing file's: ONE function, returning the copy as JSON TEXT — serialised
// once, here, in the page's own process. Safari gives its result to the share extension
// as a property list, which becomes the React root's initial props: as an object the
// copy is thousands of small allocations three times over (an NSDictionary, the
// surface's folly::dynamic, the JS heap) for the life of a sheet that only ever writes it
// to a file, in a process iOS kills at 120 MB. As text it is one buffer each
// (docs/share-sheet.md, _what the sheet does and doesn't do_). The length the cap needs
// is the same string's, so nothing is serialised twice.
//
// What it serialises is the CAPTURE, \`{ doc, images }\`: the document, and beside it the
// address of each figure the walker gave a key to; past READER_CAPTURE_MAX_PAYLOAD_CHARS
// it hands over nothing (reader-doc-core.ts). The app fetches those addresses natively
// when the account keeps images, and settles the document against what it kept before
// storing anything (expo-react data/store-read-mode.ts) — the list never reaches a stored
// copy. Addresses are a few dozen short strings; the cap is unmoved.
const PREPROCESSING_ENTRY = `
import { readerCaptureFromPage } from '@stxapps/web-react/lib/reader-doc-from-page';
import { READER_CAPTURE_MAX_PAYLOAD_CHARS } from '@stxapps/shared/reader/reader-doc-core';
globalThis.__bracemarkReaderDocJson = function () {
  try {
    var capture = readerCaptureFromPage(document);
    if (!capture) return null;
    var json = JSON.stringify(capture);
    return json.length > READER_CAPTURE_MAX_PAYLOAD_CHARS ? null : json;
  } catch (e) {
    return null;
  }
};
`;

// The capture screen's: one global the per-request tail calls (pageCaptureScript, in the
// generated module below). Defined again on every injection, so a page the user has
// navigated to since the last request still has it.
const CAPTURE_ENTRY = `
import { runPageCapture } from '@stxapps/web-react/lib/webview-capture';
globalThis.__bracemarkPageCapture = runPageCapture;
`;

async function bundle(entry: string): Promise<string> {
  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'reader-capture-entry.ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // The iOS deployment target is 26 (app.config.ts) and the WebView is the
    // system's; es2020 is comfortably inside both.
    target: 'es2020',
    minify: true,
    write: false,
    legalComments: 'eof',
  });
  return result.outputFiles[0].text.trim();
}

export async function renderReaderCapture(): Promise<{
  preprocessing: string;
  captureModule: string;
}> {
  const hash = readerCaptureSourceHash();
  const code = await bundle(PREPROCESSING_ENTRY);
  const captureCode = await bundle(CAPTURE_ENTRY);
  const banner = `GENERATED by tools/scripts/generate-reader-capture.ts — do not edit. source-hash: ${hash}`;

  const preprocessing = `// ${banner}
//
// The NSExtensionJavaScriptPreprocessingFile of the iOS share extension (wired by
// the \`preprocessingFile\` option of plugins/with-share-extension, in app.config.ts). Safari runs it
// inside the shared page; the result lands on the RN root of the sheet as
// \`preprocessingResults\` and is read by src/features/share/share-url.ts.
// docs/share-sheet.md, the section on what the sheet does.
/* eslint-disable */
${code}
// ⚠ NO null MAY REACH completionFunction. Safari hands the result to the share
// extension as a PROPERTY LIST, and a property list has no null: a JS null becomes
// NSNull, the whole representation fails to load in the extension
// ("Cannot load representation of type com.apple.property-list"), and the sheet
// opens on "No link in this share" with nothing in any log of ours. So the result
// is built from STRINGS ONLY, each coerced or type-checked here, and the copy is
// OMITTED when there is none. The copy itself is JSON text (above), so whatever
// nulls a ReaderDoc holds are characters inside one string, and nothing walks an
// object the page could have reached. docs/link-extraction-keep.md, the iOS
// preprocessing entry.
var ExtensionPreprocessingJS = {
  run: function (args) {
    var result = { title: String(document.title), url: String(window.location.href) };
    var readMode = null;
    try {
      readMode = globalThis.__bracemarkReaderDocJson();
    } catch (e) {}
    if (typeof readMode === 'string') result.readMode = readMode;
    args.completionFunction(result);
  },
};
`;

  // The request is spliced in as JSON, which is a JS expression, and the bundle's global
  // answers through the WebView's bridge — taken once, before the page's own scripts get
  // another turn. Every answer carries the request's nonce (shared reader/page-capture.ts).
  const captureModule = `// ${banner}
/* eslint-disable */
import type { PageCaptureRequest } from '@stxapps/shared';

// prettier-ignore
export const PAGE_CAPTURE_SOURCE_HASH = '${hash}';

// prettier-ignore
const PAGE_CAPTURE_BUNDLE: string = ${JSON.stringify(captureCode)};

// The script to inject into the WebView for one request: the bundle (Readability, the
// block converter, the page-metadata collector, the in-page image fetch and encoders —
// @stxapps/web-react/lib/webview-capture), then a call that answers \`request\` through
// window.ReactNativeWebView. features/capture/use-page-capture.ts reads the answers.
export function pageCaptureScript(request: PageCaptureRequest): string {
  return (
    PAGE_CAPTURE_BUNDLE +
    ';(function (request) {' +
    'var bridge = window.ReactNativeWebView;' +
    'if (!bridge || typeof globalThis.__bracemarkPageCapture !== "function") return;' +
    'globalThis.__bracemarkPageCapture(request, function (message) { bridge.postMessage(message); });' +
    '})(' +
    JSON.stringify(request) +
    ');true;'
  );
}
`;

  return { preprocessing, captureModule };
}

export const PREPROCESSING_PATH = 'apps/bracemark-expo/share-extension/preprocessing.js';
export const CAPTURE_MODULE_PATH =
  'apps/bracemark-expo/src/features/capture/page-capture-script.generated.ts';

async function main(): Promise<void> {
  const { preprocessing, captureModule } = await renderReaderCapture();
  writeFileSync(join(ROOT, PREPROCESSING_PATH), preprocessing);
  writeFileSync(join(ROOT, CAPTURE_MODULE_PATH), captureModule);
  console.log(`wrote ${PREPROCESSING_PATH} and ${CAPTURE_MODULE_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
