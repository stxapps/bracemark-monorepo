import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where an e2e run writes, resolved once from THIS file's own location.
//
// Derived from `import.meta.url` rather than from Playwright's
// `testInfo.config.rootDir`, and that is the whole point: `rootDir` is computed
// from `testDir` (`./web`), NOT from the directory holding playwright.config.ts.
// Passing it here put the per-worker browser profiles under `e2e/web/.artifacts/`,
// one level below the `/e2e/.artifacts/` line in .gitignore — an anchored pattern
// that does not match a nested copy. A profile holds a live session for a throwaway
// account, so the failure mode was a real session sitting untracked in
// `git status`, with nothing but a human's eye between it and a public repo.
// `outputDir` and the html reporter resolve relative to the config FILE and were
// always right, which is what made the split easy to miss.
export const E2E_ROOT = dirname(fileURLToPath(import.meta.url));
export const ARTIFACTS = join(E2E_ROOT, '.artifacts');

// A persistent Chrome profile for `launchApp` (web/fixtures/launch.ts). Every
// caller that needs one comes through here, so there is exactly one answer to where
// profiles live. The name namespaces the caller: `w0`/`w1` per Playwright worker,
// `signout-w0` for the spec that must not share the worker's session, `contract-*`
// and `provision-*` for the runners.
export function profileDir(name: string): string {
  return join(ARTIFACTS, 'profiles', name);
}

// Where the seed writes (docs/e2e.md, _seeding a dev account_). Two directories,
// and the split is deliberate.
//
// The generated backup archives are RUN OUTPUT — regenerated from seed/library.ts
// on every seed, disposable, and covered by the `/e2e/.artifacts/` line the
// profiles and traces already sit behind.
export const SEED_ARCHIVES = join(ARTIFACTS, 'seed');

// Where the published screenshots land (seed/shot/) — one PNG per scene. Run
// output like the archives — regenerate it by re-running the capture — and it
// belongs under `.artifacts` rather than beside the site's `public/screenshots/`
// for the same reason: what this writes is the raw device-pixel capture, and what
// a consumer ships is derived from it (the site's three `.webp` variants, via
// `tools/scripts/make-image-variants.sh`; the PWA screenshots, placed and stamped
// by the compositor). Only the derived files are committed, and putting the
// source here keeps the unoptimized original from being the one someone points an
// <img> at.
export const SHOT_OUTPUT = join(ARTIFACTS, 'shot');

// The credentials are NOT run output. They are working sign-ins for accounts that
// outlive the run that made them — the whole point is to open a browser tomorrow
// and use them — so clearing `.artifacts` to reclaim disk (or to unstick a
// Playwright report) must not take them with it. They get their own anchored
// .gitignore line for the same reason the archives don't need one: a file here is
// a password in plain text, and it must never be one `rm -rf .artifacts` away from
// being silently re-created empty.
export const SEED_CREDENTIALS = join(E2E_ROOT, 'credentials');
