/**
 * `store-release.sh`, `android-bundle.sh` and the first step of `ios-upload.sh`,
 * pinned.
 *
 *   npm run test:store-release
 *
 * NOT part of `npm run test`, for the reason `tools/cloudfront/rewrite-url.test.mjs`
 * gives: `tools/` is not a project in the graph (docs/testing.md, _the things
 * outside the two runners_).
 *
 * The way this script fails is silent and permanent: a public tag on the wrong
 * commit. So every test runs the real script, in a throwaway repo with a real
 * bare `origin`, and reads the answer back out of git. Each refusal has a passing
 * control built from the same fixture. `npx`, Gradle, `asc` and the bundle check
 * are stood in for, so what is pinned here is what those scripts refuse and in
 * what order, not that a real build succeeds.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const GRADLE = (name, code) =>
  `android {\n    defaultConfig {\n        versionCode ${code}\n        versionName "${name}"\n    }\n}\n`;

const PLIST = (version, build) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${build}</string>
</dict></plist>
`;

const NOTE = (store) => `## ${store}\n\n\`\`\`text\nSync is faster.\n\`\`\`\n`;

const ARCHIVE_PLIST =
  'apps/bracemark-expo/build/Bracemark.xcarchive/Products/Applications/Bracemark.app/Info.plist';

const executable = (path, content) => {
  write(path, content);
  chmodSync(path, 0o755);
};

/**
 * Stand-ins on PATH: `npx` plays `expo prebuild`, writing an android/ whose
 * gradlew leaves a bundle behind, and `asc` only says it ran.
 */
function standIns(root, versionCode) {
  const bin = join(root, 'bin');
  executable(
    join(bin, 'npx'),
    `#!/bin/sh
mkdir -p android/app
cat > android/app/build.gradle <<'GRADLE'
${GRADLE('1.2.0', versionCode)}GRADLE
cat > android/gradlew <<'GRADLEW'
#!/bin/sh
touch "${root}/gradle-ran"
mkdir -p app/build/outputs/bundle/release
echo bundle > app/build/outputs/bundle/release/app-release.aab
GRADLEW
chmod +x android/gradlew
`,
  );
  executable(join(bin, 'asc'), `#!/bin/sh\ntouch "${root}/asc-ran"\n`);
  return bin;
}

/** A repo laid out like this one, with one commit that `origin` already has. */
function fixture({ versionCode = 4 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'store-release-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(repo);
  git(root, 'init', '--quiet', '--bare', origin);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'remote', 'add', 'origin', origin);

  mkdirSync(join(repo, 'tools/scripts'), { recursive: true });
  for (const name of [
    'store-release.sh',
    'deploy-commit.sh',
    'android-bundle.sh',
    'ios-upload.sh',
    'check-release-notes.mjs',
  ]) {
    copyFileSync(join(SCRIPTS, name), join(repo, 'tools/scripts', name));
  }
  write(
    join(repo, 'tools/scripts/check-native-bundle.mjs'),
    'process.exit(process.env.FAIL_BUNDLE_CHECK ? 1 : 0);\n',
  );
  write(join(repo, 'release-notes/bracemark-extension/1.2.0.md'), NOTE('Firefox Add-ons'));
  write(
    join(repo, 'release-notes/bracemark-expo/9.9.9.md'),
    `${NOTE('App Store')}\n${NOTE('Google Play')}`,
  );
  write(join(repo, '.gitignore'), '.output/\nbuild/\nandroid/\n');
  write(join(repo, 'apps/bracemark-extension/package.json'), '{ "version": "1.2.0" }\n');
  write(join(repo, 'apps/bracemark-expo/app.config.ts'), "version: '9.9.9',\n");
  write(join(repo, 'apps/bracemark-expo/android/app/build.gradle'), GRADLE('1.2.0', 4));
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'first');
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');

  const bin = standIns(root, versionCode);
  const run = (env, ...args) =>
    spawnSync('bash', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
  const script = (...args) => run({}, 'tools/scripts/store-release.sh', ...args);
  return {
    root,
    repo,
    origin,
    script,
    androidBundle: (env = {}) =>
      run(
        env,
        'tools/scripts/store-release.sh',
        'build',
        'android',
        '--',
        'bash',
        'tools/scripts/android-bundle.sh',
      ),
    iosUpload: () => run({}, 'tools/scripts/ios-upload.sh'),
    archive(version, build) {
      write(join(repo, ARCHIVE_PLIST), PLIST(version, build));
    },
    build: (store, ...command) =>
      script('build', store, '--', ...(command.length ? command : ['true'])),
    tag: (store, ...flags) => script('tag', store, '--yes', ...flags),
    commit(message) {
      write(join(repo, `${message}.txt`), message);
      git(repo, 'add', '.');
      git(repo, 'commit', '--quiet', '-m', message);
      return git(repo, 'rev-parse', 'HEAD');
    },
    head: () => git(repo, 'rev-parse', 'HEAD'),
    tagged: (name, cwd = repo) => git(cwd, 'rev-parse', '--verify', `refs/tags/${name}^{commit}`),
    tags: (cwd = repo) => git(cwd, 'tag', '-l'),
  };
}

describe('tag', () => {
  it('tags the commit the build came from, after HEAD has moved on, and pushes it', () => {
    const f = fixture();
    const built = f.head();
    assert.equal(f.build('chrome').status, 0);
    f.commit('a-fix-after-the-build');
    git(f.repo, 'push', '--quiet', 'origin', 'main');

    assert.equal(f.tag('chrome').status, 0);

    assert.equal(f.tagged('chrome/1.2.0'), built);
    assert.notEqual(built, f.head());
    assert.equal(f.tagged('chrome/1.2.0', f.origin), built);
  });

  it('holds a tag back when origin does not have its commit, and pushes it later', () => {
    const f = fixture();
    const unpushed = f.commit('not-public-yet');
    assert.equal(f.build('firefox').status, 0);

    const held = f.tag('firefox');
    assert.equal(held.status, 0);
    assert.equal(f.tagged('firefox/1.2.0'), unpushed);
    assert.equal(f.tags(f.origin), '');
    assert.match(held.stdout, /would publish it/);

    git(f.repo, 'push', '--quiet', 'origin', 'main');
    assert.equal(f.build('android').status, 0);
    assert.equal(f.tag('android').status, 0);
    assert.equal(f.tagged('firefox/1.2.0', f.origin), unpushed);
  });

  it('tags but does not push with --no-push', () => {
    const f = fixture();
    f.build('chrome');
    assert.equal(f.tag('chrome', '--no-push').status, 0);
    assert.equal(f.tags(), 'chrome/1.2.0');
    assert.equal(f.tags(f.origin), '');
  });

  it('asks rather than tagging silently when there is no terminal', () => {
    const f = fixture();
    f.build('chrome');
    const result = f.script('tag', 'chrome');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pass --yes/);
    assert.equal(f.tags(), '');
  });

  it('refuses when no build is recorded', () => {
    const f = fixture();
    const result = f.tag('chrome');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no chrome build is recorded/);
    assert.equal(f.tags(), '');
  });

  it('refuses a number that is already tagged', () => {
    const f = fixture();
    f.build('chrome');
    assert.equal(f.tag('chrome').status, 0);
    const result = f.tag('chrome');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
  });

  it('refuses a build whose commit was amended away', () => {
    const f = fixture();
    f.commit('amended-later');
    f.build('chrome');
    git(f.repo, 'commit', '--quiet', '--amend', '-m', 'amended');
    const result = f.tag('chrome');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in this branch/);
    assert.equal(f.tags(), '');
  });
});

describe('build', () => {
  it('refuses at tag time a build made from a dirty tree, then passes once committed', () => {
    const f = fixture();
    write(join(f.repo, 'uncommitted.txt'), 'work in progress');
    const dirty = f.build('chrome');
    assert.equal(dirty.status, 0);
    assert.match(dirty.stderr, /can't be tagged/);

    const refused = f.tag('chrome');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /uncommitted changes/);
    assert.equal(f.tags(), '');

    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '--quiet', '-m', 'now committed');
    assert.equal(f.build('chrome').status, 0);
    assert.equal(f.tag('chrome').status, 0);
    assert.equal(f.tagged('chrome/1.2.0'), f.head());
  });

  it('refuses at tag time a build during which a commit landed', () => {
    const f = fixture();
    const commitDuring = 'echo x > during.txt && git add . && git commit --quiet -m during';
    assert.equal(f.build('chrome', 'sh', '-c', commitDuring).status, 0);

    const result = f.tag('chrome');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed during the build/);
    assert.equal(f.tags(), '');
  });

  it('passes on a failed build’s status and keeps the last good record', () => {
    const f = fixture();
    const good = f.head();
    f.build('chrome');
    f.commit('broken');

    assert.equal(f.build('chrome', 'sh', '-c', 'exit 7').status, 7);

    assert.equal(f.tag('chrome').status, 0);
    assert.equal(f.tagged('chrome/1.2.0'), good);
  });

  it('says so when a different release is about to lose its only record', () => {
    const f = fixture();
    const old = f.head();
    f.build('chrome');
    write(join(f.repo, 'apps/bracemark-extension/package.json'), '{ "version": "1.3.0" }\n');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '--quiet', '-m', 'bump');

    const result = f.build('chrome');
    assert.match(result.stderr, /chrome\/1\.2\.0 was built but never tagged/);
    assert.ok(result.stderr.includes(`git tag chrome/1.2.0 ${old}`));
  });

  it('stays quiet about the previous record when it was tagged or is a rebuild', () => {
    const f = fixture();
    f.build('chrome');
    assert.doesNotMatch(f.build('chrome').stderr, /never tagged/);

    f.tag('chrome');
    write(join(f.repo, 'apps/bracemark-extension/package.json'), '{ "version": "1.3.0" }\n');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '--quiet', '-m', 'bump');
    assert.doesNotMatch(f.build('chrome').stderr, /never tagged/);
  });

  it('warns when the number has already been released', () => {
    const f = fixture();
    f.build('chrome');
    f.tag('chrome');
    assert.match(f.build('chrome').stderr, /already exists/);
  });
});

describe('the tag name', () => {
  it('reads android from build.gradle, not app.config.ts', () => {
    const f = fixture();
    f.build('android');
    assert.equal(f.tag('android').status, 0);
    assert.equal(f.tags(), 'android/1.2.0-4');
  });

  it(
    'reads ios from the archive',
    { skip: process.platform !== 'darwin' && 'plutil is macOS-only' },
    () => {
      const f = fixture();
      f.archive('1.2.0', '3');
      f.build('ios');
      assert.equal(f.tag('ios').status, 0);
      assert.equal(f.tags(), 'ios/1.2.0-3');
    },
  );

  it('fails rather than recording a build whose number cannot be read', () => {
    const f = fixture();
    write(join(f.repo, 'apps/bracemark-expo/android/app/build.gradle'), 'nothing here\n');
    const result = f.build('android');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /can't read/);
    assert.notEqual(f.tag('android').status, 0);
  });

  it('keeps each store’s tags apart', () => {
    const f = fixture();
    for (const store of ['chrome', 'firefox', 'android']) {
      f.build(store);
      assert.equal(f.tag(store).status, 0);
    }
    assert.deepEqual(f.tags().split('\n').sort(), [
      'android/1.2.0-4',
      'chrome/1.2.0',
      'firefox/1.2.0',
    ]);
  });
});

describe('release notes at build time', () => {
  it('warns, and still records the build, when a store’s notes are missing', () => {
    const f = fixture();
    rmSync(join(f.repo, 'release-notes/bracemark-extension/1.2.0.md'));
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '--quiet', '-m', 'lose the notes');

    const result = f.build('firefox');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /release notes need attention/);
    assert.match(result.stderr, /1\.2\.0\.md is missing/);
    assert.equal(f.tag('firefox').status, 0);
  });

  it('says nothing when the notes are fine', () => {
    const f = fixture();
    assert.doesNotMatch(f.build('firefox').stderr, /release notes/);
  });
});

describe('android-bundle.sh', () => {
  it('replaces a stale android/, and leaves the bundle outside it', () => {
    const f = fixture({ versionCode: 5 });
    write(join(f.repo, 'apps/bracemark-expo/android/stale.txt'), 'from an old prebuild');

    const result = f.androidBundle();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(join(f.repo, 'apps/bracemark-expo/android/stale.txt')));
    assert.ok(existsSync(join(f.repo, 'apps/bracemark-expo/build/Bracemark.aab')));

    assert.equal(f.tag('android').status, 0);
    assert.equal(f.tags(), 'android/1.2.0-5');
    assert.equal(f.tagged('android/1.2.0-5'), f.head());
  });

  it('stops before Gradle when versionCode is not above the highest released one', () => {
    const f = fixture({ versionCode: 9 });
    git(f.repo, 'tag', 'android/1.1.0-9');
    git(f.repo, 'tag', 'android/1.0.0-2');

    const result = f.androidBundle();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /versionCode 9 is not above android\/1\.1\.0-9/);
    assert.ok(result.stderr.includes('to 10 (or higher)'));
    assert.ok(!existsSync(join(f.root, 'gradle-ran')));
  });

  it('compares versionCodes as numbers, not as text', () => {
    const f = fixture({ versionCode: 10 });
    git(f.repo, 'tag', 'android/1.2.0-9');
    assert.equal(f.androidBundle().status, 0);
  });

  it('leaves no bundle and the last good record when the bundle check fails', () => {
    const f = fixture({ versionCode: 5 });
    const good = f.head();
    assert.equal(f.androidBundle().status, 0);
    f.commit('broken');

    assert.notEqual(f.androidBundle({ FAIL_BUNDLE_CHECK: '1' }).status, 0);

    assert.ok(!existsSync(join(f.repo, 'apps/bracemark-expo/build/Bracemark.aab')));
    assert.equal(f.tag('android').status, 0);
    assert.equal(f.tagged('android/1.2.0-5'), good);
  });
});

describe('ios-upload.sh', { skip: process.platform !== 'darwin' && 'plutil is macOS-only' }, () => {
  const built = (f) => {
    f.archive('1.2.0', '1');
    f.build('ios');
  };
  const refused = (f, pattern) => {
    const result = f.iosUpload();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.ok(!existsSync(join(f.root, 'asc-ran')));
  };

  it('uploads a build that can be tagged', () => {
    const f = fixture();
    built(f);
    const result = f.iosUpload();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(f.root, 'asc-ran')));
    assert.match(result.stdout, /npm run ios:tag/);
  });

  it('refuses a dirty build before anything is sent', () => {
    const f = fixture();
    write(join(f.repo, 'uncommitted.txt'), 'work in progress');
    built(f);
    refused(f, /could never be tagged/);
  });

  it('refuses an archive the record does not describe', () => {
    const f = fixture();
    built(f);
    f.archive('1.2.0', '2');
    refused(f, /record says ios\/1\.2\.0-1/);
  });

  it('refuses an archive with no record', () => {
    const f = fixture();
    f.archive('1.2.0', '1');
    refused(f, /no ios build is recorded/);
  });

  it('refuses a number that has already been released', () => {
    const f = fixture();
    built(f);
    assert.equal(f.tag('ios').status, 0);
    refused(f, /has been released/);
  });
});

describe('check', () => {
  it('reads the same record for a hand upload', () => {
    const f = fixture();
    assert.notEqual(f.script('check', 'chrome').status, 0);
    f.build('chrome');
    assert.equal(f.script('check', 'chrome').status, 0);
  });
});
