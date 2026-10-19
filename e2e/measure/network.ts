import { type CDPSession, type Page } from '@playwright/test';

// The network half of the sync measurement (measure/sync.ts): every request the
// page makes, as Chrome's own Network domain reports it. The engine's spans
// (@stxapps/shared sync/trace.ts) say how long a PUT took from the engine's
// side; this says what the browser did with it — whether it waited in Chrome's
// queue for a socket, which protocol it rode, how many sockets a host got, how
// long the server took to answer, and what the api's Server-Timing says it did
// meanwhile. The page's own Resource Timing can't: cross-origin entries without
// Timing-Allow-Origin come back zeroed, and R2 sends none.
//
// ⚠ A PRESIGNED URL IS A CREDENTIAL — a GET one for an hour. Every URL is kept
// as origin + path; the query, where the signature lives, never reaches a
// result file. The one place full URLs are handled at all is
// `signedGetUrls`, whose answer stays in memory for the floor leg.
//
// ⚠ A SERVICE WORKER HIDES THE WIRE. A production build's worker answers every
// cross-origin request (bracemark-web sw.ts, the NetworkOnly route), so the page
// sees each one as `fromServiceWorker` with the worker's timing, and the real
// request — its preflight, its socket, its protocol — happens in the worker,
// out of this session's sight. Those requests are still counted and timed end
// to end; the breakdown needs a run with the worker blocked (`--no-sw`).

// bracemark-api's local-dev blob proxy, which stands in for R2 under `wrangler
// dev` (bracemark-api r2/local.ts, LOCAL_BLOB_PATH_PREFIX). Duplicated rather
// than imported: e2e reads the running system from outside.
const LOCAL_BLOB_PREFIX = '/v1/files/blob/';
const SIGN_PATH = '/v1/files/sign';

export interface NetRequest {
  id: string;
  origin: string;
  path: string;
  method: string;
  type?: string;
  // Epoch ms, so they line up with the engine's spans.
  start: number;
  end?: number;
  status?: number;
  protocol?: string;
  fromServiceWorker?: boolean;
  connectionId?: number;
  bytes?: number;
  failed?: string;
  // Answered, then aborted by the page. The sync's R2 helpers abort their
  // deadline's signal once a transfer settles (shared async/with-deadline.ts), and
  // Chrome reports the already-answered request as canceled. Not a failure, but
  // counted: an abort before the body is drained can cost the socket.
  abortedAfterResponse?: boolean;
  // From Chrome's ResourceTiming, in ms. `queuedMs` is DevTools' Queueing +
  // Stalled: from the request being issued to its first network phase — the
  // wait for a free socket under HTTP/1.1's six-per-host cap shows up here.
  queuedMs?: number;
  connectMs?: number;
  // Time to first byte: request sent → response headers in.
  waitMs?: number;
  // A worker-answered request's time inside the worker.
  workerMs?: number;
  serverTiming?: Record<string, number>;
}

interface Timing {
  requestTime: number;
  dnsStart: number;
  connectStart: number;
  connectEnd: number;
  sendStart: number;
  sendEnd: number;
  receiveHeadersEnd: number;
  workerStart?: number;
  workerRespondWithSettled?: number;
}

interface Pending {
  req: NetRequest;
  // Chrome's monotonic clock at issue, in ms — the base for every later event.
  mono: number;
}

export interface NetworkCapture {
  requests(): NetRequest[];
  // The GET URLs this page's `files/sign` calls minted, full — for the floor
  // leg, in memory only (see the ⚠ above).
  signedGetUrls(): Promise<string[]>;
  stop(): Promise<void>;
}

export async function captureNetwork(page: Page): Promise<NetworkCapture> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  // Big enough to keep every files/sign body until the floor leg asks for one.
  await cdp.send('Network.enable', {
    maxTotalBufferSize: 256 * 1024 * 1024,
    maxResourceBufferSize: 16 * 1024 * 1024,
  });

  const pending = new Map<string, Pending>();
  const done: NetRequest[] = [];
  const signIds: string[] = [];
  const wallOf = (p: Pending, monoSeconds: number) => p.req.start + (monoSeconds * 1000 - p.mono);

  cdp.on('Network.requestWillBeSent', (event) => {
    const url = new URL(event.request.url);
    if (!url.protocol.startsWith('http')) return;
    const req: NetRequest = {
      id: event.requestId,
      origin: url.origin,
      path: url.pathname,
      method: event.request.method,
      type: event.type,
      start: event.wallTime * 1000,
    };
    pending.set(event.requestId, { req, mono: event.timestamp * 1000 });
    if (url.pathname === SIGN_PATH && event.request.method === 'POST')
      signIds.push(event.requestId);
  });

  cdp.on('Network.responseReceived', (event) => {
    const p = pending.get(event.requestId);
    if (!p) return;
    const { response } = event;
    p.req.status = response.status;
    p.req.protocol = response.protocol;
    p.req.fromServiceWorker = response.fromServiceWorker || undefined;
    p.req.connectionId = response.connectionId;
    const timing = response.timing as Timing | undefined;
    if (timing) Object.assign(p.req, breakdown(timing, p.mono));
    const header = headerValue(response.headers, 'server-timing');
    if (header) p.req.serverTiming = parseServerTiming(header);
  });

  // Some headers only arrive here (the raw set), Server-Timing among them on
  // some responses.
  cdp.on('Network.responseReceivedExtraInfo', (event) => {
    const p = pending.get(event.requestId);
    if (!p || p.req.serverTiming) return;
    const header = headerValue(event.headers, 'server-timing');
    if (header) p.req.serverTiming = parseServerTiming(header);
  });

  cdp.on('Network.loadingFinished', (event) => {
    const p = pending.get(event.requestId);
    if (!p) return;
    p.req.end = wallOf(p, event.timestamp);
    p.req.bytes = event.encodedDataLength;
    pending.delete(event.requestId);
    done.push(p.req);
  });

  cdp.on('Network.loadingFailed', (event) => {
    const p = pending.get(event.requestId);
    if (!p) return;
    p.req.end = wallOf(p, event.timestamp);
    if (event.canceled && p.req.status !== undefined) p.req.abortedAfterResponse = true;
    else p.req.failed = event.canceled ? 'canceled' : event.errorText;
    pending.delete(event.requestId);
    done.push(p.req);
  });

  return {
    requests: () => [...done],
    async signedGetUrls() {
      const urls: string[] = [];
      for (const id of signIds) {
        try {
          const { postData } = await cdp.send('Network.getRequestPostData', { requestId: id });
          if ((JSON.parse(postData) as { op?: string }).op !== 'get') continue;
          const body = await cdp.send('Network.getResponseBody', { requestId: id });
          const text = body.base64Encoded
            ? Buffer.from(body.body, 'base64').toString('utf8')
            : body.body;
          const parsed = JSON.parse(text) as { urls?: { url: string }[] };
          urls.push(...(parsed.urls ?? []).map((u) => u.url));
        } catch {
          // Evicted from Chrome's buffer, or not JSON (an error body): skip it.
        }
      }
      return urls;
    },
    async stop() {
      await cdp.detach().catch(() => undefined);
    },
  };
}

function breakdown(t: Timing, issuedMono: number): Partial<NetRequest> {
  const out: Partial<NetRequest> = {};
  const phases = [t.dnsStart, t.connectStart, t.sendStart].filter((v) => v >= 0);
  // Clamped: a preflight's events carry the clock of the request it precedes, a
  // few ms off its own.
  if (phases.length > 0) {
    out.queuedMs = Math.max(0, round(t.requestTime * 1000 - issuedMono + Math.min(...phases)));
  }
  if (t.connectStart >= 0 && t.connectEnd >= 0)
    out.connectMs = round(t.connectEnd - t.connectStart);
  if (t.sendEnd >= 0 && t.receiveHeadersEnd >= 0) {
    out.waitMs = round(t.receiveHeadersEnd - t.sendEnd);
  }
  if ((t.workerStart ?? -1) >= 0 && (t.workerRespondWithSettled ?? -1) >= 0) {
    out.workerMs = round((t.workerRespondWithSettled ?? 0) - (t.workerStart ?? 0));
  }
  return out;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

// `auth;dur=12, r2-head;dur=900;desc="n=500"` → { auth: 12, r2-head: 900,
// 'r2-head.n': 500 }. bracemark-api writes it (lib/server-timing.ts).
export function parseServerTiming(header: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const metric of header.split(',')) {
    const [name, ...params] = metric.trim().split(';');
    if (!name) continue;
    for (const param of params) {
      const [key, raw] = param.trim().split('=');
      if (key === 'dur') out[name] = Number(raw);
      if (key === 'desc') {
        const n = /n=(\d+)/.exec(raw ?? '');
        if (n) out[`${name}.n`] = Number(n[1]);
      }
    }
  }
  return out;
}

// What a request is, for the report: one row per api endpoint, one per blob
// method. `appOrigin`'s own requests (the page, its chunks) are left out.
export function requestGroup(req: NetRequest, appOrigin: string): string | null {
  if (req.origin === appOrigin) return null;
  const preflight = req.method === 'OPTIONS' || req.type === 'Preflight';
  if (req.path.startsWith(LOCAL_BLOB_PREFIX) || !req.path.startsWith('/v1/')) {
    return preflight ? 'blob OPTIONS' : `blob ${req.method}`;
  }
  return preflight ? `api OPTIONS ${req.path}` : `api ${req.path}`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
