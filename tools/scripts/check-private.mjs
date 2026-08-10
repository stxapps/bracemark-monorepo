// Fails if this public repo tracks anything from the private `internal/` folder.
//
// The same rule as tools/git-hooks/pre-commit, minus git's hook machinery: a hook
// is local to one clone and `git commit --no-verify` skips it, so CI needs a check
// that cannot be bypassed from a developer's machine. Run as
// `npm run check:private`.
//
// In a public CI checkout `internal/` does not exist at all, so the expected
// output is empty and this exits 0 in milliseconds. The pathspec has no trailing
// slash: `internal/` would miss the likeliest form of the mistake, a gitlink whose
// path is exactly `internal`. See tools/git-hooks/pre-commit for why that is the
// shape a leak takes.

import { execFileSync } from 'node:child_process';

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '--cached', '--', 'internal'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  // Not a git repo (an exported tarball, say). Nothing tracked, nothing to leak.
  process.exit(0);
}

const entries = tracked.split('\n').filter(Boolean);
if (entries.length === 0) process.exit(0);

console.error('BLOCKED: this repo tracks the private internal/ folder.\n');
for (const entry of entries) console.error(`  ${entry}`);
console.error('\nDrop them from the index (the files stay on disk):');
console.error('  git rm -r --cached --force internal');
process.exit(1);
