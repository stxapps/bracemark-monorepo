// The favicon cache's read/write helpers — the expo sibling of web-react's
// data/favicon-store.ts (that header is canonical: the per-HOST store, the
// `none` retry TTL rationale, why `ok` rows never expire). Single-responsibility
// like the other stores; the read half the UI observes is use-favicon-uri.ts.
//
// TWO FILLERS, not web's one — the divergence the write helpers below are built
// around. favicon-provider.tsx GUESSES `https://{host}/favicon.ico`, and
// lib/device-extraction.ts CAPTURES the `<link rel=icon>` a page it was already
// fetching declared. Neither is a superset: only the guess can serve a host this
// device never extracts a page for (synced/imported links, links settled
// `permanent`, a settled library being scrolled), and only the capture can serve
// a host that ships no `/favicon.ico` at all. They don't coordinate, so the
// ordering rule lives here, in `putFaviconNone` — see its header.
//
// SPLIT STORAGE, unlike web's bytes-in-the-row: the sqlite row keeps only the
// VERDICT (`ok`/`none` + fetchedAt — the `none` half can't be a file, and
// staleness lives with it), while an `ok` icon's bytes live as a plaintext
// file on disk, `file-store.ts`-style. That's for the render path: rows are
// FlashList-recycled, so a scroll through thousands of links (re)mounts icons
// constantly, and a derived `file://` uri costs nothing per mount — where row
// bytes would cost a BLOB read + a base64 data uri re-encoded and shipped to
// native (and cached under that multi-KB string as its key) every time. The
// fetch still passes bytes through JS once per host — the renderability verdict
// (`@stxapps/shared`'s `isRenderableIconBytes`) needs them before anything is
// cached — which is the cheap side of that trade.
//
// Crash consistency, the loadEntityContent ordering transposed: putFavicon
// writes the FILE first, the row last, and readFavicon treats an `ok` row
// whose file is missing as unresolved — so a half-written pair reads as "never
// fetched" (→ re-fetch), never as a broken icon. Locations are DERIVED from
// the host, never persisted (file-store.ts: iOS moves the app container).

import { eq } from 'drizzle-orm';
import { Directory, File, Paths } from 'expo-file-system';

import { favicons, getDb } from './db';

export type FaviconRecord = typeof favicons.$inferSelect;

// How long a `none` row (no reachable favicon) stands before another attempt is
// allowed — web favicon-store's value and rationale, verbatim.
export const FAVICON_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

// Icons live beside (not inside) the `files/` content dir — different
// lifecycle owners: bracemark-files is the sync engine's materialization,
// this is the favicon cache's. Same document-storage choice (survives
// relaunches; the cache dir's OS purge would silently break the rows'
// "already fetched" bookkeeping).
const FAVICON_FILES_DIR = 'bracemark-favicons';

function faviconFilesDir(): Directory {
  return new Directory(Paths.document, FAVICON_FILES_DIR);
}

// The on-disk location for a host's icon. Hosts are near-filename-safe
// already; encodeURIComponent keeps the mapping bijective for the rest (a
// port's `:`, any odd unicode) — the file-store separator-encoding move.
export function faviconFileFor(host: string): File {
  return new File(faviconFilesDir(), encodeURIComponent(host));
}

// One host's cached row, or undefined if this host was never resolved (an
// exact primary-key get — no scan). An `ok` row whose file is gone (crash
// between the file write and the row write can't cause this — the row lands
// last — but an OS-level loss can) reads as unresolved, so the provider
// re-fetches instead of the UI trusting a verdict with no bytes behind it.
export async function readFavicon(host: string): Promise<FaviconRecord | undefined> {
  const row = getDb().select().from(favicons).where(eq(favicons.host, host)).get();
  if (row?.status === 'ok' && !faviconFileFor(host).exists) return undefined;
  return row;
}

// Is there nothing usable for this host right now? True when the host is
// unknown, or when its `none` verdict has aged past FAVICON_RETRY_MS. The
// provider's fetch gate and the hook's request trigger share this so they can't
// disagree about what counts as a miss.
export function isFaviconStale(record: FaviconRecord | undefined, now = Date.now()): boolean {
  if (!record) return true;
  if (record.status === 'ok') return false;
  return now - record.fetchedAt >= FAVICON_RETRY_MS;
}

// File first, row last — see the header's crash-consistency note.
export async function putFavicon(host: string, bytes: Uint8Array): Promise<void> {
  const dir = faviconFilesDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  faviconFileFor(host).write(bytes);
  const row = { host, status: 'ok' as const, fetchedAt: Date.now() };
  getDb()
    .insert(favicons)
    .values(row)
    .onConflictDoUpdate({ target: favicons.host, set: row })
    .run();
}

// Record "this host has no reachable favicon" so a relaunch doesn't re-buy the
// fetch. Drops any previous icon file so the pair can't disagree.
//
// NEVER DOWNGRADES AN `ok` ROW. This store has TWO fillers on expo (unlike web,
// where the provider is the only writer): the provider's `/favicon.ico` guess
// and device-extraction's declared-icon capture. Both are check-then-act with an
// await gap, so a guess that started before a capture can finish after it — and
// without this guard it would delete the captured bytes and stamp `none`, which
// `isFaviconStale` then honors for FAVICON_RETRY_MS. The rule that makes two
// unsynchronized fillers safe is: `ok` wins, `none` is only ever the floor, so
// whichever path first lands real bytes keeps them. The read + verdict + write
// below run with NO `await` between them, so no other filler can interleave.
export async function putFaviconNone(host: string): Promise<void> {
  const file = faviconFileFor(host);
  const existing = getDb().select().from(favicons).where(eq(favicons.host, host)).get();
  // `readFavicon`'s file check, inlined to keep the sequence synchronous: an `ok`
  // row with bytes behind it outranks this miss.
  if (existing?.status === 'ok' && file.exists) return;

  if (file.exists) file.delete();
  const row = { host, status: 'none' as const, fetchedAt: Date.now() };
  getDb()
    .insert(favicons)
    .values(row)
    .onConflictDoUpdate({ target: favicons.host, set: row })
    .run();
}

// Remove every cached icon file — the file-system half of the `favicons` table
// wipe (clear-data, delete-all-data), mirroring clearDataFiles: tables first,
// so a crash in between leaves orphan files no row points at, invisible to the
// app and removed by the next wipe or overwrite.
export function clearFaviconFiles(): void {
  const dir = faviconFilesDir();
  if (dir.exists) dir.delete();
}
