// Where the golden backup archives are, and what their sidecar holds — the two
// facts the other packages need in order to read fixtures they cannot own.
//
// The BYTES stay in `data/__fixtures__`, beside the format they encode and
// beside `data/backup-fixtures.spec.ts`, the keeper that holds them to
// BRACEMARK_BACKUP_VERSION. What lives here is only their ADDRESS. Both
// platforms' `data/export-import.spec.ts` read them — that each platform reads
// what the OTHER wrote is the one claim neither package can make alone, since
// @nx/enforce-module-boundaries forbids a spec that imports both (docs/testing.md,
// _the export/import orchestrators_) — and they used to reach them by counting
// directories: `join(__dirname, '..', '..', '..', 'shared', 'src', 'data',
// '__fixtures__')`. That string crosses a package boundary where nothing can see
// it: not the boundary lint rule, which reads imports, not the typechecker, and
// not the module graph. Moving this package would leave both specs pointing at
// nothing, and the failure would arrive as a missing file in two suites rather
// than as anything naming the cause.
//
// SPEC-ONLY, and that is load-bearing rather than tidy. This module reaches for
// `node:fs` and `__dirname`, and `shared` is platform:agnostic — the same source
// runs on browsers, on workerd and on Hermes, none of which have either. So it
// sits outside the shipped program on three counts, the same way
// expo-react/src/testing does: excluded from tsconfig.lib.json, exempt from the
// agnostic-globals deny list (tools/eslint/agnostic-globals.mjs), and reachable
// only through the `./testing` subpath export — never from this package's index,
// which every app DOES bundle.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The archives, by container. One layout, written twice: zip.js on web,
 * fflate on expo (zip.js is not portable to Hermes). Both platforms' specs
 * import BOTH — the foreign one for the cross-platform claim, their own as the
 * regression guard for their own zip library across an upgrade.
 */
export const BACKUP_FIXTURE_ARCHIVES = ['backup-web.zip', 'backup-expo.zip'] as const;

export type BackupFixtureArchive = (typeof BACKUP_FIXTURE_ARCHIVES)[number];

/** What `backup-contents.json` carries: the entity set both archives encode. */
export interface BackupFixtureContents {
  version: number;
  entryNames: string[];
  manifest: unknown;
  entities: { path: string; data: Record<string, unknown> }[];
  files: { id: string; bytes: number[] }[];
}

/** The directory `tools/scripts/generate-backup-fixtures.ts` writes into. */
export const BACKUP_FIXTURES_DIR = join(__dirname, '..', 'data', '__fixtures__');

/**
 * One archive's raw bytes, exactly as the generator wrote them.
 *
 * `Buffer<ArrayBuffer>`, not a bare `Buffer`: the default parameter is
 * `ArrayBufferLike`, which includes `SharedArrayBuffer` and so is not a
 * `BlobPart` — web-react wraps this in a `File` and would be told to copy the
 * bytes for no reason. This is what `readFileSync` already returns.
 */
export const readBackupFixture = (name: BackupFixtureArchive): Buffer<ArrayBuffer> =>
  readFileSync(join(BACKUP_FIXTURES_DIR, name));

/**
 * The sidecar. Read afresh per call rather than cached at module load: jest
 * resets the module registry between files, and a fixture regenerated mid-run
 * should not be half-observed.
 */
export const readBackupFixtureContents = (): BackupFixtureContents =>
  JSON.parse(
    readFileSync(join(BACKUP_FIXTURES_DIR, 'backup-contents.json'), 'utf8'),
  ) as BackupFixtureContents;
