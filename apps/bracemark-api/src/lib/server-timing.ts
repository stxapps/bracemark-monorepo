import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { AppEnv } from './env';

// A `Server-Timing` header on every response, breaking a request into the calls
// it waited on — the session read, the Durable Object, R2 — so a slow `ops/commit`
// in a sync measurement can be told apart as time in this Worker or time on the
// wire (docs/local-first-sync.md, _measuring a sync_). The client's own spans
// (@stxapps/shared sync/trace.ts) see only the round trip; this is the inside of it.
//
// ON WHERE `SERVER_TIMING` IS "1" — development and staging (wrangler.jsonc).
// Production sends nothing extra: the header would name which stores a request
// touched and how long each took, which no client needs, and flipping one var
// is all it takes to measure there too.
//
// What a duration here MEANS: a Worker's clock only moves across I/O (the
// Spectre mitigation freezes `Date.now()` while JS runs), so each metric is the
// wait on the call it wraps, and none of them counts this Worker's own CPU.
// That is the half a sync measurement needs; CPU time is in the Workers
// dashboard.
//
// Repeated names accumulate — `r2-head` over a 500-op commit is the SUM of its
// HEADs, written with `desc="n=500"`, while `r2-heads` beside it is the wall
// time of the whole parallel fan-out. Their ratio is how parallel it really was.

export type ServerTimings = Map<string, { ms: number; n: number }>;

// Wraps one awaited call. Services take one as a parameter (defaulting to
// `untimed`) rather than a Context, so they stay callable from a spec or a cron.
export type Timer = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export const untimed: Timer = (_name, run) => run();

export const serverTiming = createMiddleware<AppEnv>(async (c, next) => {
  if (c.env?.SERVER_TIMING !== '1') return next();
  const timings: ServerTimings = new Map();
  c.set('serverTimings', timings);
  const start = Date.now();
  await next();
  addTiming(timings, 'total', Date.now() - start);
  c.header('Server-Timing', formatTimings(timings));
  // Lets the page's own Resource Timing read the header too, for the same
  // origins CORS lets read the response. A CDP capture sees it either way.
  const origin = c.req.header('Origin');
  if (origin && (c.env.CORS_ORIGINS?.split(',') ?? []).includes(origin)) {
    c.header('Timing-Allow-Origin', origin);
  }
});

export function timerFor(c: Context<AppEnv>): Timer {
  const timings = c.get('serverTimings');
  if (!timings) return untimed;
  return async (name, run) => {
    const start = Date.now();
    try {
      return await run();
    } finally {
      addTiming(timings, name, Date.now() - start);
    }
  };
}

function addTiming(timings: ServerTimings, name: string, ms: number): void {
  const entry = timings.get(name);
  if (entry) {
    entry.ms += ms;
    entry.n += 1;
  } else {
    timings.set(name, { ms, n: 1 });
  }
}

export function formatTimings(timings: ServerTimings): string {
  return [...timings]
    .map(([name, { ms, n }]) => `${name};dur=${ms}${n > 1 ? `;desc="n=${n}"` : ''}`)
    .join(', ');
}
