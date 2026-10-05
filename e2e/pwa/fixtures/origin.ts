import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

// The web origin for the PWA cases: bracemark-web's static export, served by the
// spec itself so the spec can take it away. "The origin is unavailable" has to
// be a refused connection the case can cause and undo between two steps, which
// a server the runner or a developer started cannot give it.
//
// It does what `nx start` (`serve out`) does for this export and nothing more —
// the file, else `<path>.html`, else `<path>/index.html`, else the exported
// 404 — because that is all a static host does for it: the clean-URL rewrite
// in production is the same mapping (docs/hosting.md, _clean URLs_). No
// security headers, exactly like `nx start`; the CSP is not what these cases
// are about.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticOrigin {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Every status this origin has answered `pathname` with, oldest first. The one
  // view of a service worker's INSTALL a case has that is not a race: the worker
  // fetches its precache from here, so a 404 in this list is a failed install
  // that has happened, whichever check — the browser's own or the case's —
  // started it.
  answered(pathname: string): number[];
  // How the origin behaves while it is up. `stall` accepts every connection and
  // never answers — the network that is neither down nor working, which a refused
  // connection (`stop`) cannot stand in for: a refusal fails at once, a stall
  // leaves the browser waiting. A number answers every request with that status.
  respond(mode: OriginMode): void;
}

export type OriginMode = 'serve' | 'stall' | number;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolve(root: string, pathname: string): Promise<string | null> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  const base = join(root, relative);
  // Nothing outside the export, whatever the path says.
  if (base !== root && !base.startsWith(root + sep)) return null;
  const candidates = pathname.endsWith('/')
    ? [join(base, 'index.html')]
    : [base, `${base}.html`, join(base, 'index.html')];
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return null;
}

export function staticOrigin(root: string, origin: string): StaticOrigin {
  const port = Number(new URL(origin).port);
  let server: Server | undefined;
  const log: Array<{ pathname: string; status: number }> = [];
  let mode: OriginMode = 'serve';

  return {
    respond: (next) => {
      mode = next;
    },
    answered: (pathname) =>
      log.filter((entry) => entry.pathname === pathname).map((entry) => entry.status),
    async start() {
      if (server) return;
      const next = createServer((request, response) => {
        void (async () => {
          const { pathname } = new URL(request.url ?? '/', origin);
          // Held open until `stop()` closes the socket.
          if (mode === 'stall') return;
          if (typeof mode === 'number') {
            log.push({ pathname, status: mode });
            response.writeHead(mode, { 'content-type': 'text/plain', 'cache-control': 'no-cache' });
            response.end(`origin answering ${mode}`);
            return;
          }
          const file = await resolve(root, pathname);
          const path = file ?? join(root, '404.html');
          log.push({ pathname, status: file ? 200 : 404 });
          response.writeHead(file ? 200 : 404, {
            'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
            // Every response revalidates, so the service worker — not an HTTP
            // cache — is the only thing that can answer once the origin is gone.
            'cache-control': 'no-cache',
          });
          response.end(await readFile(path));
        })().catch((error: unknown) => {
          response.writeHead(500);
          response.end(String(error));
        });
      });
      await new Promise<void>((resolveListen, reject) => {
        next.once('error', reject);
        next.listen(port, () => resolveListen());
      });
      server = next;
    },
    async stop() {
      const current = server;
      if (!current) return;
      server = undefined;
      // Refuse from now on — including the keep-alive sockets a browser holds.
      const closed = new Promise<void>((resolveClose) => current.close(() => resolveClose()));
      current.closeAllConnections();
      await closed;
    },
  };
}
