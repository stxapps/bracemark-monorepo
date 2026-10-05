// Which build is this page, and which build is the service worker that controls
// it (docs/offline-mode.md, _which build is this page_). Each `next build` stamps
// itself once (next.config.js); the stamp is in every document and in one
// precached file, and these read the two.

// `<html data-build="…">`, written by app/layout.tsx.
export const BUILD_ATTRIBUTE = 'data-build';
// The precached file, and the field in it (app/build.json/route.ts).
export const BUILD_ID_URL = '/build.json';
export const BUILD_ID_KEY = 'id';

// The build this page LOADED as — read from the document, not from a constant in
// the bundle, because the document is what decides which chunks a page runs.
//
// ⚠ Read it ONCE, at load, and keep the answer. The root layout is also in every
// route payload an in-app move fetches, and those come from whichever worker
// controls the page — so on an old page under a new worker the attribute can come
// to name the NEW build while the code running is still the old one. Asked late,
// the page would report itself up to date exactly when it is not.
export function pageBuildId(): string {
  return document.documentElement.getAttribute(BUILD_ATTRIBUTE) ?? '';
}

// The build the controlling worker holds, or null when it cannot be read. A
// same-origin GET of a precached URL, so the worker answers it from its precache
// whether or not the origin is reachable.
export async function workerBuildId(): Promise<string | null> {
  try {
    const response = await fetch(BUILD_ID_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const id = (body as Record<string, unknown> | null)?.[BUILD_ID_KEY];
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

// Whether the worker now in control holds a DIFFERENT build from `loadedAs`.
// Anything unreadable counts as different: a pill shown once too often costs a
// reload, and one withheld leaves a window on old code with nothing saying so.
export async function workerHoldsAnotherBuild(loadedAs: string): Promise<boolean> {
  if (loadedAs === '') return true;
  return (await workerBuildId()) !== loadedAs;
}
