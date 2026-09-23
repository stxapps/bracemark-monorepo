import { randomBytes } from 'node:crypto';

// The two generators every e2e run uses to make the artefacts it asserts on.
//
// They live apart from fixtures/app.ts on purpose. app.ts calls `base.extend` at
// module scope, so importing it pulls the Playwright test runner into the importer
// — fine for a spec, wrong for the tsx orchestrators in ../../runner/, which run
// outside Playwright entirely. When these lived in app.ts the runners could not
// reach `unresolvableUrl` and hand-rolled its exact output three times instead.
// Nothing here may import '@playwright/test'.

// Namespace anything a spec creates. Tests in a worker share an account, so two
// specs both adding a list called "Reading" would each pass alone and collide in a
// full run — the same shape of failure Maestro's `launchApp`-resumes gotcha
// produces on the native side (docs/app-drivers.md).
export function unique(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

// A URL that is guaranteed not to resolve, so bracemark-extractor's fetch fails and
// the link keeps its URL fallback in the list instead of acquiring a title.
//
// This is not laziness — it is forced. The extractor's SSRF guard blocks
// `localhost`, `*.localhost`, `.local` and every private/loopback IP, and states
// outright that it allowlists nothing (apps/bracemark-extractor/src/lib/ssrf.ts).
// A local fixture server is therefore unreachable BY DESIGN, and weakening that
// guard to serve a test would be trading the app's real security boundary for
// convenience. `.invalid` is the reserved TLD for exactly this.
//
// So: e2e asserts on what the user TYPED, never on what was extracted. The one
// exception is the `internet` extraction cases, which take their public URLs from
// ./extraction instead; see docs/e2e.md, "what e2e may not assert".
export function unresolvableUrl(path: string): string {
  return `https://${unique('e2e')}.invalid/${path}`;
}
