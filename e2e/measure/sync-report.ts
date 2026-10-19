import { type SyncSpan, type SyncTraceRow } from '@stxapps/shared';

import { type NetRequest, requestGroup } from './network';

// Turning one sync leg's raw readings — the engine's spans, the page's network
// capture, the main-thread instrument — into the tables measure/sync.ts prints,
// the highlights that say where the time went, and a waterfall to look at.

export interface NetGroupRow {
  group: string;
  n: number;
  failed: number;
  // Answered, then aborted by the page (network.ts).
  aborted: number;
  // Responses outside 2xx, by status.
  statuses: Record<string, number>;
  protocols: string[];
  // Answered by the service worker (network.ts, the ⚠ on hidden wires).
  viaWorker: number;
  // Distinct sockets Chrome used. Six to one host under load is HTTP/1.1's cap.
  sockets: number;
  wallMs: number;
  totalMs: number;
  concurrency: number;
  p50Ms: number;
  p95Ms: number;
  queuedP50Ms: number;
  queuedP95Ms: number;
  waitP50Ms: number;
  waitP95Ms: number;
  bytes: number;
  // bracemark-api's Server-Timing, each metric summed over the group.
  serverTiming: Record<string, number>;
}

export function summarizeNetwork(
  requests: readonly NetRequest[],
  appOrigin: string,
  window: { since: number; until: number },
): NetGroupRow[] {
  const groups = new Map<string, NetRequest[]>();
  for (const req of requests) {
    if (req.end === undefined || req.end < window.since || req.start > window.until) continue;
    const group = requestGroup(req, appOrigin);
    if (!group) continue;
    const list = groups.get(group);
    if (list) list.push(req);
    else groups.set(group, [req]);
  }

  const rows: NetGroupRow[] = [];
  for (const [group, list] of groups) {
    const durations = list.map((r) => Math.max(0, (r.end ?? r.start) - r.start));
    const totalMs = durations.reduce((sum, d) => sum + d, 0);
    const wallMs = unionMs(list.map((r) => ({ start: r.start, end: r.end ?? r.start })));
    const statuses: Record<string, number> = {};
    for (const r of list) {
      if (r.status !== undefined && (r.status < 200 || r.status >= 300)) {
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      }
    }
    const serverTiming: Record<string, number> = {};
    for (const r of list) {
      for (const [metric, value] of Object.entries(r.serverTiming ?? {})) {
        serverTiming[metric] = (serverTiming[metric] ?? 0) + value;
      }
    }
    const pick = (key: 'queuedMs' | 'waitMs') =>
      list.map((r) => r[key]).filter((v): v is number => v !== undefined);
    rows.push({
      group,
      n: list.length,
      failed: list.filter((r) => r.failed).length,
      aborted: list.filter((r) => r.abortedAfterResponse).length,
      statuses,
      protocols: [...new Set(list.map((r) => r.protocol).filter((p): p is string => !!p))],
      viaWorker: list.filter((r) => r.fromServiceWorker).length,
      sockets: new Set(list.map((r) => r.connectionId).filter((c) => c !== undefined && c > 0))
        .size,
      wallMs,
      totalMs,
      concurrency: wallMs > 0 ? totalMs / wallMs : 0,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      queuedP50Ms: percentile(pick('queuedMs'), 0.5),
      queuedP95Ms: percentile(pick('queuedMs'), 0.95),
      waitP50Ms: percentile(pick('waitMs'), 0.5),
      waitP95Ms: percentile(pick('waitMs'), 0.95),
      bytes: list.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
      serverTiming,
    });
  }
  return rows.sort((a, b) => b.wallMs - a.wallMs);
}

export function formatNetwork(rows: readonly NetGroupRow[]): string {
  const ms = (n: number) => `${Math.round(n).toLocaleString('en-US')} ms`;
  const header = [
    'requests',
    'n',
    'bad',
    'proto',
    'sw',
    'sockets',
    'wall',
    'in flight',
    'p50',
    'p95',
    'queued p50/p95',
    'ttfb p50/p95',
  ];
  const body = rows.map((r) => [
    r.group,
    String(r.n),
    [
      r.failed > 0 ? `${r.failed} failed` : '',
      ...Object.entries(r.statuses).map(([s, c]) => `${c}×${s}`),
    ]
      .filter(Boolean)
      .join(' '),
    r.protocols.join(',') || '?',
    r.viaWorker > 0 ? String(r.viaWorker) : '',
    r.sockets > 0 ? String(r.sockets) : '',
    ms(r.wallMs),
    r.concurrency.toFixed(1),
    ms(r.p50Ms),
    ms(r.p95Ms),
    `${ms(r.queuedP50Ms)} / ${ms(r.queuedP95Ms)}`,
    `${ms(r.waitP50Ms)} / ${ms(r.waitP95Ms)}`,
  ]);
  return table(header, body);
}

// The api's own account of where its time went, per endpoint: each metric's
// sum over the leg, and its mean per request.
export function formatServerTiming(rows: readonly NetGroupRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const metrics = Object.entries(row.serverTiming).filter(([name]) => !name.endsWith('.n'));
    if (metrics.length === 0) continue;
    const parts = metrics.map(
      ([name, sum]) => `${name} ${Math.round(sum / row.n).toLocaleString('en-US')} ms`,
    );
    lines.push(`  ${row.group} (mean of ${row.n}): ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

export interface CycleRow {
  kind: string;
  start: number;
  ms: number;
  pending: number;
  failed?: string;
}

export function cyclesOf(spans: readonly SyncSpan[], since: number, until: number): CycleRow[] {
  return spans
    .filter((s) => s.name === 'cycle' && s.end >= since && s.start <= until)
    .map((s) => ({
      kind: String(s.attrs?.kind ?? '?'),
      start: s.start,
      ms: s.end - s.start,
      pending: Number(s.attrs?.pending ?? 0),
      ...(s.failed ? { failed: s.failed } : {}),
    }));
}

// The few readings that answer "where did the time go" without the tables:
// each compares what the engine was configured to do with what it did.
export function highlights(input: {
  phases: readonly SyncTraceRow[];
  network: readonly NetGroupRow[];
  cycles: readonly CycleRow[];
  spans: readonly SyncSpan[];
  wallMs: number;
  blockingMs: number;
}): string[] {
  const { phases, network, cycles, spans, wallMs, blockingMs } = input;
  const row = (name: string) => phases.find((p) => p.name === name);
  const out: string[] = [];
  const pct = (ms: number) => `${Math.round((ms / Math.max(wallMs, 1)) * 100)}%`;
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

  if (cycles.length > 0) {
    const failed = cycles.filter((c) => c.failed).length;
    out.push(
      `${cycles.length} cycle(s) covered the leg${failed > 0 ? `, ${failed} failed` : ''}; ` +
        `cycles ran ${s(unionMs(cycles.map((c) => ({ start: c.start, end: c.start + c.ms }))))} ` +
        `of the ${s(wallMs)} wall`,
    );
  }
  for (const name of ['upload', 'download', 'commit', 'api /v1/files/sign', 'commit.restamp']) {
    const r = row(name);
    if (r) out.push(`${name}: ${s(r.wallMs)} (${pct(r.wallMs)} of the leg) over ${r.count}`);
  }
  for (const [blob, fan] of [
    ['blob.put', 'upload'],
    ['blob.get', 'download'],
  ] as const) {
    const r = row(blob);
    const configured = [
      ...new Set(spans.filter((sp) => sp.name === fan).map((sp) => sp.attrs?.concurrency)),
    ].filter((c) => c !== undefined);
    if (r && r.count > 0) {
      out.push(
        `${blob}: ${r.concurrency.toFixed(1)} in flight on average` +
          `${configured.length > 0 ? ` (configured ${configured.join(' / ')})` : ''}, ` +
          `p50 ${Math.round(r.p50Ms)} ms, ` +
          `${(r.count / Math.max(r.wallMs / 1000, 0.001)).toFixed(1)}/s while running`,
      );
    }
  }
  for (const r of network.filter((n) => n.group.startsWith('blob '))) {
    out.push(
      `${r.group}: ${r.protocols.join(',') || 'protocol hidden'}` +
        `${r.sockets ? `, ${r.sockets} socket(s)` : ''}` +
        `${r.viaWorker ? `, ${r.viaWorker}/${r.n} via the service worker` : ''}` +
        `${r.aborted ? `, ${r.aborted} aborted after the answer` : ''}` +
        `, queued p50 ${Math.round(r.queuedP50Ms)} ms, ttfb p50 ${Math.round(r.waitP50Ms)} ms`,
    );
  }
  const preflights = network
    .filter((n) => n.group.includes('OPTIONS'))
    .reduce((sum, n) => sum + n.n, 0);
  if (preflights > 0) out.push(`${preflights} CORS preflight(s) seen`);
  const limited = spans.filter((sp) => sp.name.startsWith('api ') && sp.attrs?.status === 429);
  if (limited.length > 0) {
    const waited = limited.reduce((sum, sp) => sum + Number(sp.attrs?.retryAfterMs ?? 0), 0);
    out.push(`${limited.length}× 429 from the api, ≈${s(waited)} of Retry-After waits`);
  }
  if (blockingMs > 0) out.push(`main thread: ${s(blockingMs)} of long-task blocking`);
  return out;
}

// The leg as a Chrome trace (chrome://tracing, ui.perfetto.dev): the engine's
// spans on one track group, the network on another, each laid into as many
// lanes as were in flight at once. The picture shows what the tables can only
// summarize — a fan-out that drains to one straggler, a gap where nothing ran.
export function waterfall(
  spans: readonly SyncSpan[],
  requests: readonly NetRequest[],
  appOrigin: string,
  window: { since: number; until: number },
): object {
  const events: object[] = [];
  const us = (ms: number) => Math.round((ms - window.since) * 1000);
  const inWindow = <T extends { start: number; end?: number }>(x: T) =>
    (x.end ?? x.start) >= window.since && x.start <= window.until;

  const lanes = (pid: number, pool: string, items: { start: number; end: number }[]) => {
    const ends: number[] = [];
    return items.map((item) => {
      let lane = ends.findIndex((end) => end <= item.start);
      if (lane === -1) {
        lane = ends.length;
        ends.push(item.end);
        events.push({
          name: 'thread_name',
          ph: 'M',
          pid,
          tid: `${pool}-${lane}`,
          args: { name: `${pool} ${lane}` },
        });
      } else {
        ends[lane] = item.end;
      }
      return `${pool}-${lane}`;
    });
  };

  const engine = spans.filter(inWindow).sort((a, b) => a.start - b.start);
  for (const pool of ['phase', 'blob']) {
    const items = engine.filter((sp) => sp.name.startsWith('blob.') === (pool === 'blob'));
    const tids = lanes(1, pool, items);
    items.forEach((sp, i) =>
      events.push({
        name: sp.name,
        ph: 'X',
        pid: 1,
        tid: tids[i],
        ts: us(sp.start),
        dur: Math.max(1, us(sp.end) - us(sp.start)),
        args: { ...sp.attrs, ...(sp.failed ? { failed: sp.failed } : {}) },
      }),
    );
  }

  const net = requests
    .filter((r) => r.end !== undefined && inWindow(r) && requestGroup(r, appOrigin))
    .sort((a, b) => a.start - b.start);
  const tids = lanes(
    2,
    'net',
    net.map((r) => ({ start: r.start, end: r.end ?? r.start })),
  );
  net.forEach((r, i) =>
    events.push({
      name: requestGroup(r, appOrigin),
      ph: 'X',
      pid: 2,
      tid: tids[i],
      ts: us(r.start),
      dur: Math.max(1, us(r.end ?? r.start) - us(r.start)),
      args: {
        status: r.status,
        protocol: r.protocol,
        queuedMs: r.queuedMs,
        waitMs: r.waitMs,
        workerMs: r.workerMs,
        serverTiming: r.serverTiming,
        failed: r.failed,
      },
    }),
  );

  events.push(
    { name: 'process_name', ph: 'M', pid: 1, args: { name: 'sync engine' } },
    { name: 'process_name', ph: 'M', pid: 2, args: { name: 'network' } },
  );
  return { traceEvents: events, displayTimeUnit: 'ms' };
}

function unionMs(items: readonly { start: number; end: number }[]): number {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  let total = 0;
  let open = -Infinity;
  let close = -Infinity;
  for (const { start, end } of sorted) {
    if (start > close) {
      if (close > open) total += close - open;
      open = start;
      close = end;
    } else if (end > close) close = end;
  }
  if (close > open) total += close - open;
  return total;
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function table(header: string[], body: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
