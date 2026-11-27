// The favicon cache's read/write helpers — the expo sibling of web-react's
// data/favicon-store.ts (that header is canonical: the per-HOST store, the
// `none` retry TTL rationale, why `ok` rows never expire). Single-responsibility
// like the other stores; the read half the UI observes is use-favicon-uri.ts.
//
// TWO FILLERS, not web's one — the divergence the write helpers below are built
// around. favicon-provider.tsx GUESSES `https://{host}/favicon.ico`, and
// lib/device-link-previews.ts CAPTURES the `<link rel=icon>` a page it was already
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
//
// BOTH WRITES ARE FENCED ON THE ACCOUNT (sync-store.ts, AccountFencedError),
// though the table has no owner column and an icon is public. What a row says is
// that somebody on this device saved a link to that host, and both fillers write
// after a network round trip — long enough for a sign-out to have wiped the
// store underneath them. Unfenced, a fetch that was in flight then wrote the
// signed-out account's host back into the empty store, file and all, where
// clearData had already been and would not come again. The check sits inside
// the write's own transaction, ahead of the file, as data/mutations.ts's
// writeFile has it.
//
// ICONS CACHED BEFORE THE SIZE CHECK are re-checked ONCE PER INSTALL, every icon file
// on disk, before any icon is handed out (`whenCachedFaviconsChecked`). Both fillers gate on the decode ceiling
// since 2026-11-26 (`@stxapps/shared` extract/favicon.ts), but an `ok` row never
// expires, and an oversized icon stored before then would keep its full-size decode
// on iOS for good. Web re-checks on every read, because there the bytes are in the
// row; here they are a file, and reading every icon file on every mount is the cost
// split storage exists to avoid. docs/link-extraction-favicons.md, _what counts as
// an icon_.

import { and, eq, inArray } from 'drizzle-orm';
import { Directory, File, Paths } from 'expo-file-system';

import { chunk, isOversizedRasterIcon } from '@stxapps/shared';

import { favicons, getDb } from './db';
import { assertAccountOwnsStoreTx } from './sync-store';

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
  await whenCachedFaviconsChecked();
  const row = getDb().select().from(favicons).where(eq(favicons.host, host)).get();
  if (row?.status === 'ok' && !faviconFileFor(host).exists) return undefined;
  return row;
}

// Many hosts' rows at once — readFavicon's answer for each, the same `ok`-
// without-a-file resolution included, in one statement per FAVICON_BATCH hosts.
// The batch the row favicon cache reads (hooks/use-favicon-uri.ts,
// data/keyed-live-cache.ts). Answers every host it is given, in order.
const FAVICON_BATCH = 500;

export async function readFavicons(
  hosts: readonly string[],
): Promise<Map<string, FaviconRecord | undefined>> {
  await whenCachedFaviconsChecked();
  const rows = new Map<string, FaviconRecord>();
  for (const batch of chunk([...hosts], FAVICON_BATCH)) {
    for (const row of getDb().select().from(favicons).where(inArray(favicons.host, batch)).all()) {
      rows.set(row.host, row);
    }
  }
  return new Map(
    hosts.map((host) => {
      const row = rows.get(host);
      return [host, row?.status === 'ok' && !faviconFileFor(host).exists ? undefined : row];
    }),
  );
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
export async function putFavicon(username: string, host: string, bytes: Uint8Array): Promise<void> {
  const row = { host, status: 'ok' as const, fetchedAt: Date.now() };
  getDb().transaction((tx) => {
    assertAccountOwnsStoreTx(tx, username);
    const dir = faviconFilesDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    faviconFileFor(host).write(bytes);
    tx.insert(favicons).values(row).onConflictDoUpdate({ target: favicons.host, set: row }).run();
  });
}

// Record "this host has no reachable favicon" so a relaunch doesn't re-buy the
// fetch. Drops any previous icon file so the pair can't disagree.
//
// NEVER DOWNGRADES AN `ok` ROW. This store has TWO fillers on expo (unlike web,
// where the provider is the only writer): the provider's `/favicon.ico` guess
// and device-link-previews's declared-icon capture. Both are check-then-act with an
// await gap, so a guess that started before a capture can finish after it — and
// without this guard it would delete the captured bytes and stamp `none`, which
// `isFaviconStale` then honors for FAVICON_RETRY_MS. The rule that makes two
// unsynchronized fillers safe is: `ok` wins, `none` is only ever the floor, so
// whichever path first lands real bytes keeps them. The read + verdict + write
// below run with NO `await` between them, so no other filler can interleave.
export async function putFaviconNone(username: string, host: string): Promise<void> {
  getDb().transaction((tx) => {
    assertAccountOwnsStoreTx(tx, username);
    const file = faviconFileFor(host);
    const existing = tx.select().from(favicons).where(eq(favicons.host, host)).get();
    // `readFavicon`'s file check, inlined to keep the sequence synchronous: an `ok`
    // row with bytes behind it outranks this miss.
    if (existing?.status === 'ok' && file.exists) return;

    if (file.exists) file.delete();
    const row = { host, status: 'none' as const, fetchedAt: Date.now() };
    tx.insert(favicons).values(row).onConflictDoUpdate({ target: favicons.host, set: row }).run();
  });
}

// --- the one-time re-check (the header's last note) ----------------------------

// Written when the re-check has run, beside the icons' directory rather than in it, so
// that directory holds icon files only. It names nothing about the account, so a wipe
// leaves it: what it says — no icon here predates the size check — stays true when
// there are no icons. Bump the suffix to run the re-check again for a new rule.
const CHECKED_MARKER = 'bracemark-favicons.checked-1';
// Icon files read between yields to the JS thread. Each is a file read (an icon is
// ~1–2 KB, at most MAX_FAVICON_BYTES) and a header read.
const RECHECK_BATCH = 25;

let recheck: Promise<void> | undefined;
let rechecked = false;

// Resolves once no icon file on this device is past the decode ceiling: at once after
// the first complete run on this install (the marker), else when the run ends.
// readFavicon and readFavicons wait on it, so the first answer after an update already
// excludes such an icon. A run that fails resolves too, and opens the hook's on-disk
// branch for the session — icons are decoration, and the next launch runs it again,
// since the marker is written only after a complete run.
export function whenCachedFaviconsChecked(): Promise<void> {
  if (recheck === undefined) {
    if (new File(Paths.document, CHECKED_MARKER).exists) {
      rechecked = true;
      recheck = Promise.resolve();
    } else {
      recheck = recheckCachedFavicons().then(
        () => {
          rechecked = true;
        },
        () => {
          rechecked = true;
        },
      );
    }
  }
  return recheck;
}

// The same, synchronously, for a render that can't wait (hooks/use-favicon-uri.ts, which
// shows the file on disk while a verdict is in flight): false until it has run, and asking
// starts it.
export function cachedFaviconsChecked(): boolean {
  if (!rechecked) void whenCachedFaviconsChecked();
  return rechecked;
}

// Drop every icon FILE whose raster header is past the decode ceiling, with its `ok` row,
// then write the marker. It walks the directory, not the rows, because the row hook shows
// whatever file is on disk while a verdict is in flight: an orphan file with no row — left
// by a wipe killed between the table delete and clearFaviconFiles — is shown as readily as
// one with a row. A dropped host reads as never fetched, so it is asked for again and its
// answer goes through the filler's gate. A file that can't be read is dropped too: it is
// not an icon anything here can vouch for. Each file's read, verdict and delete run with
// no `await` between them, so a filler can't land fresh bytes in the middle and have them
// deleted; the yields come between files. Only a drop that itself fails withholds the
// marker, so the next launch tries again.
export async function recheckCachedFavicons(): Promise<void> {
  const dir = faviconFilesDir();
  const icons = dir.exists
    ? dir.list().filter((entry): entry is File => entry instanceof File)
    : [];
  let complete = true;
  for (const [i, batch] of chunk(icons, RECHECK_BATCH).entries()) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    for (const file of batch) {
      try {
        dropIfOversized(file);
      } catch {
        complete = false;
      }
    }
  }
  if (complete) new File(Paths.document, CHECKED_MARKER).write('');
}

// The host a file in the icon directory belongs to (faviconFileFor's encoding), or
// undefined for a name that encoding can't produce.
function hostOfFile(file: File): string | undefined {
  try {
    return decodeURIComponent(file.name);
  } catch {
    return undefined;
  }
}

function dropIfOversized(file: File): void {
  getDb().transaction((tx) => {
    // A filler or a wipe may have replaced or removed it since the listing.
    if (!file.exists) return;
    let oversized: boolean;
    try {
      oversized = isOversizedRasterIcon(file.bytesSync());
    } catch {
      oversized = true;
    }
    if (!oversized) return;
    const host = hostOfFile(file);
    file.delete();
    if (host === undefined) return;
    tx.delete(favicons)
      .where(and(eq(favicons.host, host), eq(favicons.status, 'ok')))
      .run();
  });
}

// Remove every cached icon file — the file-system half of the `favicons` table
// wipe (clear-data, delete-all-data), mirroring clearDataFiles: tables first,
// so a crash in between leaves orphan files no row points at, removed by the next
// wipe or overwrite. Not invisible: the row hook shows a file on disk while its host's
// verdict is in flight (hooks/use-favicon-uri.ts) — which is why the one-time re-check
// above walks the files, not the rows.
export function clearFaviconFiles(): void {
  const dir = faviconFilesDir();
  if (dir.exists) dir.delete();
}
