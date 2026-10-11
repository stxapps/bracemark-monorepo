// Emits the two golden bracemark backups, one per zip container, plus the JSON
// sidecar describing what they hold:
//
//   packages/shared/src/data/__fixtures__/backup-web.zip       (@zip.js/zip.js)
//   packages/shared/src/data/__fixtures__/backup-expo.zip      (fflate)
//   packages/shared/src/data/__fixtures__/backup-contents.json (the entity set)
//
// WHY THESE EXIST. `data/backup.ts` defines one archive layout and two platforms
// write it with two different libraries — zip.js on web (streaming, zip64) and
// fflate on expo (zip32, in-memory), because zip.js is not portable to Hermes.
// Each platform's own round-trip spec proves it reads what IT wrote; nothing
// proves it reads what the OTHER one wrote, and nothing can: `web-react` and
// `expo-react` may not import each other (@nx/enforce-module-boundaries), so no
// single spec can hold both. A user with two devices is exactly the person who
// finds that out. See docs/data-lifecycle.md, _the bracemark zip is
// platform-split_.
//
// So the artifact is the contract, the same shape as
// packages/shared/src/crypto/contract-vectors.json for the crypto frame: both
// platforms' specs read BOTH zips, import them, and assert the entity set
// against the sidecar. A container quirk on either side — a directory entry a
// reader trips on, a deflate level, an entry name — fails on the platform that
// cannot read it, rather than on a device.
//
// CHECKED IN and generated, never hand-edited. Regenerate — and read
// docs/data-lifecycle.md first — when BRACEMARK_BACKUP_VERSION moves; the shared
// spec beside the fixtures fails until you do. Committing the zips takes an
// anchored negation in .gitignore, because a personal `*.zip` rule in a global
// excludesFile makes `git add` skip them without a word — docs/testing.md, _the
// golden archives_, which is also where the reason they are committed rather
// than generated per run is written down.
//
// The three suites that READ them address them through
// packages/shared/src/testing/backup-fixtures.ts (the `@stxapps/shared/testing`
// subpath), which holds the directory and the archive names as a type. A fixture
// added here that nothing there names is a fixture no spec can reach.
//
// Run `npm run fix` after regenerating: prettier reflows the sidecar's number
// arrays, so a raw run leaves `format:check` red.
//
//   npx tsx tools/scripts/generate-backup-fixtures.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BlobWriter,
  TextReader,
  Uint8ArrayReader,
  ZipWriter,
} from '@zip.js/zip.js/index-native.js';
import { zipSync } from 'fflate';

import {
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  backupFileEntry,
  BRACEMARK_BACKUP_VERSION,
  jsonlLine,
  serializeBackupItems,
  serializeBackupManifest,
  utf8,
} from '../../packages/shared/src/index';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'data',
  '__fixtures__',
);

// Deliberately small and deliberately awkward. Every value here is chosen for
// something a container or a parser can get wrong:
//   - a non-ASCII title and a non-ASCII list name (UTF-8 through two zippers)
//   - a link in Trash (the backup is the only format that carries it)
//   - a nested list (parentId survives verbatim on any plan)
//   - a blob with high bytes (a text-shaped hop would mangle it)
//   - an extraction and a pin (the two co-keyed satellites)
const T = 1_700_000_000_000;
const FILE_ID = 'img_a';

const ENTITIES = [
  {
    path: 'lists/lst_work.enc',
    data: { id: 'lst_work', name: 'Wörk', parentId: null, rank: 'a0', createdAt: T, updatedAt: T },
  },
  {
    path: 'lists/lst_specs.enc',
    data: {
      id: 'lst_specs',
      name: 'Specs',
      parentId: 'lst_work',
      rank: 'a1',
      createdAt: T,
      updatedAt: T,
    },
  },
  {
    path: 'tags/tag_read.enc',
    data: {
      id: 'tag_read',
      name: 'reading',
      parentId: null,
      rank: 'a0',
      createdAt: T,
      updatedAt: T,
    },
  },
  {
    path: 'links/lnk_a.enc',
    data: {
      url: 'https://a.invalid/spec',
      listId: 'lst_specs',
      tagIds: ['tag_read'],
      customTitle: 'Die Spezifikation — süß',
      customImageId: FILE_ID,
      createdAt: T + 2,
      updatedAt: T + 2,
    },
  },
  {
    path: 'links/lnk_b.enc',
    data: {
      url: 'https://b.invalid/gone',
      listId: 'trash',
      tagIds: [],
      createdAt: T + 1,
      updatedAt: T + 1,
    },
  },
  {
    path: 'extractions/lnk_a.enc',
    data: { id: 'lnk_a', facets: {}, title: 'A spec', createdAt: T, updatedAt: T },
  },
  { path: 'pins/lnk_a.enc', data: { id: 'lnk_a', rank: 'a0', createdAt: T, updatedAt: T } },
  {
    path: 'settings/general.enc',
    data: { linksLayout: 'list', createdAt: T, updatedAt: T },
  },
] as const;

const BLOB = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x7f,
]);

const lines = ENTITIES.map(({ path, data }) => jsonlLine(path, data));
const itemsText = serializeBackupItems(lines);
const manifestText = serializeBackupManifest({
  links: 2,
  lists: 2,
  tags: 1,
  pins: 1,
  extractions: 1,
  files: 1,
});

// --- web's container: zip.js ------------------------------------------------------

async function writeWebZip(): Promise<Uint8Array> {
  const zipWriter = new ZipWriter(new BlobWriter('application/zip'));
  await zipWriter.add(BACKUP_MANIFEST_ENTRY, new TextReader(manifestText));
  await zipWriter.add(BACKUP_ITEMS_ENTRY, new TextReader(itemsText));
  // Stored, not deflated — already-compressed media, exactly as the app does.
  await zipWriter.add(backupFileEntry(FILE_ID), new Uint8ArrayReader(BLOB), { level: 0 });
  const blob = await zipWriter.close();
  return new Uint8Array(await blob.arrayBuffer());
}

// --- expo's container: fflate -------------------------------------------------------

function writeExpoZip(): Uint8Array {
  return zipSync({
    [BACKUP_MANIFEST_ENTRY]: utf8(manifestText),
    [BACKUP_ITEMS_ENTRY]: utf8(itemsText),
    [backupFileEntry(FILE_ID)]: [BLOB, { level: 0 }],
  });
}

// --- the sidecar --------------------------------------------------------------------

const contents = {
  // The version the two archives were written at. The spec beside the fixtures
  // holds this to BRACEMARK_BACKUP_VERSION, so a bump cannot land without
  // regenerating them — which is the whole point: a version that moved on one
  // platform alone produces archives the other accepts and misreads.
  version: BRACEMARK_BACKUP_VERSION,
  entryNames: [BACKUP_MANIFEST_ENTRY, BACKUP_ITEMS_ENTRY, backupFileEntry(FILE_ID)],
  manifest: JSON.parse(manifestText) as unknown,
  entities: ENTITIES.map(({ path, data }) => ({ path, data })),
  files: [{ id: FILE_ID, bytes: [...BLOB] }],
};

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'backup-web.zip'), await writeWebZip());
  writeFileSync(join(OUT, 'backup-expo.zip'), writeExpoZip());
  writeFileSync(join(OUT, 'backup-contents.json'), `${JSON.stringify(contents, null, 2)}\n`);
  console.log(`wrote 3 fixtures to ${OUT}`);
}

void main();
