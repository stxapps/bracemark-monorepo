import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type Extraction,
  EXTRACTIONS_PREFIX,
  type Link,
  LINKS_PREFIX,
  MY_LIST_ID,
  pathFromId,
} from '@stxapps/shared';

import { buildBackupArchive } from '../../seed/archive';
import { unique } from './data';

// A library HEAVY enough to fill an account's storage: `count` links, each with a
// done extraction whose preview file is `fileBytes` of incompressible bytes. The
// fixture for the one case whose subject is the server's byte ceiling
// (SYNC-BLOCKED-001) — the free plan's 100 MiB (`maxBytes`, shared iap/plans.ts).
//
// It fills the ceiling the only way a real account can: blobs a client
// encrypted and uploaded. Nothing writes the per-user size map directly, and
// nothing lowers the ceiling for a test (docs/e2e.md, _the capacity case_).
//
// The ORDER the engine pushes it in is what makes the refusal deterministic.
// Content puts (`files/`) drain before any metadata put, and the quota gate reads
// usage as it stood BEFORE each sign batch (docs/local-first-sync.md,
// _authorization & quota_). So one content chunk carries every file past the
// ceiling, and the metadata chunk behind it — these links and their
// extractions — is refused.
//
// The bytes are random rather than a real image: the gate counts stored bytes,
// not pixels, and a raster that compresses would need to be enormous to weigh
// the same. No row is ever looked at for its preview here.
//
// Writer, not oracle, as web/fixtures/library.ts argues. No Playwright import.

export interface HeavyLibrary {
  archivePath: string;
  // Newest first.
  urls: string[];
  totalBytes: number;
}

export async function writeHeavyLibrary(
  archivePath: string,
  options: { count: number; fileBytes: number; label?: string },
): Promise<HeavyLibrary> {
  const host = `${unique(options.label ?? 'e2e-heavy')}.invalid`;
  const now = Date.now();
  const urls: string[] = [];
  const items: { path: string; data: object }[] = [];
  const files: { id: string; bytes: Uint8Array }[] = [];

  for (let i = 0; i < options.count; i++) {
    const n = String(i).padStart(3, '0');
    const id = `${host.replace(/\W/g, '-')}-${n}`;
    const url = `https://${host}/row-${n}`;
    const at = now - (i + 1) * 60_000;
    const imageId = `${id}-image`;
    const link: Link = { url, listId: MY_LIST_ID, tagIds: [], createdAt: at, updatedAt: at };
    const extraction: Extraction = {
      id,
      imageId,
      facets: {
        titleImage: { status: 'done', extractedBy: 'extension:fg', extractedAt: at, attempts: 1 },
      },
      createdAt: at,
      updatedAt: at,
    };
    items.push({ path: pathFromId(id, LINKS_PREFIX), data: link });
    items.push({ path: pathFromId(id, EXTRACTIONS_PREFIX), data: extraction });
    files.push({ id: imageId, bytes: randomBytes(options.fileBytes) });
    urls.push(url);
  }

  const archive = buildBackupArchive({
    items,
    files,
    counts: {
      links: options.count,
      lists: 0,
      tags: 0,
      pins: 0,
      extractions: options.count,
      files: options.count,
    },
  });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);
  return { archivePath, urls, totalBytes: options.count * options.fileBytes };
}
