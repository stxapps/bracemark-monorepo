/**
 * `check-release-notes.mjs`, pinned.
 *
 *   npm run test:check-release-notes
 *
 * NOT part of `npm run test`, for the reason `tools/cloudfront/rewrite-url.test.mjs`
 * gives: `tools/` is not a project in the graph (docs/testing.md, _the things
 * outside the two runners_).
 *
 * A check that reads nothing passes, so the way it fails silently — missing a
 * section, a block, or a whole file — is pinned here. Every refusal has a
 * passing control built from the same fixture.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { checkNotes, checkReleaseNotes, checkText, parseNotes } from './check-release-notes.mjs';

const GOOD = 'Sync is faster.\n\nFound a bug, or need help? bracemark.com/support';
const notes = (sections) =>
  Object.entries(sections)
    .map(([store, text]) => `## ${store}\n\n\`\`\`text\n${text}\n\`\`\`\n`)
    .join('\n');

describe('parseNotes', () => {
  it('reads each section’s fenced blocks, and ignores a heading inside one', () => {
    const sections = parseNotes('# t\n\n## A\n\n```text\none\n## B\ntwo\n```\n');
    assert.deepEqual([...sections.keys()], ['A']);
    assert.deepEqual(sections.get('A').blocks, [{ info: 'text', text: 'one\n## B\ntwo' }]);
  });
});

describe('checkText', () => {
  it('passes the shape the README gives', () => {
    assert.deepEqual(checkText(GOOD, 500), []);
  });

  it('refuses a text over budget, counting code points', () => {
    assert.deepEqual(checkText('•'.repeat(500), 500), []);
    assert.match(checkText('•'.repeat(501), 500).join(), /501 characters/);
  });

  it('does not count where the store has no budget', () => {
    assert.deepEqual(checkText('a'.repeat(10_000), null), []);
  });

  it('refuses straight quotes and exclamation marks', () => {
    assert.deepEqual(checkText('We’ve fixed “Sync”.', 500), []);
    assert.match(checkText("We've fixed it.", 500).join(), /apostrophe/);
    assert.match(checkText('Fixed "Sync".', 500).join(), /quotation mark/);
    assert.match(checkText('Faster sync!', 500).join(), /exclamation/);
  });

  it('refuses a bare extension and passes a qualified one', () => {
    assert.deepEqual(checkText('The browser extension and the share extension.', 500), []);
    assert.match(checkText('The extension saves faster.', 500).join(), /bare/);
    assert.match(checkText('Extensions sync faster.', 500).join(), /bare/);
  });

  it('refuses an empty block', () => {
    assert.match(checkText('\n', 500).join(), /empty/);
  });
});

describe('checkNotes', () => {
  const stores = ['App Store', 'Google Play'];

  it('passes one text block per store', () => {
    assert.deepEqual(checkNotes(notes({ 'App Store': GOOD, 'Google Play': GOOD }), stores), []);
  });

  it('refuses a missing store and an unknown one', () => {
    const problems = checkNotes(notes({ 'App Store': GOOD, 'Play Store': GOOD }), stores);
    assert.deepEqual(problems, [
      '## Play Store is not a store this app ships to (App Store, Google Play)',
      'no ## Google Play section',
    ]);
  });

  it('refuses a section with no block, or two', () => {
    const none = `## App Store\n\n${GOOD}\n\n${notes({ 'Google Play': GOOD })}`;
    assert.match(checkNotes(none, stores).join(), /App Store has 0 code blocks/);
    const two = notes({
      'App Store': `${GOOD}\n\`\`\`\n\n\`\`\`text\n${GOOD}`,
      'Google Play': GOOD,
    });
    assert.match(checkNotes(two, stores).join(), /App Store has 2 code blocks/);
  });

  it('refuses a block prettier would format', () => {
    const md = notes({ 'App Store': GOOD, 'Google Play': GOOD }).replace('```text', '```md');
    assert.match(checkNotes(md, stores).join(), /```md, not ```text/);
  });

  it('applies each store’s own budget', () => {
    const long = 'a'.repeat(501);
    assert.deepEqual(checkNotes(notes({ 'App Store': long, 'Google Play': long }), stores), [
      '## Google Play is 501 characters, over the store’s 500',
    ]);
  });
});

describe('checkReleaseNotes', () => {
  const dirs = [];
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  const APPS = {
    app: { stores: ['App Store'], versionOf: () => '1.1.0' },
  };

  function rootWith(files) {
    const root = mkdtempSync(join(tmpdir(), 'check-release-notes-'));
    dirs.push(root);
    mkdirSync(join(root, 'release-notes'));
    for (const [file, source] of Object.entries(files)) {
      const at = join(root, 'release-notes', file);
      mkdirSync(join(at, '..'), { recursive: true });
      writeFileSync(at, source);
    }
    return root;
  }

  it('passes when the current version has good notes', () => {
    const root = rootWith({
      'app/1.0.0.md': notes({ 'App Store': GOOD }),
      'app/1.1.0.md': notes({ 'App Store': GOOD }),
    });
    assert.deepEqual(checkReleaseNotes(root, APPS), []);
  });

  it('refuses a current version with no notes', () => {
    const root = rootWith({ 'app/1.0.0.md': notes({ 'App Store': GOOD }) });
    assert.deepEqual(checkReleaseNotes(root, APPS), [
      'app is at 1.1.0 and release-notes/app/1.1.0.md is missing',
    ]);
  });

  it('refuses an app with no folder at all', () => {
    assert.match(checkReleaseNotes(rootWith({}), APPS).join(), /1\.1\.0\.md is missing/);
  });

  it('reads every file, not only the current one', () => {
    const root = rootWith({
      'app/1.0.0.md': notes({ 'App Store': 'Faster!' }),
      'app/1.1.0.md': notes({ 'App Store': GOOD }),
    });
    assert.deepEqual(checkReleaseNotes(root, APPS), [
      'release-notes/app/1.0.0.md: ## App Store has an exclamation mark',
    ]);
  });

  it('refuses an unknown app folder and a misnamed file', () => {
    const root = rootWith({
      'other/1.1.0.md': notes({ 'App Store': GOOD }),
      'app/1.1.0.md': notes({ 'App Store': GOOD }),
      'app/v1.2.md': notes({ 'App Store': GOOD }),
    });
    assert.deepEqual(checkReleaseNotes(root, APPS), [
      'release-notes/other/ is not a known app',
      'release-notes/app/v1.2.md is not named <major>.<minor>.<patch>.md',
    ]);
  });

  it('refuses when the current version cannot be read', () => {
    const root = rootWith({ 'app/1.1.0.md': notes({ 'App Store': GOOD }) });
    const apps = { app: { ...APPS.app, versionOf: () => undefined } };
    assert.deepEqual(checkReleaseNotes(root, apps), ['could not read app’s current version']);
  });
});
