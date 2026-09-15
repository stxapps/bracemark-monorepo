import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SEED_ARCHIVES } from '../paths';
import { buildBackupArchive } from './archive';
import { SEED_USERS, type SeedUser } from './catalog';
import { buildLibrary } from './library';

// THE ARCHIVES — the backup zips both seeds import, written from `./library.ts`
// and `./archive.ts`, touching neither a browser nor the api.
//
// The file is named for its target (`seed:fixtures`) and the function for what it
// does, which is the split worth keeping: `fixtures.ts` is where you go from the
// command, `generateArchives()` is what a caller reads. Note that "fixtures" means
// something else one directory over — `web/fixtures/` holds Playwright fixtures —
// and that overload lives in the target name already.
//
// Run it alone (`npm run seed:fixtures`) when you want to look at what is about to
// be imported, or to import one by hand into an account you already have —
// picking the file in Settings → Data → Import is exactly what accounts.ts does
// with it, minus the driving.

export interface GeneratedArchive {
  user: SeedUser;
  path: string;
  bytes: number;
}

// Users with no library generate nothing: an empty account is created and left
// alone, which is the state it is there to represent.
export async function generateArchives(
  users: readonly SeedUser[] = SEED_USERS,
  now: number = Date.now(),
): Promise<GeneratedArchive[]> {
  await mkdir(SEED_ARCHIVES, { recursive: true });

  const written: GeneratedArchive[] = [];
  for (const user of users) {
    if (user.links === 0) continue;

    const library = buildLibrary(user, { now });
    const archive = buildBackupArchive(library);
    const path = join(SEED_ARCHIVES, `${user.key}.zip`);
    await writeFile(path, archive);

    written.push({ user, path, bytes: archive.byteLength });
    console.log(
      `${user.key}: ${library.counts.links} links, ${library.counts.lists} lists, ` +
        `${library.counts.tags} tags, ${library.counts.pins} pins, ` +
        `${library.counts.files} files → ${path} (${Math.round(archive.byteLength / 1024)} KB)`,
    );
  }
  return written;
}

// `tsx seed/fixtures.ts` — the CLI, and `seed:fixtures` is the target it answers
// to. Guarded on being the entry module so accounts.ts, which imports
// `generateArchives` and calls it itself, doesn't run it twice.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateArchives();
}
