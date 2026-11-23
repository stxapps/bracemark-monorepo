import { type ChildProcess, spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { join } from 'node:path';

import { firefox } from '@playwright/test';

import { E2E_ROOT } from '../../paths';

// EXT-EXTRACT-003's harness: the browser extension's Firefox build, driven where
// Playwright can't. Playwright loads no extension into Firefox, so the case launches
// Playwright's own pinned Firefox (the sanctioned download, docs/e2e.md, _firefox_)
// with Marionette — Firefox's built-in remote protocol, no other driver — installs a
// small probe extension as a temporary add-on, and lets the probe inject the build's
// OWN page-meta.js into pages served from here. Nothing about the build is changed;
// the probe only carries it. docs/e2e.md, _the Firefox browser-extension target_.

const PROBE_SOURCE = join(E2E_ROOT, 'extension', 'firefox', 'probe');

export interface ProbeReport {
  scenario: 'as-it-stands' | 'moved-in-place';
  result?: { href: string; collected: Record<string, unknown> } | null;
  error?: string;
}

export interface FixtureRequest {
  path: string;
  cookie: string | undefined;
}

// --- the pages ---------------------------------------------------------------
//
// `/article` is a page at its load address. `/watch?v=A` is YouTube's shape: it sets
// a session cookie, then moves itself to `v=B` by `pushState` and updates its
// `<title>` — and nothing else, so its og tags stay A's. Its server answers `v=B` with
// B's tags, and says whether the request carried the cookie, which is what makes a
// re-read that went out anonymous visible in the title.

function page(head: string, body = ''): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function serve(
  origin: () => string,
  req: IncomingMessage,
): { status: number; headers: Record<string, string>; body: string } {
  const url = new URL(req.url ?? '/', origin());
  const html = { 'content-type': 'text/html; charset=utf-8' };
  if (url.pathname === '/article') {
    return {
      status: 200,
      headers: html,
      body: page(
        `<title>Still page - Site</title>
         <meta property="og:title" content="Still page">
         <meta property="og:image" content="${origin()}/still.jpg">`,
      ),
    };
  }
  if (url.pathname === '/watch') {
    const v = url.searchParams.get('v') ?? '';
    const signedIn = /(?:^|;\s*)sid=e2e(?:;|$)/.test(req.headers.cookie ?? '');
    const headers: Record<string, string> = { ...html };
    if (v === 'A') headers['set-cookie'] = 'sid=e2e; Path=/; SameSite=Lax';
    const move =
      v === 'A'
        ? `<script>setTimeout(() => { history.pushState({}, '', '/watch?v=B'); document.title = 'Video B - Tube'; }, 300);</script>`
        : '';
    return {
      status: 200,
      headers,
      body: page(
        `<title>Video ${v} - Tube</title>
         <meta property="og:title" content="Video ${v}${signedIn ? ' (signed in)' : ' (anonymous)'}">
         <meta property="og:image" content="${origin()}/${v}.jpg">
         <meta property="og:url" content="${origin()}/watch?v=${v}">`,
        move,
      ),
    };
  }
  return { status: 404, headers: {}, body: '' };
}

export interface FixtureServer {
  origin: string;
  requests: FixtureRequest[];
  reports: Promise<ProbeReport[]>;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const reports: ProbeReport[] = [];
  let resolveReports: (value: ProbeReport[]) => void = () => undefined;
  const done = new Promise<ProbeReport[]>((resolve) => (resolveReports = resolve));
  let origin = '';

  const server: Server = createServer((req, res) => {
    if (req.url === '/report' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const report = JSON.parse(body) as ProbeReport | { scenario: 'done' };
        if (report.scenario === 'done') resolveReports(reports);
        else reports.push(report);
        res.end('ok');
      });
      return;
    }
    requests.push({ path: req.url ?? '', cookie: req.headers.cookie });
    const answer = serve(() => origin, req);
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server has no port');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    reports: done,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// --- the probe ---------------------------------------------------------------

/** The probe extension, carrying the build's page-meta.js, pointed at `origin`. */
export async function stageProbe(target: string, build: string, origin: string): Promise<string> {
  await mkdir(target, { recursive: true });
  await cp(join(PROBE_SOURCE, 'manifest.json'), join(target, 'manifest.json'));
  const background = await readFile(join(PROBE_SOURCE, 'background.js'), 'utf8');
  await writeFile(
    join(target, 'background.js'),
    background.replaceAll('__FIXTURE_ORIGIN__', origin),
  );
  await cp(join(build, 'page-meta.js'), join(target, 'page-meta.js'));
  return target;
}

// --- Firefox and Marionette --------------------------------------------------

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('no free port');
  return address.port;
}

async function connectWhenListening(port: number, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => resolve(socket));
        socket.once('error', reject);
      });
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`Marionette never listened on ${port}: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

// Marionette's wire format: `<length>:<json>`, a command `[0, id, name, params]`,
// its answer `[1, id, error, result]`.
class Marionette {
  private buffer = '';
  private nextId = 0;
  private readonly waiting = new Map<number, (message: unknown[]) => void>();

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const colon = this.buffer.indexOf(':');
        if (colon === -1) return;
        const length = Number(this.buffer.slice(0, colon));
        if (this.buffer.length < colon + 1 + length) return;
        const message = JSON.parse(this.buffer.slice(colon + 1, colon + 1 + length)) as unknown;
        this.buffer = this.buffer.slice(colon + 1 + length);
        if (Array.isArray(message)) {
          this.waiting.get(message[1] as number)?.(message);
          this.waiting.delete(message[1] as number);
        }
      }
    });
  }

  async send(name: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    const payload = JSON.stringify([0, id, name, params]);
    const answer = new Promise<unknown[]>((resolve) => this.waiting.set(id, resolve));
    this.socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    const [, , error, result] = await answer;
    if (error) throw new Error(`Marionette ${name}: ${JSON.stringify(error)}`);
    return result;
  }

  close(): void {
    this.socket.destroy();
  }
}

export interface FirefoxSession {
  version: string;
  installTemporaryAddon(path: string): Promise<void>;
  close(): Promise<void>;
}

export async function launchFirefox(profile: string): Promise<FirefoxSession> {
  const executable = firefox.executablePath();
  const port = await freePort();
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'user.js'),
    [
      `user_pref("marionette.port", ${port});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    ].join('\n'),
  );
  const child: ChildProcess = spawn(
    executable,
    ['-headless', '-marionette', '-no-remote', '-profile', profile],
    { stdio: 'ignore' },
  );
  const marionette = new Marionette(await connectWhenListening(port, 30_000));
  // Marionette's greeting arrives first; a session must exist before any command.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const session = (await marionette.send('WebDriver:NewSession', { capabilities: {} })) as {
    capabilities?: { browserVersion?: string };
  };
  return {
    version: session.capabilities?.browserVersion ?? 'unknown',
    async installTemporaryAddon(path) {
      await marionette.send('Addon:Install', { path, temporary: true });
    },
    async close() {
      marionette.close();
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}
