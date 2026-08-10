import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'wxt';

import { BROWSER_EXTENSION_LISTING, themeInitScript } from '@stxapps/shared';

// The shared pre-paint FOUC script. The theme's `.dark` class must be set
// SYNCHRONOUSLY before first paint, which a deferred module `main.tsx` can't do — so
// it has to be a parser-blocking classic <script> in <head>. It reads the
// `bracemark-theme` localStorage mirror that ThemeProvider keeps warm. Same single source
// bracemark-web inlines via layout.tsx.
//
// It CANNOT be inlined here, though: MV3's extension-page CSP is locked to
// `script-src 'self'` and the manifest validator rejects every escape hatch that
// would allow inline execution — 'unsafe-inline', nonces, AND sha256 hashes all fail
// to load ("Insecure CSP value"). So we emit it as a same-origin file and reference it
// with <script src> (which 'self' permits). A local extension-file fetch is instant,
// so a parser-blocking external script prevents FOUC exactly as the inline one did.
// The file is generated from themeInitScript() (not committed) so it can't drift; it
// lives in public/ because WXT serves that dir in dev and copies it to the output root
// on build — see THEME_INIT_FILENAME. Written at config load so it exists before WXT
// scans public/.
const THEME_INIT_FILENAME = 'theme-init.js';
writeFileSync(
  fileURLToPath(new URL(`./public/${THEME_INIT_FILENAME}`, import.meta.url)),
  themeInitScript(),
);

// Reference the generated theme script from every extension HTML page's <head> (rather
// than hand-copy a tag into each page's index.html and keep them in step). head-prepend
// keeps it parser-blocking and first, so it runs before anything else paints.
function themeFoucPlugin(): Plugin {
  return {
    name: 'bracemark-theme-fouc',
    transformIndexHtml() {
      return [
        { tag: 'script', attrs: { src: `/${THEME_INIT_FILENAME}` }, injectTo: 'head-prepend' },
      ];
    },
  };
}

// The extension runs the sign-in Argon2id KDF on the main thread (setArgon2Runner('main')
// in popup/main.tsx), so @stxapps/web-crypto's dynamic import of its worker path
// (./argon2-worker-client) is never taken at runtime. But Vite still statically follows that
// import and emits the worker it references as a ~103 KB chunk (hash-wasm inlined). Since
// the extension can never use it — and a cross-origin module worker is exactly what
// crashes the popup under `wxt dev` — redirect that one module to a throwing stub so the
// worker chunk is left out of the extension bundle entirely. bracemark-web keeps the real
// worker (this plugin is extension-only); the throw is dead code that just makes a
// mis-wiring loud instead of silent.
function stubArgon2WorkerPlugin(): Plugin {
  const STUB_ID = '\0bracemark-argon2-worker-stub';
  return {
    name: 'bracemark-stub-argon2-worker',
    // 'pre' so this resolveId runs before Vite's core resolver — otherwise the relative
    // specifier is resolved to an absolute path before we get a chance to redirect it.
    enforce: 'pre',
    resolveId(source) {
      return /(^|\/)argon2-worker-client(\.ts)?$/.test(source) ? STUB_ID : null;
    },
    load(id) {
      if (id !== STUB_ID) return null;
      return "export function deriveInWorker() { throw new Error('argon2 worker path is disabled in the extension (main-thread runner)'); }";
    },
  };
}

// See https://wxt.dev/api/config.html
//
// One config drives both targets: `wxt build` (Chrome) and `wxt build -b
// firefox`. WXT emits the right per-browser manifest — most notably the
// background key (`service_worker` for Chrome, `scripts` for Firefox) is
// derived from `entrypoints/background.ts`, and `icons`/`action.default_icon`
// are auto-filled from `public/icon/*.png`. We only branch on the fields that
// genuinely differ between stores.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Both neighbouring dev servers are already spoken for: bracemark-web's `npm run
  // dev` owns :3000 and bracemark-site's `npm run dev:site` owns :3001 (see each
  // app's package.json). WXT's dev server defaults to :3000, so it collides with
  // web out of the box — pin the extension's dev server to :3002, clear of both.
  //
  // Unlike the other two, this port is HMR transport ONLY and nothing consumes it:
  // extension pages load from `chrome-extension://`, and the api calls are
  // CORS-exempt via host_permissions, so :3002 is deliberately absent from
  // bracemark-api's dev CORS_ORIGINS (which lists :3000 and :3001 — the two Next dev
  // servers). That's why this is the port that moves when there's a clash.
  dev: {
    server: { port: 3002 },
  },
  // WXT defaults Firefox to MV2; pin MV3 on both to match the existing
  // extensions (Firefox MV3 keeps `background.scripts`, which WXT emits).
  manifestVersion: 3,
  manifest: ({ browser, mode }) => {
    const isFirefox = browser === 'firefox';
    // bracemark-api host the extension talks to, per build mode. Single source of
    // truth: the same WXT_PUBLIC_API_URL that utils/api-client.ts reads, loaded here at
    // config time from `.env.<mode>` (dev :8787, staging/prod custom domains).
    // `mode` is 'development' for `wxt`/`wxt dev`, 'production' for `wxt build`,
    // and 'staging' when built with `--mode staging`. In the manifest function
    // `import.meta.env` isn't the bundle env yet, so we read the file directly
    // via Vite's loadEnv; deriving the host from the URL the client uses keeps
    // the grant from ever drifting out of sync with api.ts.
    //
    // Auth is a bearer token (Authorization header) shared across web,
    // extension, and the future mobile app — NOT a cookie. In MV3, the
    // background/service-worker's fetches to a host_permissions origin are
    // EXEMPT from CORS, so the extension never appears in bracemark-api's
    // CORS_ORIGINS allow-list. The api host is per-tier (no localhost/staging in
    // the production store build). NOTE: content scripts get NO CORS exemption —
    // route their API calls through background.ts rather than fetching bracemark-api
    // directly.
    const apiUrl = loadEnv(mode, process.cwd(), 'WXT_PUBLIC_').WXT_PUBLIC_API_URL;
    if (!apiUrl) throw new Error('WXT_PUBLIC_API_URL is not set');
    // host_permissions needs a match pattern (origin + `/*`), not a bare origin.
    const apiHost = `${new URL(apiUrl).origin}/*`;
    return {
      // BOTH stores build the listing's title and summary from these manifest
      // fields, so this is store copy, not config — it lives with the rest of it
      // in shared's stores/listing-copy.ts (and is length-checked there against
      // the smaller of Chrome's and Firefox's budgets). The strings these replaced
      // were Brace.to v1's, still selling "technology that empowers you to truly
      // own your account and data" — the decentralised-identity pitch this version
      // dropped — a year after the rename, because nothing pointed here.
      name: BROWSER_EXTENSION_LISTING.name,
      description: BROWSER_EXTENSION_LISTING.description,
      // ONLY the api host — NO `<all_urls>`. A broad host grant is the one thing
      // that would unlock BACKGROUND bg-fetch extraction (the service worker
      // `fetch`ing arbitrary saved third-party URLs for their OpenGraph tags, which
      // MV3 only CORS-exempts for host_permissions origins), but it costs the
      // scariest install warning ("read and change all your data on all websites")
      // and a store-review nightmare — for the extension's WEAKEST tier. The
      // extension is deliberately ACTIVE-CONTEXT ONLY: it extracts from the focused
      // tab via `activeTab` (warning-free, highest quality), and the background
      // bg-fetch residual (cross-device pickups, bulk-import draining) is owned by
      // the deferred server path `bracemark-extractor` instead. See
      // docs/link-extraction.md "the extension is active-context only". The api host
      // stays listed so the bearer-auth calls to bracemark-api keep their CORS exemption.
      host_permissions: [apiHost],
      permissions: [
        'storage',
        // The background service worker is ephemeral in MV3 — it can't hold a
        // long-running loop — so the sync + extraction cycles are driven by a
        // periodic browser.alarms tick (see entrypoints/background.ts).
        'alarms',
        // activeTab grants temporary host access to the current tab on click,
        // covering url/title reads + captureVisibleTab on it
        'activeTab',
        // required to call scripting.executeScript (page-copy serializer
        // injection in background.ts); activeTab only grants host access
        'scripting',
      ],
      // MV3 locks the extension-page CSP to a tiny allow-list ('self', 'none',
      // 'wasm-unsafe-eval', dev-only localhost); hashes/nonces/'unsafe-inline' are all
      // rejected at load ("Insecure CSP value"). We need one addition over the
      // `script-src 'self'` default: 'wasm-unsafe-eval'. The sign-in Argon2id KDF
      // (derivePasswordKek → deriveArgon2Hash in @stxapps/web-crypto) runs via hash-wasm,
      // which WebAssembly.compile/instantiates a module — blocked by default ("Wasm code
      // generation disallowed by embedder"). The extension runs that KDF on the popup's
      // MAIN THREAD (setArgon2Runner('main') — no worker; see stubArgon2WorkerPlugin), so
      // the WASM compile happens right on the extension page and this keyword is what
      // lets it through. It permits WASM compilation only, NOT JS eval. (The theme FOUC
      // script is an external same-origin file, so plain 'self' already covers it — see
      // themeFoucPlugin.) Both Chrome and Firefox MV3 accept this, so one policy covers
      // both targets.
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
      },
      // action.default_title comes from the popup's <title> (entrypoints/popup).
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: { id: 'addon@bracemark.com', strict_min_version: '114.0' },
            },
          }
        : {
            minimum_chrome_version: '93',
          }),
    };
  },
  vite: () => ({
    plugins: [tailwindcss(), themeFoucPlugin(), stubArgon2WorkerPlugin()],
  }),
});
