import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { E2E_ROOT, MEASURE_OUTPUT } from '../paths';
import { createRunId } from '../runner/lib';
import { KEPT_COPY_PAGES, type MeasuredPage, type PageKind } from './kept-copies-pages';

// What the extractor's read-mode guards do to REAL pages (docs/e2e.md, _measuring
// server read mode_). The guards — the parser pass, the walk and the meter
// (docs/link-extraction-server.md, _cost on the Worker_) — were calibrated on pages on
// our own disk and on pages built to be slow; this is the run that says whether they
// turn away a page from the web, and how close the pages that pass sit to each cap.
//
// It runs the extractor's own code, bundled by path with esbuild the way
// kept-copies.ts bundles the browser extension's (e2e may not import an app): the
// SAME fetch (`safeFetch`, its user agent, redirect walk and SSRF guard), the SAME
// byte cap (`readCappedBytes` at MAX_HTML_BYTES), the SAME robots.txt reader, and
// `readModeFromHtml` itself. The flow is a read-mode-only request's (routes/extract.ts,
// `extractOne`): robots.txt for the address asked, read FIRST, and a page it disallows is
// never fetched; then the page; then the final address's robots.txt.
//
// Beside the verdict it records each guard on its own — the parser pass, the walk's
// cost against MAX_READ_MODE_COST, the meter's units against MAX_READ_MODE_WORK — and,
// for a page a guard refused, what Readability makes of it with no guard at all (its
// time and the blocks the walker keeps). A refused page that comes back with blocks is
// a false refusal; one that comes back empty was never an article.
//
// What differs from production: this is Node on this machine, not workerd, so the
// TIMES are Node's (V8 both, within a small factor). The VERDICTS are not timed — each
// guard counts — so they are production's. The unguarded run is unbounded by design,
// which is fine for these pages and is why this never points at an arbitrary list.
//
// Real sites, from this machine, one fetch each (and one robots.txt per origin): never
// in CI. No account, no app, no dev stack.

const ROOT = join(E2E_ROOT, '..');

interface Options {
  limit: number | null;
  kind: PageKind | null;
}

type RefusedBy = 'markup' | 'walk' | 'meter';

interface PageResult extends MeasuredPage {
  ok: boolean;
  error?: string;
  // Set when robots.txt settled it: the page was not fetched (or, for the final
  // address, not read).
  robots?: 'disallowed' | 'unavailable';
  finalUrl?: string;
  htmlBytes?: number;
  // The read stopped at MAX_HTML_BYTES.
  truncated?: boolean;
  // Null: every guard passed.
  refusedBy?: RefusedBy | null;
  // The walk's cost, null when the parser pass refused first.
  walkCost?: number | null;
  // The meter's units with no budget, null when a check before it refused.
  meterUnits?: number | null;
  // What production answers: blocks kept, or null for `not-an-article`.
  blocks?: number | null;
  // `readModeFromHtml`, end to end (Node ms).
  ms?: number;
  // Only for a page a guard refused: Readability and the walker with no guard.
  unguarded?: { blocks: number | null; ms: number };
}

// The part of the extractor bundle this run calls.
interface Extractor {
  safeFetch(url: string, accept: string): Promise<{ response: Response; finalUrl: URL }>;
  readCappedBytes(response: Response, maxBytes: number): Promise<Uint8Array>;
  MAX_HTML_BYTES: number;
  createRobotsReader(): (url: URL) => Promise<'allowed' | 'disallowed' | 'unavailable'>;
  decodeHtml(bytes: Uint8Array, contentType: string | null): string;
  readModeFromHtml(html: string, finalUrl: URL): { doc: { blocks: unknown[] } } | null;
  readModeWork(html: string, finalUrl: URL, budget?: number): number | null;
  withinReadModeMarkup(html: string): boolean;
  readModeWalkCost(root: unknown): number | null;
  MAX_READ_MODE_COST: number;
  MAX_READ_MODE_WORK: number;
  // The same pieces with nothing in front of them.
  unguardedBlocks(html: string, finalUrl: URL): number | null;
  parseDocument(html: string): unknown;
}

async function extractorBundle(runDir: string): Promise<Extractor> {
  const file = (path: string) => JSON.stringify(join(ROOT, 'apps/bracemark-extractor/src', path));
  const entry = `
export { safeFetch, readCappedBytes, MAX_HTML_BYTES } from ${file('lib/safe-fetch.ts')};
export { createRobotsReader } from ${file('lib/robots.ts')};
export { decodeHtml, readModeFromHtml, readModeWork } from ${file('lib/read-mode.ts')};
export { withinReadModeMarkup, readModeWalkCost, MAX_READ_MODE_COST } from ${file('lib/read-mode-limits.ts')};
export { MAX_READ_MODE_WORK } from ${file('lib/read-mode-meter.ts')};
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { readerCaptureFromArticle } from "@stxapps/shared/reader/reader-doc-from-dom";

export const parseDocument = (html) => parseHTML(html).document;

// Plain Readability, then the walker, as the pipeline runs them, minus every guard and
// the base URL (which moves no block count).
export function unguardedBlocks(html, finalUrl) {
  const article = new Readability(parseHTML(html).document).parse();
  if (!article?.content) return null;
  const body = parseHTML("<!doctype html><html><body>" + article.content + "</body></html>").document.body;
  return readerCaptureFromArticle(body, article, finalUrl.toString(), 0)?.doc.blocks.length ?? null;
}
`;
  const out = join(runDir, 'extractor.mjs');
  await build({
    stdin: {
      contents: entry,
      resolveDir: join(ROOT, 'apps/bracemark-extractor'),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    outfile: out,
    logLevel: 'error',
  });
  return (await import(pathToFileURL(out).href)) as Extractor;
}

function parseOptions(args: string[]): Options {
  const options: Options = { limit: null, kind: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--limit takes a positive number');
      options.limit = n;
    } else if (arg === '--kind') {
      const kind = args[++i];
      if (kind !== 'article' && kind !== 'page') throw new Error('--kind takes article or page');
      options.kind = kind;
    } else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

const isHtml = (contentType: string) =>
  contentType === 'text/html' || contentType === 'application/xhtml+xml';

const contentTypeOf = (res: Response) =>
  (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
};

async function measurePage(
  x: Extractor,
  robots: ReturnType<Extractor['createRobotsReader']>,
  target: MeasuredPage,
): Promise<PageResult> {
  try {
    const early = await robots(new URL(target.url));
    if (early !== 'allowed') return { ...target, ok: true, robots: early };

    const { response, finalUrl } = await x.safeFetch(target.url, 'text/html,application/xhtml+xml');
    if (!isHtml(contentTypeOf(response))) {
      await response.body?.cancel().catch(() => undefined);
      return { ...target, ok: false, error: `not html (${contentTypeOf(response)})` };
    }
    const bytes = await x.readCappedBytes(response, x.MAX_HTML_BYTES);
    const late = await robots(finalUrl);
    if (late !== 'allowed') return { ...target, ok: true, robots: late, finalUrl: finalUrl.href };
    const html = x.decodeHtml(bytes, response.headers.get('content-type'));

    const result: PageResult = {
      ...target,
      ok: true,
      finalUrl: finalUrl.href,
      htmlBytes: bytes.length,
      truncated: bytes.length >= x.MAX_HTML_BYTES,
      walkCost: null,
      meterUnits: null,
    };
    // Each guard on its own, in the pipeline's order.
    let refusedBy: RefusedBy | null = null;
    if (!x.withinReadModeMarkup(html)) refusedBy = 'markup';
    else {
      result.walkCost = x.readModeWalkCost(x.parseDocument(html));
      if (result.walkCost === null) refusedBy = 'walk';
      else {
        result.meterUnits = x.readModeWork(html, finalUrl, Infinity);
        if (result.meterUnits !== null && result.meterUnits > x.MAX_READ_MODE_WORK) {
          refusedBy = 'meter';
        }
      }
    }
    result.refusedBy = refusedBy;

    const verdict = timed(() => x.readModeFromHtml(html, finalUrl));
    result.blocks = verdict.value?.doc.blocks.length ?? null;
    result.ms = verdict.ms;
    if (refusedBy) {
      const raw = timed(() => x.unguardedBlocks(html, finalUrl));
      result.unguarded = { blocks: raw.value, ms: raw.ms };
    }
    return result;
  } catch (err) {
    return {
      ...target,
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

// Nearest-rank percentile over a sorted copy.
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function line(label: string, values: number[], format: (n: number) => string): string {
  if (values.length === 0) return `  ${label.padEnd(30)} —`;
  return `  ${label.padEnd(30)} median ${format(percentile(values, 50))}, p90 ${format(
    percentile(values, 90),
  )}, max ${format(Math.max(...values))} (n=${values.length})`;
}

const share = (part: number, whole: number) =>
  whole === 0 ? '—' : `${Math.round((100 * part) / whole)}%`;

function summarize(results: PageResult[], x: Extractor): string {
  const ok = results.filter((r) => r.ok);
  const read = ok.filter((r) => !r.robots);
  const refused = read.filter((r) => r.refusedBy);
  const falseRefusals = refused.filter((r) => (r.unguarded?.blocks ?? null) !== null);
  const pct = (n: number) => `${(100 * n).toFixed(n < 0.01 ? 2 : 1)}%`;
  const ms = (n: number) => `${n.toFixed(0)} ms`;
  const rows = [
    `Server read mode over ${results.length} real pages (Node; verdicts are production’s, times are not):`,
    `  robots.txt: disallowed ${ok.filter((r) => r.robots === 'disallowed').length}, unavailable ${
      ok.filter((r) => r.robots === 'unavailable').length
    }; read ${read.length}; failed ${results.length - ok.length}`,
    `  kept ${read.filter((r) => r.blocks !== null).length}, not-an-article ${
      read.filter((r) => r.blocks === null).length
    }, of which a guard refused ${refused.length} (${['markup', 'walk', 'meter']
      .map((g) => `${g} ${refused.filter((r) => r.refusedBy === g).length}`)
      .join(', ')})`,
    `  FALSE refusals (a guard refused, Readability alone keeps blocks): ${falseRefusals.length}`,
    `  truncated at MAX_HTML_BYTES: ${read.filter((r) => r.truncated).length} of ${read.length}`,
    '',
    'Headroom, over the pages each check was reached on:',
    line(
      'walk cost / MAX_READ_MODE_COST',
      read.flatMap((r) => (r.walkCost == null ? [] : [r.walkCost / x.MAX_READ_MODE_COST])),
      pct,
    ),
    line(
      'meter units / MAX_READ_MODE_WORK',
      read.flatMap((r) => (r.meterUnits == null ? [] : [r.meterUnits / x.MAX_READ_MODE_WORK])),
      pct,
    ),
    line(
      'readModeFromHtml',
      read.flatMap((r) => (r.ms === undefined ? [] : [r.ms])),
      ms,
    ),
    `  under 10 ms (the Workers Free CPU limit): ${share(
      read.filter((r) => (r.ms ?? Infinity) < 10).length,
      read.length,
    )}`,
  ];
  if (refused.length > 0) {
    rows.push('', 'Refused by a guard:');
    for (const r of refused) {
      rows.push(
        `  ${r.url} — ${r.refusedBy}; unguarded ${
          r.unguarded?.blocks == null ? 'not an article' : `${r.unguarded.blocks} blocks`
        } in ${ms(r.unguarded?.ms ?? 0)}`,
      );
    }
  }
  const slowest = [...read].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5);
  rows.push('', 'Slowest:');
  for (const r of slowest) {
    rows.push(
      `  ${ms(r.ms ?? 0).padStart(7)}  ${r.url} (${((r.htmlBytes ?? 0) / 1000).toFixed(0)} KB)`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    rows.push('', 'failed (left out of the figures):');
    for (const r of failed) rows.push(`  ${r.url} — ${r.error}`);
  }
  return rows.join('\n');
}

function detail(r: PageResult): string {
  if (!r.ok) return `FAILED: ${r.error}`;
  if (r.robots) return `robots.txt ${r.robots}`;
  const verdict = r.blocks === null ? 'not-an-article' : `${r.blocks} blocks`;
  const guard = r.refusedBy
    ? `, refused by ${r.refusedBy} (unguarded: ${r.unguarded?.blocks ?? 'none'} blocks, ${r.unguarded?.ms.toFixed(0)} ms)`
    : '';
  return `${verdict} in ${r.ms?.toFixed(0)} ms, ${((r.htmlBytes ?? 0) / 1000).toFixed(0)} KB${
    r.truncated ? ' (truncated)' : ''
  }, walk ${r.walkCost?.toExponential(1) ?? '—'}, meter ${r.meterUnits?.toExponential(1) ?? '—'}${guard}`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const pages = KEPT_COPY_PAGES.filter((p) => !options.kind || p.kind === options.kind).slice(
    0,
    options.limit ?? undefined,
  );
  const runDir = join(MEASURE_OUTPUT, createRunId('measure-server-read-mode'));
  await mkdir(runDir, { recursive: true });
  const extractor = await extractorBundle(runDir);
  // One reader for the run, as one request shares one: each origin's robots.txt once.
  const robots = extractor.createRobotsReader();

  const results: PageResult[] = [];
  for (const [i, target] of pages.entries()) {
    const result = await measurePage(extractor, robots, target);
    results.push(result);
    console.log(`[${i + 1}/${pages.length}] ${target.url}\n    ${detail(result)}`);
  }

  const summary = summarize(results, extractor);
  await writeFile(join(runDir, 'results.json'), JSON.stringify({ options, results }, null, 2));
  await writeFile(join(runDir, 'summary.txt'), `${summary}\n`);
  console.log(`\n${summary}\n\nresults in ${runDir}`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
