import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Browser, chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';

import {
  AES_GCM_IV_BYTES,
  READER_IMAGE_JPEG_QUALITY,
  READER_IMAGE_MAX_DIMENSION,
  READER_IMAGE_MAX_SOURCE_BYTES,
  READER_IMAGES_MAX_BYTES,
  SCREENSHOT_JPEG_QUALITY,
  SCREENSHOT_MAX_DIMENSION,
} from '@stxapps/shared';

import { E2E_ROOT, MEASURE_OUTPUT } from '../paths';
import { createRunId } from '../runner/lib';
import { CHROME_PATH } from '../web/fixtures/env';
import { KEPT_COPY_PAGES, type MeasuredPage, type PageKind } from './kept-copies-pages';

// How many bytes a kept copy costs the byte quota, measured on real pages
// (docs/e2e.md, _the kept-copies leg_). Until this ran, every size in
// docs/link-extraction-keep.md was an estimate, and a storage number can't be
// printed on the pricing page from an estimate.
//
// It runs the SAME code the browser extension runs to take each copy, bundled into
// the page the way the extension injects it: Readability and the shared block
// walker (`readerDocFromPage`), the gzip the copy is stored as (`encodeReaderDoc`),
// and the screenshot's cap and re-encode (`resizeImage` with
// SCREENSHOT_MAX_DIMENSION / SCREENSHOT_JPEG_QUALITY). Then it adds the encryption
// frame every blob carries, so a figure is what R2 stores and the quota counts.
//
// The PREVIEW IMAGE is measured beside them, though it is not a kept copy: every
// plan stores one per link, so it is the other half of what fills a library, and
// a storage number printed for buyers has to be read against both. It takes the
// extension's path too — the shared `selectTitleImage` over the page's meta, the
// fetch from the page's own context, `resizeImage` at the preview defaults. The
// meta COLLECTOR is a copy of the one inlined in the extension's
// `captureTitleImage` (utils/capture.ts), since an injected function can't be
// imported; keep the two in step.
//
// THE ARTICLE'S IMAGES are measured with the read-mode copy that keeps them
// (docs/link-extraction-keep.md, _images in read mode_), again on the extension's
// path: the shared walker hands back the address of every figure it found
// (`readerCaptureFromPage`), each is fetched FROM THE PAGE'S OWN CONTEXT — which is
// where a host that refuses a cross-origin read shows up, the gap this leg exists to
// size — and what comes back goes through `encodeReaderImage`. Each image is encoded
// at several settings in one run, so the cap and the quality can be chosen from one
// table rather than from three runs against sites that changed in between.
//
// What differs from the extension, and why it doesn't move the figure:
//   - The viewport comes from Playwright's `page.screenshot` rather than
//     `tabs.captureVisibleTab`. Both are Chromium's compositor output of the
//     visible viewport, both JPEG at the extension's capture quality, and the
//     resize re-encodes either one the same way.
//   - The page is a fresh profile: no sign-in, no ad blocker, and whatever consent
//     banner the site shows a new visitor. That is what a first save looks like.
//
// Real sites, from this machine, one load each: never in CI. No account and no
// app is involved, so it needs no dev stack.

const ROOT = join(E2E_ROOT, '..');

// The extension's capture quality is the one input not in @stxapps/shared: it is
// the `captureVisibleTab` argument, so it lives beside that call. Read from the
// source rather than restated, so the two can't drift apart silently.
function extensionCaptureQuality(): number {
  const source = readFileSync(join(ROOT, 'apps/bracemark-extension/utils/capture.ts'), 'utf8');
  const match = /export const SCREENSHOT_CAPTURE_QUALITY = (\d+);/.exec(source);
  if (!match) throw new Error('SCREENSHOT_CAPTURE_QUALITY not found in the extension');
  return Number(match[1]);
}

// The frame around every stored blob: a version byte and the IV, then the
// ciphertext with its 16-byte GCM tag (web-crypto lib/blob.ts). AES-GCM adds
// nothing else, so the ciphertext is the plaintext's length.
const GCM_TAG_BYTES = 16;
const BLOB_FRAME_BYTES = 1 + AES_GCM_IV_BYTES + GCM_TAG_BYTES;

// The in-page half: the extension's own modules, exposed on one global.
async function pageBundle(): Promise<string> {
  const file = (path: string) => JSON.stringify(join(ROOT, path));
  const entry = `
import { readerDocFromPage } from ${file('packages/web-react/src/lib/reader-doc-from-page.ts')};
import { encodeReaderDoc } from ${file('packages/web-react/src/lib/reader-doc-bytes.ts')};
import { readerCaptureFromPage } from ${file('packages/web-react/src/lib/reader-doc-from-page.ts')};
import { encodeReaderImage } from ${file('packages/web-react/src/lib/reader-image.ts')};
import { resizeImage } from ${file('packages/web-react/src/lib/resize-image.ts')};
import { selectTitleImage, sniffImageMime } from "@stxapps/shared";

// The extension"s cap on a preview image carried back from the page (capture.ts).
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function collectMeta() {
  const collected = {};
  const setMeta = (key, content) => {
    if (!key || !content) return;
    const value = content.trim();
    if (value === "") return;
    switch (key.toLowerCase()) {
      case "og:title": collected.ogTitle ??= value; break;
      case "og:image": collected.ogImage ??= value; break;
      case "og:image:url": collected.ogImageUrl ??= value; break;
      case "og:image:secure_url": collected.ogImageSecure ??= value; break;
      case "twitter:image":
      case "twitter:image:src": collected.twitterImage ??= value; break;
      default: break;
    }
  };
  document.querySelectorAll("meta").forEach((el) => {
    setMeta(el.getAttribute("property"), el.getAttribute("content"));
    setMeta(el.getAttribute("name"), el.getAttribute("content"));
  });
  const imageSrc = document.querySelector("link[rel~=image_src]")?.getAttribute("href")?.trim();
  if (imageSrc) collected.imageSrc = imageSrc;
  if (document.title.trim() !== "") collected.docTitle = document.title;
  return collected;
}

globalThis.__bracemarkMeasure = {
  // null: the page names no image. { bytes: null }: it names one this path can’t
  // keep (refused, too large, not an image) — the extension stores nothing then.
  async preview() {
    const { imageUrl } = selectTitleImage(collectMeta(), new URL(location.href));
    if (!imageUrl) return null;
    try {
      const res = await fetch(imageUrl);
      if (!res.ok) return { bytes: null };
      const blob = await res.blob();
      if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return { bytes: null };
      const image = new Uint8Array(await blob.arrayBuffer());
      if (sniffImageMime(image) === undefined) return { bytes: null };
      return { bytes: (await resizeImage(image)).length };
    } catch {
      return { bytes: null };
    }
  },
  async readMode() {
    const doc = readerDocFromPage(document);
    if (!doc) return null;
    const stored = await encodeReaderDoc(doc);
    return { blocks: doc.blocks.length, jsonChars: JSON.stringify(doc).length, bytes: stored.length };
  },
  // One entry per image address the walker found. \`outcome\` is why it was or was not
  // kept; \`bytes\` is its stored size at each of \`settings\`, in order.
  async images(settings, maxSourceBytes) {
    const capture = readerCaptureFromPage(document);
    if (!capture) return null;
    const one = async ({ url }) => {
      const sameOrigin = new URL(url).origin === location.origin;
      let source;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return { sameOrigin, outcome: "http-" + res.status };
        const blob = await res.blob();
        if (blob.size === 0 || blob.size > maxSourceBytes) return { sameOrigin, outcome: "too-large" };
        source = new Uint8Array(await blob.arrayBuffer());
      } catch {
        // A cross-origin read the host refuses, a timeout, a blocked request.
        return { sameOrigin, outcome: "refused" };
      }
      const bytes = [];
      let size;
      for (const { maxDimension, quality } of settings) {
        const encoded = await encodeReaderImage(source, { maxDimension, quality });
        if (typeof encoded === "string") return { sameOrigin, outcome: encoded };
        bytes.push(encoded.bytes.length);
        size ??= { width: encoded.width, height: encoded.height };
      }
      return { sameOrigin, outcome: "kept", sourceBytes: source.length, bytes, ...size };
    };
    const results = [];
    const queue = [...capture.images];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) results.push(await one(next));
      }),
    );
    const figures = capture.doc.blocks.filter((b) => b.kind === "figure").length;
    return { figures, images: results };
  },
  async screenshot(base64, maxDimension, quality) {
    const captured = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const stored = await resizeImage(captured, { maxDimension, quality });
    const bitmap = await createImageBitmap(new Blob([stored]));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { capturedBytes: captured.length, bytes: stored.length, ...size };
  },
};
`;
  const result = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'kept-copies-entry.ts' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  return result.outputFiles[0].text;
}

interface Options {
  width: number;
  height: number;
  dpr: number;
  limit: number | null;
  kind: PageKind | null;
  settleMs: number;
}

interface ReadModeResult {
  blocks: number;
  jsonChars: number;
  bytes: number;
}

interface ScreenshotResult {
  capturedBytes: number;
  bytes: number;
  width: number;
  height: number;
}

// The encode settings every article image is measured at. The FIRST is what ships
// (reader-doc-core.ts); the others are the alternatives the table is read against.
const IMAGE_SETTINGS = [
  { maxDimension: READER_IMAGE_MAX_DIMENSION, quality: READER_IMAGE_JPEG_QUALITY },
  { maxDimension: READER_IMAGE_MAX_DIMENSION, quality: 0.7 },
  { maxDimension: 800, quality: 0.75 },
] as const;

interface ImageResult {
  sameOrigin: boolean;
  // "kept", or why not: "refused" (the page's context could not read it), "http-404",
  // "too-large", "not-an-image", "undecodable", "too-small".
  outcome: string;
  sourceBytes?: number;
  // Stored size at each of IMAGE_SETTINGS.
  bytes?: number[];
  width?: number;
  height?: number;
}

interface ImagesResult {
  figures: number;
  images: ImageResult[];
}

interface PreviewResult {
  // Null when the page names an image the extension couldn't keep.
  bytes: number | null;
}

interface PageResult extends MeasuredPage {
  ok: boolean;
  error?: string;
  // Null when Readability says the page is not an article: no copy is kept.
  readMode?: ReadModeResult | null;
  screenshot?: ScreenshotResult;
  // Null when the page names no preview image at all.
  preview?: PreviewResult | null;
  // Null when the page is not an article: no copy, so no images.
  images?: ImagesResult | null;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    width: 1440,
    height: 900,
    dpr: 2,
    limit: null,
    kind: null,
    settleMs: 2_000,
  };
  const num = (value: string | undefined, flag: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} takes a positive number`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--width') options.width = num(args[++i], arg);
    else if (arg === '--height') options.height = num(args[++i], arg);
    else if (arg === '--dpr') options.dpr = num(args[++i], arg);
    else if (arg === '--limit') options.limit = num(args[++i], arg);
    else if (arg === '--settle') options.settleMs = num(args[++i], arg);
    else if (arg === '--kind') {
      const kind = args[++i];
      if (kind !== 'article' && kind !== 'page') throw new Error('--kind takes article or page');
      options.kind = kind;
    } else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

async function measurePage(
  page: Page,
  target: MeasuredPage,
  bundle: string,
  options: Options,
  captureQuality: number,
): Promise<PageResult> {
  try {
    // `load` can take forever on a page that never stops fetching; whatever has
    // rendered by the timeout is what a person saving it would have seen.
    await page.goto(target.url, { waitUntil: 'load', timeout: 30_000 }).catch((err: Error) => {
      if (!/Timeout/.test(err.message)) throw err;
    });
    return await capture(page, target, bundle, options, captureQuality);
  } catch (err) {
    // A page that navigates again after `load` — a redirect, a bot check that
    // passes — destroys the context the bundle was in. Once more, on the page it
    // landed on: that is the page a person would have saved.
    if (err instanceof Error && /Execution context was destroyed/.test(err.message)) {
      try {
        await page.waitForLoadState('load', { timeout: 30_000 });
        return await capture(page, target, bundle, options, captureQuality);
      } catch (retryErr) {
        return failed(target, retryErr);
      }
    }
    return failed(target, err);
  }
}

function failed(target: MeasuredPage, err: unknown): PageResult {
  return {
    ...target,
    ok: false,
    error: err instanceof Error ? err.message.split('\n')[0] : String(err),
  };
}

async function capture(
  page: Page,
  target: MeasuredPage,
  bundle: string,
  options: Options,
  captureQuality: number,
): Promise<PageResult> {
  await page.waitForTimeout(options.settleMs);
  await page.evaluate(bundle);

  const readMode = await page.evaluate(() =>
    (globalThis as unknown as MeasureGlobal).__bracemarkMeasure.readMode(),
  );
  const jpeg = await page.screenshot({ type: 'jpeg', quality: captureQuality });
  const screenshot = await page.evaluate(
    ([base64, maxDimension, quality]) =>
      (globalThis as unknown as MeasureGlobal).__bracemarkMeasure.screenshot(
        base64,
        maxDimension,
        quality,
      ),
    [jpeg.toString('base64'), SCREENSHOT_MAX_DIMENSION, SCREENSHOT_JPEG_QUALITY] as const,
  );

  const preview = await page.evaluate(() =>
    (globalThis as unknown as MeasureGlobal).__bracemarkMeasure.preview(),
  );
  const images = await page.evaluate(
    ([settings, maxSourceBytes]) =>
      (globalThis as unknown as MeasureGlobal).__bracemarkMeasure.images(settings, maxSourceBytes),
    [IMAGE_SETTINGS, READER_IMAGE_MAX_SOURCE_BYTES] as const,
  );

  return {
    ...target,
    ok: true,
    readMode: readMode && { ...readMode, bytes: readMode.bytes + BLOB_FRAME_BYTES },
    screenshot: { ...screenshot, bytes: screenshot.bytes + BLOB_FRAME_BYTES },
    preview: preview && {
      bytes: preview.bytes === null ? null : preview.bytes + BLOB_FRAME_BYTES,
    },
    images,
  };
}

// The pack an article's kept images make at one setting: the images in page order
// until the byte budget is spent (the rest stay placeholders), plus the encryption
// frame. The index is a few dozen bytes an image and is left out. Zero for no pack.
function packBytes(images: ImagesResult, setting: number): number {
  let total = 0;
  for (const image of images.images) {
    const bytes = image.bytes?.[setting];
    if (image.outcome !== 'kept' || bytes === undefined) continue;
    if (total + bytes > READER_IMAGES_MAX_BYTES) break;
    total += bytes;
  }
  return total === 0 ? 0 : total + BLOB_FRAME_BYTES;
}

interface MeasureGlobal {
  __bracemarkMeasure: {
    preview(): Promise<PreviewResult | null>;
    images(
      settings: readonly { maxDimension: number; quality: number }[],
      maxSourceBytes: number,
    ): Promise<ImagesResult | null>;
    readMode(): Promise<ReadModeResult | null>;
    screenshot(base64: string, maxDimension: number, quality: number): Promise<ScreenshotResult>;
  };
}

// Nearest-rank percentile over a sorted copy.
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

interface Distribution {
  n: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
}

function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  return {
    n: values.length,
    median: percentile(values, 50),
    p90: percentile(values, 90),
    max: Math.max(...values),
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

function line(label: string, d: Distribution | null): string {
  if (!d) return `${label.padEnd(30)} —`;
  return `${label.padEnd(30)} n=${String(d.n).padStart(3)}  median ${kb(d.median).padStart(9)}  p90 ${kb(d.p90).padStart(9)}  max ${kb(d.max).padStart(9)}  mean ${kb(d.mean).padStart(9)}`;
}

function summarize(results: PageResult[], options: Options): string {
  const ok = results.filter((r) => r.ok);
  const readModes = ok.flatMap((r) => (r.readMode ? [r.readMode.bytes] : []));
  const screenshots = ok.flatMap((r) => (r.screenshot ? [r.screenshot.bytes] : []));
  const byKind = (kind: PageKind) =>
    ok.filter((r) => r.kind === kind).flatMap((r) => (r.screenshot ? [r.screenshot.bytes] : []));
  const previews = ok.flatMap((r) => (r.preview?.bytes != null ? [r.preview.bytes] : []));
  // What one link costs when everything is kept: its preview (where it has one),
  // its read-mode copy (where the page is an article) and its screenshot.
  const everything = ok.map(
    (r) => (r.preview?.bytes ?? 0) + (r.readMode?.bytes ?? 0) + (r.screenshot?.bytes ?? 0),
  );
  // --- the article's images, over every page read mode was kept on --------------
  const withCopy = ok.flatMap((r) => (r.readMode && r.images ? [r.images] : []));
  const allImages = withCopy.flatMap((i) => i.images);
  const count = (outcome: (o: string) => boolean, among = allImages) =>
    among.filter((i) => outcome(i.outcome)).length;
  const crossOrigin = allImages.filter((i) => !i.sameOrigin);
  const packs = IMAGE_SETTINGS.map((_, s) =>
    withCopy.map((i) => packBytes(i, s)).filter((bytes) => bytes > 0),
  );
  const perImage = IMAGE_SETTINGS.map((_, s) =>
    allImages.flatMap((i) => (i.outcome === 'kept' && i.bytes ? [i.bytes[s]] : [])),
  );
  const keptPerArticle = withCopy.map((i) => count((o) => o === 'kept', i.images));
  const foundPerArticle = withCopy.map((i) => i.images.length);
  const share = (n: number, of: number) => (of === 0 ? '—' : `${Math.round((n / of) * 100)}%`);
  const counts = (values: number[]) =>
    values.length === 0
      ? '—'
      : `median ${percentile(values, 50)}, p90 ${percentile(values, 90)}, max ${Math.max(...values)}`;
  const outcomes = new Map<string, number>();
  for (const image of allImages) {
    outcomes.set(image.outcome, (outcomes.get(image.outcome) ?? 0) + 1);
  }
  // What a link costs with images on and screenshots off — the default.
  const defaults = ok.map(
    (r) =>
      (r.preview?.bytes ?? 0) +
      (r.readMode?.bytes ?? 0) +
      (r.readMode && r.images ? packBytes(r.images, 0) : 0),
  );

  const articlesRead = ok.filter((r) => r.kind === 'article' && r.readMode).length;
  const pagesRead = ok.filter((r) => r.kind === 'page' && r.readMode).length;

  const rows = [
    `viewport ${options.width}×${options.height} @${options.dpr}x, screenshot cap ${SCREENSHOT_MAX_DIMENSION} px at quality ${SCREENSHOT_JPEG_QUALITY}`,
    `${ok.length} of ${results.length} pages captured; read mode kept on ${articlesRead} of ${ok.filter((r) => r.kind === 'article').length} articles and ${pagesRead} of ${ok.filter((r) => r.kind === 'page').length} other pages`,
    'Sizes are as stored: after gzip (read mode) or the re-encode (screenshot), plus the encryption frame.',
    '',
    line('read mode', distribution(readModes)),
    line('screenshot, every page', distribution(screenshots)),
    line('screenshot, articles', distribution(byKind('article'))),
    line('screenshot, other pages', distribution(byKind('page'))),
    line('preview image', distribution(previews)),
    line('a link with every copy', distribution(everything)),
    `preview image kept on ${previews.length} of ${ok.length} pages`,
    '',
    `Images in read mode, over the ${withCopy.length} pages a copy was kept on:`,
    `  addresses found per copy: ${counts(foundPerArticle)}; kept per copy: ${counts(keptPerArticle)}`,
    `  ${allImages.length} addresses in all: ${[...outcomes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, n]) => `${outcome} ${n}`)
      .join(', ')}`,
    `  the page’s context could not read ${count((o) => o === 'refused')} (${share(
      count((o) => o === 'refused'),
      allImages.length,
    )}); of the ${crossOrigin.length} on another origin, ${count((o) => o === 'refused', crossOrigin)} (${share(
      count((o) => o === 'refused', crossOrigin),
      crossOrigin.length,
    )})`,
    `  copies with at least one image kept: ${packs[0].length} of ${withCopy.length}`,
    ...IMAGE_SETTINGS.flatMap((setting, s) => [
      line(`one image, ${setting.maxDimension}px q${setting.quality}`, distribution(perImage[s])),
      line(`a pack, ${setting.maxDimension}px q${setting.quality}`, distribution(packs[s])),
    ]),
    line('a link, images on, no shot', distribution(defaults)),
  ];
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    rows.push('', `failed (left out of the figures):`);
    for (const r of failed) rows.push(`  ${r.url} — ${r.error}`);
  }
  return rows.join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const captureQuality = extensionCaptureQuality();
  const pages = KEPT_COPY_PAGES.filter((p) => !options.kind || p.kind === options.kind).slice(
    0,
    options.limit ?? undefined,
  );

  const runDir = join(MEASURE_OUTPUT, createRunId('measure-kept-copies'));
  await mkdir(runDir, { recursive: true });
  const bundle = await pageBundle();

  let browser: Browser | undefined;
  const results: PageResult[] = [];
  try {
    browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
    for (const [i, target] of pages.entries()) {
      // A context per page: no cookie, consent choice or cache carries from one
      // site's capture into the next.
      const context = await browser.newContext({
        viewport: { width: options.width, height: options.height },
        deviceScaleFactor: options.dpr,
        // The copy is taken from inside the page; a site's CSP must not decide
        // whether the measurement runs, any more than it decides the extension's.
        bypassCSP: true,
      });
      const page = await context.newPage();
      const result = await measurePage(page, target, bundle, options, captureQuality);
      await context.close();
      results.push(result);
      const preview = result.preview?.bytes;
      const detail = result.ok
        ? `preview ${preview != null ? kb(preview) : '—'}, read mode ${result.readMode ? kb(result.readMode.bytes) : '— (not an article)'}, screenshot ${kb(result.screenshot?.bytes ?? 0)}${
            result.readMode && result.images
              ? `, images ${result.images.images.filter((i) => i.outcome === 'kept').length} of ${result.images.images.length} (${kb(packBytes(result.images, 0))})`
              : ''
          }`
        : `FAILED: ${result.error}`;
      console.log(`[${i + 1}/${pages.length}] ${target.url}\n    ${detail}`);
    }
  } finally {
    await browser?.close();
  }

  const summary = summarize(results, options);
  await writeFile(join(runDir, 'results.json'), JSON.stringify({ options, results }, null, 2));
  await writeFile(join(runDir, 'summary.txt'), `${summary}\n`);
  console.log(`\n${summary}\n\nresults in ${runDir}`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
