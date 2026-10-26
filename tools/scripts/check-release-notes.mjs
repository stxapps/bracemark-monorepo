// Fails when a store's release notes in release-notes/ would be rejected by the
// console or break a rule of the voice that nothing else checks.
//
//   npm run check:release-notes
//
// WHY THIS EXISTS. The notes are pasted into App Store Connect, the Play Console
// and Firefox Add-ons by hand, once per version, and they are Markdown — so the
// two things that hold every other published string do not reach them: the
// `no-restricted-syntax` typography rule lints .ts/.tsx only, and
// listing-copy.spec.ts walks the exports of one module. Without this script a
// 501-character Play note fails on submission day, and a straight apostrophe
// ships (docs/brand-assets.md, _the mechanics_).
//
// WHAT IT CHECKS, per file `release-notes/<app>/<version>.md`:
//   - one `## <store>` section per store the app ships to, and no other;
//   - exactly one ```text block in each, which is what gets pasted. `text`
//     rather than any other info string because prettier formats the code
//     blocks it has a parser for (md, js, …) and leaves `text` byte-identical;
//   - the store's character budget, where the store documents one;
//   - no straight ' or ", no "!", and no bare "extension".
// And per app: that its CURRENT version has a notes file, so a version bump
// without notes is caught before the build is uploaded rather than in the
// console's empty "What's New" field.
//
// WHAT IT CANNOT CHECK: everything in the voice that is a judgement — British
// spelling, the serial comma, "link" vs "bookmark", "tap" vs "click", and
// whether a line describes a change that actually shipped. That is still
// docs/brand-assets.md, read by a person.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Character budget per store, or null where the store documents none. Counted
 * in code points, which is what a person typing into the console sees.
 * Re-verify in the consoles at submission — the same advice as STORE_LIMITS in
 * packages/shared/src/stores/listing-copy.ts.
 */
export const STORE_BUDGETS = {
  'App Store': 4000,
  'Google Play': 500,
  // AMO's version form documents no limit for release notes.
  'Firefox Add-ons': null,
};

/** Where each app's current version is written, and the stores it ships to. */
export const APPS = {
  'bracemark-expo': {
    stores: ['App Store', 'Google Play'],
    // One top-level `version` key for both platforms (docs/expo-build.md, _versions_).
    versionOf: (root) =>
      readFileSync(path.join(root, 'apps/bracemark-expo/app.config.ts'), 'utf8').match(
        /^\s*version: '([^']+)',/m,
      )?.[1],
  },
  'bracemark-extension': {
    // The Chrome Web Store has no release-notes field.
    stores: ['Firefox Add-ons'],
    versionOf: (root) =>
      JSON.parse(readFileSync(path.join(root, 'apps/bracemark-extension/package.json'), 'utf8'))
        .version,
  },
};

const VERSION_FILE = /^\d+\.\d+\.\d+\.md$/;

/** Split a notes file into its `## ` sections, each with its fenced blocks. */
export function parseNotes(source) {
  const sections = new Map();
  let current = null;
  let fence = null;
  for (const line of source.split('\n')) {
    if (fence) {
      if (line.trimEnd() === '```') {
        current?.blocks.push({ info: fence.info, text: fence.lines.join('\n') });
        fence = null;
      } else {
        fence.lines.push(line);
      }
    } else if (line.startsWith('```')) {
      fence = { info: line.slice(3).trim(), lines: [] };
    } else if (line.startsWith('## ')) {
      current = { blocks: [] };
      sections.set(line.slice(3).trim(), current);
    }
  }
  return sections;
}

/** The voice and budget checks on one block of pasted text. */
export function checkText(text, budget) {
  const problems = [];
  if (text.trim() === '') problems.push('is empty');
  const length = [...text].length;
  if (budget !== null && length > budget) {
    problems.push(`is ${length} characters, over the store’s ${budget}`);
  }
  if (text.includes("'")) problems.push('has a straight apostrophe — use ’');
  if (text.includes('"')) problems.push('has a straight quotation mark — use “ ”');
  if (text.includes('!')) problems.push('has an exclamation mark');
  // CLAUDE.md: the browser extension and the share extension are unrelated.
  if (/(?<!(?:browser|share) )\bextensions?\b/i.test(text)) {
    problems.push('says “extension” bare — write browser extension or share extension');
  }
  return problems;
}

/** Every problem in one notes file, each prefixed with where it is. */
export function checkNotes(source, stores) {
  const problems = [];
  const sections = parseNotes(source);
  for (const heading of sections.keys()) {
    if (!stores.includes(heading)) {
      problems.push(`## ${heading} is not a store this app ships to (${stores.join(', ')})`);
    }
  }
  for (const store of stores) {
    const section = sections.get(store);
    if (!section) {
      problems.push(`no ## ${store} section`);
      continue;
    }
    if (section.blocks.length !== 1) {
      problems.push(`## ${store} has ${section.blocks.length} code blocks, not 1`);
      continue;
    }
    const [block] = section.blocks;
    if (block.info !== 'text') {
      problems.push(`## ${store} block is \`\`\`${block.info}, not \`\`\`text`);
    }
    for (const problem of checkText(block.text, STORE_BUDGETS[store])) {
      problems.push(`## ${store} ${problem}`);
    }
  }
  return problems;
}

/** Walk release-notes/ under `root`. */
export function checkReleaseNotes(root, apps = APPS) {
  const problems = [];
  const notesDir = path.join(root, 'release-notes');
  const folders = readdirSync(notesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) {
    if (!apps[folder.name]) problems.push(`release-notes/${folder.name}/ is not a known app`);
  }
  for (const [app, { stores, versionOf }] of Object.entries(apps)) {
    const dir = path.join(notesDir, app);
    const files = folders.some((folder) => folder.name === app) ? readdirSync(dir).sort() : [];
    for (const file of files) {
      const where = `release-notes/${app}/${file}`;
      if (!VERSION_FILE.test(file)) {
        problems.push(`${where} is not named <major>.<minor>.<patch>.md`);
        continue;
      }
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const problem of checkNotes(source, stores)) problems.push(`${where}: ${problem}`);
    }
    const version = versionOf(root);
    if (!version) {
      problems.push(`could not read ${app}’s current version`);
    } else if (!files.includes(`${version}.md`)) {
      problems.push(`${app} is at ${version} and release-notes/${app}/${version}.md is missing`);
    }
  }
  return problems;
}

function main() {
  const problems = checkReleaseNotes(REPO_ROOT);
  if (problems.length === 0) {
    console.log('ok: every app’s current version has release notes, and each one fits');
    return;
  }
  console.error('BLOCKED: release notes that a store would reject or the voice rules out.\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nSee release-notes/README.md and docs/brand-assets.md, _the voice_.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
