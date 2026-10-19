import { type ApiClient, ApiError } from '../api/client';

// Timing spans for the sync engines — the instrument behind `measure:sync`
// (docs/local-first-sync.md, _measuring a sync_). A push of a thousand links
// takes minutes, and a wall clock alone says only that; what decides where to
// spend the effort is which phase owns the time, and how many transfers were
// really in flight while it ran. So each engine reports spans — a name, a
// start, an end — around the steps that can cost time, and this module turns
// them into that table.
//
// OFF BY DEFAULT, AND FREE WHEN OFF. Each engine holds `NO_TRACE` until a
// caller installs a recorder (`installSyncTrace`): bracemark-web behind a
// localStorage flag, bracemark-expo behind `EXPO_PUBLIC_SYNC_TRACE=1`. With
// NO_TRACE, `span` runs its body and nothing else, and `traceApi` hands back the
// client it was given.
//
// One vocabulary, so the two engines' readings compare line for line:
//
//   cycle            one cycle under the cycle lock {kind: initial|incremental|fallback}
//   cycle.lock       the wait for the cycle lock (another tab's cycle, a held delete)
//   queue.read       reading the pending-ops queue
//   api <path>       one contract call ATTEMPT, so a retried 429 is two spans with
//                    the backoff between them {status on failure, retryAfterMs}
//   push             a whole drain {puts, deletes}
//   push.chunk       one sign → upload → commit pass, to its commit's end — beside
//                    the next chunk's sign and upload {kind: content|index, ops}
//   upload           a chunk's PUT fan-out {ops, concurrency}
//   blob.read        reading one op's local record (and its queue row)
//   blob.encrypt     sealing one blob
//   blob.put         one R2 PUT {bytes, ns}
//   commit           one ops/commit batch, local bookkeeping included {ops}
//   commit.restamp   writing the commit's stamps onto the local records
//   commit.clear     removing the committed ops from the queue
//   pull             a download set {entries}
//   download         a pull's GET fan-out, first queued GET to last {entries, concurrency}
//   blob.get         one R2 GET {bytes, ns}
//   blob.decrypt     opening one blob
//   blob.store       writing one pulled record
//   deletes.apply    dropping the records a pull judged deleted {paths}
//
// Times are epoch milliseconds (timeOrigin + performance.now() where there is
// one), so a page's spans line up with a CDP network capture by wall clock.

export type SyncTraceAttrs = Record<string, string | number | boolean>;

export interface SyncSpan {
  name: string;
  start: number;
  end: number;
  attrs?: SyncTraceAttrs;
  // The error's name when the body threw. The span is recorded either way: a
  // failed PUT spent its time too.
  failed?: string;
}

export type SyncTraceNote = (attrs: SyncTraceAttrs) => void;

export interface SyncTrace {
  readonly enabled: boolean;
  now(): number;
  record(span: SyncSpan): void;
  // Time `run`. `note` adds attributes known only once the body has them — a
  // blob's size after it is sealed, a status after the call failed.
  span<T>(
    name: string,
    run: (note: SyncTraceNote) => Promise<T>,
    attrs?: SyncTraceAttrs,
  ): Promise<T>;
}

const noNote: SyncTraceNote = () => undefined;

export const NO_TRACE: SyncTrace = {
  enabled: false,
  now: () => 0,
  record: () => undefined,
  span: (_name, run) => run(noNote),
};

export interface SyncTraceRecorder extends SyncTrace {
  readonly spans: readonly SyncSpan[];
  // Spans refused once `maxSpans` was reached. A non-zero count means the
  // summary undercounts, and says so.
  readonly dropped: number;
  clear(): void;
  summary(window?: { since?: number; until?: number }): SyncTraceRow[];
}

export interface SyncTraceOptions {
  // A bound on memory, not a sampling rate: a 5,000-link push records ~90,000
  // spans, well under it.
  maxSpans?: number;
  now?: () => number;
  // Called with every recorded span — bracemark-expo prints a cycle's table
  // when its `cycle` span lands.
  onRecord?: (span: SyncSpan) => void;
}

function defaultNow(): number {
  const perf = typeof performance !== 'undefined' ? performance : undefined;
  if (perf?.timeOrigin && typeof perf.now === 'function') return perf.timeOrigin + perf.now();
  return Date.now();
}

export function createSyncTraceRecorder(options: SyncTraceOptions = {}): SyncTraceRecorder {
  const { maxSpans = 200_000, now = defaultNow, onRecord } = options;
  const spans: SyncSpan[] = [];
  let dropped = 0;

  const record = (span: SyncSpan): void => {
    if (spans.length >= maxSpans) {
      dropped += 1;
      return;
    }
    spans.push(span);
    onRecord?.(span);
  };

  return {
    enabled: true,
    now,
    record,
    async span(name, run, attrs) {
      const start = now();
      const noted: SyncTraceAttrs = { ...attrs };
      const note: SyncTraceNote = (more) => Object.assign(noted, more);
      const finish = (failed?: string) => {
        const span: SyncSpan = { name, start, end: now() };
        if (Object.keys(noted).length > 0) span.attrs = noted;
        if (failed) span.failed = failed;
        record(span);
      };
      try {
        const value = await run(note);
        finish();
        return value;
      } catch (err) {
        finish(err instanceof Error ? err.name : 'Error');
        throw err;
      }
    },
    get spans() {
      return spans;
    },
    get dropped() {
      return dropped;
    },
    clear() {
      spans.length = 0;
      dropped = 0;
    },
    summary(window) {
      return summarizeSyncTrace(spans, window);
    },
  };
}

// Every contract call as its own `api <path>` span, one per ATTEMPT: wrap the
// client BEFORE withRetry so a 429 and its retry read as two spans with the
// backoff between them, rather than one long call.
export function traceApi(api: ApiClient, trace: SyncTrace): ApiClient {
  if (!trace.enabled) return api;
  return {
    call: (endpoint, input, callOptions) =>
      trace.span(`api ${endpoint.path}`, async (note) => {
        try {
          return await api.call(endpoint, input, callOptions);
        } catch (err) {
          if (err instanceof ApiError) {
            note({ status: err.status });
            if (err.retryAfterSeconds !== undefined) {
              note({ retryAfterMs: err.retryAfterSeconds * 1000 });
            }
          }
          throw err;
        }
      }),
  };
}

// The first segment of a sync path (`links/l_x.enc` → `links`), for a blob
// span's `ns` — enough to tell index blobs from `files/` content in a reading.
export function syncNamespace(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(0, slash);
}

export interface SyncTraceRow {
  name: string;
  count: number;
  failed: number;
  // Every span's duration added up — the work.
  totalMs: number;
  // The time at least one span of this name was running — the part of the
  // clock it owns.
  wallMs: number;
  // totalMs / wallMs: how many were really in flight on average. A fan-out
  // configured at 24 that reads 5 here is being held back by something.
  concurrency: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  // Summed `bytes` attributes, where the spans carry them.
  bytes: number;
}

// Per span name, over the spans that overlap the window. Rows come out in the
// order their name first appears, which reads top-down like the cycle itself.
export function summarizeSyncTrace(
  spans: readonly SyncSpan[],
  window: { since?: number; until?: number } = {},
): SyncTraceRow[] {
  const since = window.since ?? -Infinity;
  const until = window.until ?? Infinity;
  const byName = new Map<string, SyncSpan[]>();
  for (const span of spans) {
    if (span.end < since || span.start > until) continue;
    const list = byName.get(span.name);
    if (list) list.push(span);
    else byName.set(span.name, [span]);
  }

  const rows: SyncTraceRow[] = [];
  for (const [name, list] of byName) {
    const durations = list.map((s) => s.end - s.start).sort((a, b) => a - b);
    const totalMs = durations.reduce((sum, d) => sum + d, 0);
    const wallMs = unionMs(list);
    rows.push({
      name,
      count: list.length,
      failed: list.filter((s) => s.failed).length,
      totalMs,
      wallMs,
      concurrency: wallMs > 0 ? totalMs / wallMs : 0,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations[durations.length - 1] ?? 0,
      bytes: list.reduce((sum, s) => sum + (Number(s.attrs?.bytes) || 0), 0),
    });
  }
  return rows;
}

function unionMs(spans: readonly SyncSpan[]): number {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let total = 0;
  let open = -Infinity;
  let close = -Infinity;
  for (const { start, end } of sorted) {
    if (start > close) {
      if (close > open) total += close - open;
      open = start;
      close = end;
    } else if (end > close) {
      close = end;
    }
  }
  if (close > open) total += close - open;
  return total;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// The summary as a fixed-width table, for a console (bracemark-expo's log, the
// measure runner's report).
export function formatSyncTraceSummary(rows: readonly SyncTraceRow[]): string {
  const ms = (n: number) => `${Math.round(n).toLocaleString('en-US')} ms`;
  const header = [
    'span',
    'n',
    'failed',
    'wall',
    'total',
    'in flight',
    'p50',
    'p95',
    'max',
    'bytes',
  ];
  const body = rows.map((r) => [
    r.name,
    String(r.count),
    r.failed > 0 ? String(r.failed) : '',
    ms(r.wallMs),
    ms(r.totalMs),
    r.concurrency.toFixed(1),
    ms(r.p50Ms),
    ms(r.p95Ms),
    ms(r.maxMs),
    r.bytes > 0 ? r.bytes.toLocaleString('en-US') : '',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
