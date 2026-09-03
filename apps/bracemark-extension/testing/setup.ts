import { TextDecoder, TextEncoder } from 'node:util';

import { installFakeBrowser } from './fake-browser';

// jsdom ships neither `TextEncoder` nor `TextDecoder`, which every browser has had
// for a decade — and `@stxapps/shared`'s `utf8()` is on the path of both file-bytes
// captures (read mode and page copy). Node's are the same implementation the
// platform exposes, so this restores the environment rather than faking anything.
// (The other jsdom projects here don't hit it: web-react's specs run on `node`,
// which already has both.)
Object.assign(globalThis, { TextEncoder, TextDecoder });

// The two WXT auto-imports the source uses as bare globals. WXT's vite plugin
// rewrites them into real imports at build time; nothing does that under jest, so
// they have to exist on `globalThis` before the first module evaluates.
//
// `browser` is re-installed FRESH per test — the fake's storage and its listener
// sets are real state, and leaking either across tests would let one spec read the
// previous one's sync mirror. A spec that needs the fake's extras (`peek`,
// `dispatch`, the captured message listener) calls `installFakeBrowser()` itself in
// its own `beforeEach` and keeps the handle; this one only guarantees the global is
// never missing or stale.
//
// `defineBackground` is re-declared rather than imported from
// `wxt/utils/define-background`: that module ships as ESM only, and whitelisting
// `wxt` in jest.esm-packages.cjs would spend a transform across all 12 jest
// projects for two lines. Keep the shape in step with wxt's — a function argument
// becomes `{ main }`, anything else passes through.
// Installed at module scope as well as per test: an entrypoint runs `defineBackground`
// at IMPORT time, which is before any `beforeEach` has fired.
(globalThis as { defineBackground?: unknown }).defineBackground = (arg: unknown) =>
  arg == null || typeof arg === 'function' ? { main: arg } : arg;
installFakeBrowser();

beforeEach(() => {
  installFakeBrowser();
});
