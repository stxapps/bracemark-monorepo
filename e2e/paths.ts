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

// Every real test invocation gets one collision-free directory under `runs/`.
// The wrapper that owns the invocation sets E2E_RUN_ID before Playwright workers
// or account-provisioning helpers are spawned, so every process agrees on the
// same location. Utilities that are not test runs (seed/ and shot/) deliberately
// keep their dedicated paths below.
export function runArtifactDir(runId: string): string {
  return join(ARTIFACTS, 'runs', runId);
}

// What a visual run photographed, and the report comparing it (docs/e2e.md,
// _visual checkpoints_). Inside the run directory like every other result.
export function visualRunDir(runDir: string): string {
  return join(runDir, 'visual');
}

// The accepted screenshots a visual run is compared against, one directory per
// device profile. Under `.artifacts` — gitignored and machine-local — because a
// raster is a fact about this machine's browser, simulator and fonts as much as
// about the app; `--accept` is the only thing that writes here. Clearing
// `.artifacts` clears them, and the next run reports every checkpoint `new`.
export const VISUAL_BASELINES = join(ARTIFACTS, 'visual', 'baselines');

// A persistent Chrome profile for `launchApp` (web/fixtures/launch.ts). Every
// caller that needs one comes through here, so there is exactly one answer to where
// profiles live. The name namespaces the caller: `w0`/`w1` per Playwright worker,
// `signout-w0` for the spec that must not share the worker's session, `contract-*`
// and `provision-*` for the runners.
export function profileDir(name: string): string {
  const runId = process.env.E2E_RUN_ID;
  return runId ? join(runArtifactDir(runId), 'profiles', name) : join(ARTIFACTS, 'profiles', name);
}

// Where the seed writes (docs/e2e.md, _seeding a dev account_). Two directories,
// and the split is deliberate.
//
// The generated backup archives are RUN OUTPUT — regenerated from seed/library.ts
// on every seed, disposable, and covered by the `/e2e/.artifacts/` line the
// profiles and traces already sit behind. FOUR files, one per dev account with a
// library; the shot account's archive is not among them (SHOT_ARCHIVE, below).
export const SEED_ARCHIVES = join(ARTIFACTS, 'seed');

// Where the published screenshots land (shot/) — one PNG per scene. Run
// output like the archives — regenerate it by re-running the capture — and it
// belongs under `.artifacts` rather than beside the site's `public/screenshots/`
// for the same reason: what this writes is the raw device-pixel capture, and what
// a consumer ships is derived from it (the site's three `.webp` variants, via
// `tools/scripts/make-image-variants.sh`; the PWA screenshots, placed and stamped
// by the compositor). Only the derived files are committed, and putting the
// source here keeps the unoptimized original from being the one someone points an
// <img> at.
export const SHOT_OUTPUT = join(ARTIFACTS, 'shot');

// Where the data-path measurement writes (measure/data.ts): one directory per
// run, holding its fixtures, the staged export, the results and any traces. Run
// output like the rest — a finished run's numbers belong in
// docs/data-lifecycle.md, not in a file here that the next `rm -rf .artifacts`
// takes with it.
export const MEASURE_OUTPUT = join(ARTIFACTS, 'measure');

// The shot account's backup archive — one FILE, not a directory, because there is
// one fixture and `shot/account.ts` rebuilds it on every run.
//
// It sits under `SHOT_OUTPUT` rather than with the four dev-account zips in
// `SEED_ARCHIVES`, and the reason is whose fixture it is: those four are
// `seed/library.ts`'s and are read by `seed:accounts`, this one is
// `shot/library.ts`'s and is read by `shot:account`. They share a format and
// nothing else, and it lived in the wrong directory only because the shot legs
// used to live under `seed/`. `.artifacts/shot/` already holds more than the PNGs
// — the Maestro run directories and the staged extension are both here — so what
// this directory means is "what a shot leg wrote", which is exactly right for it.
export const SHOT_ARCHIVE = join(SHOT_OUTPUT, 'library.zip');

// The unpacked browser-extension build the popup captures are taken against, with
// `tabs` added to its manifest (shot/extension.ts says why). A COPY, rebuilt every
// run, and named here for the same reason everything else is: `.artifacts` has one
// source of truth, and a path composed at the call site is how a write lands
// outside the gitignore line (see the note at the top of this file).
export const SHOT_STAGED_EXTENSION = join(SHOT_OUTPUT, 'extension-staged');

// The credentials are NOT run output. They are working sign-ins for accounts that
// outlive the run that made them — the whole point is to open a browser tomorrow
// and use them — so clearing `.artifacts` to reclaim disk (or to unstick a
// Playwright report) must not take them with it. They get their own anchored
// .gitignore line for the same reason the archives don't need one: a file here is
// a password in plain text, and it must never be one `rm -rf .artifacts` away from
// being silently re-created empty.
export const SEED_CREDENTIALS = join(E2E_ROOT, 'credentials');
