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
