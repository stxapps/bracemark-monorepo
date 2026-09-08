import {
  type BackupFixtureContents,
  readBackupFixture,
  readBackupFixtureContents,
} from '../testing/backup-fixtures';
import {
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  backupFileEntry,
  BRACEMARK_BACKUP_VERSION,
  type BundleEntry,
  classifyBundleLine,
  jsonlLine,
  parseBackupManifest,
  referencedFileIds,
} from './backup';

// The golden backups' keeper. `__fixtures__/backup-web.zip` (zip.js) and
// `backup-expo.zip` (fflate) are the cross-platform half of this format's claim:
// each platform's own spec proves it reads what IT wrote, and only these prove
// each reads what the OTHER wrote — a thing no single spec can assert, since
// web-react and expo-react may not import each other. They are generated
// (tools/scripts/generate-backup-fixtures.ts) and read by both platforms'
// data/export-import.spec.ts.
//
// This file is what stands between them and staleness, and it runs HERE, in the
// package that owns the format, so a version bump or a schema change fails in
// the file that made it rather than in two suites most changes never run.
// It deliberately does NOT unzip: `shared` has no zip dependency and should not
// grow one for a test. The container is the platforms' business; the CONTENTS
// are this package's, and that is exactly the line drawn below.
//
// The paths and the sidecar's shape come from `testing/backup-fixtures.ts`, which
// is also what the two platform specs read them through — one address for an
// artifact three suites depend on.
const contents: BackupFixtureContents = readBackupFixtureContents();

describe('the golden backup fixtures', () => {
  // The tripwire this whole apparatus exists for: BRACEMARK_BACKUP_VERSION moving
  // without the archives moving with it. A bump that lands on web alone produces
  // archives expo ACCEPTS and misreads — the failure is silent on both sides, and
  // this is the one place it can be made loud.
  it('were written at the version this app currently speaks', () => {
    expect(contents.version).toBe(BRACEMARK_BACKUP_VERSION);
  });

  // The sidecar's manifest is what the platform specs compare their own export's
  // manifest against, so it has to be a manifest this app's own reader accepts —
  // not merely JSON that looks like one.
  it('carry a manifest the reader accepts', () => {
    expect(() => parseBackupManifest(JSON.stringify(contents.manifest))).not.toThrow();
  });

  // Both archives hold the same three entries under the same names. A rename on
  // one side is exactly the kind of drift the fixtures are here to catch, and the
  // names come from this module rather than from a string in the generator.
  it('name the fixed entries and one blob', () => {
    expect(contents.entryNames).toEqual([
      BACKUP_MANIFEST_ENTRY,
      BACKUP_ITEMS_ENTRY,
      backupFileEntry(contents.files[0].id),
    ]);
  });

  // Every entity in the sidecar has to survive the writer→reader pair this
  // package owns. A fixture holding a row the schema gate now rejects would make
  // both platform specs fail with an invalid-line count, pointing at the
  // importers rather than at the stale fixture.
  it('hold entities that round-trip through the line writer and the classifier', () => {
    const classified = contents.entities.map(({ path, data }) =>
      classifyBundleLine(jsonlLine(path, data)),
    );
    expect(classified.every((entry) => entry !== undefined)).toBe(true);
    expect(classified.map((entry) => entry?.path)).toEqual(
      contents.entities.map(({ path }) => path),
    );
  });

  // The blob the archives carry is the one the entities actually reference — a
  // fixture whose `files/` entry nothing points at would be dropped by both
  // importers as an orphan, and the "blob bytes survived" assertion on each
  // platform would pass by never running.
  it('reference exactly the blob they ship', () => {
    const entries = contents.entities
      .map(({ path, data }) => classifyBundleLine(jsonlLine(path, data)))
      .filter((entry): entry is BundleEntry => entry !== undefined);
    expect([...referencedFileIds(entries)]).toEqual(contents.files.map(({ id }) => id));
  });

  // The two archives are not interchangeable byte-for-byte and are not meant to
  // be — different containers, different compression, different local headers.
  // Pinned so a generator that quietly wrote the same zip twice (an easy edit to
  // make) can't leave the cross-container claim testing nothing.
  it('are two genuinely different containers', () => {
    const web = readBackupFixture('backup-web.zip');
    const expo = readBackupFixture('backup-expo.zip');
    expect(web.subarray(0, 4)).toEqual(expo.subarray(0, 4)); // both are zips
    expect(web.equals(expo)).toBe(false);
  });
});
