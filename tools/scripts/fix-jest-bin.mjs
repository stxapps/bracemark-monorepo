// Postinstall guard for a bin-name collision: both `jest` (the real CLI) and
// `jest-expo` (which ships its own `bin: { jest: bin/jest.js }` wrapping a
// NESTED jest 29) want node_modules/.bin/jest, and which symlink npm writes
// depends on reify order — it can flip on any install. When jest-expo wins,
// every project's inferred `test` target (which runs the bare `jest` command)
// silently executes jest 29 and fails on untransformed ESM ("Cannot use
// import statement outside a module" from jest-expo/node_modules/jest-runtime).
//
// Every project is fine on the real jest 30 — including bracemark-expo, whose
// jest-expo PRESET (config) works under it; only jest-expo's BIN is the trap —
// so deterministically point the bin at the real CLI after every install.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(root, 'node_modules', '.bin', 'jest');
const real = path.join(root, 'node_modules', 'jest', 'bin', 'jest.js');

if (existsSync(real)) {
  try {
    await fs.rm(bin, { force: true });
    // Relative target, like npm's own bin links.
    await fs.symlink(path.join('..', 'jest', 'bin', 'jest.js'), bin);
  } catch (err) {
    // Best-effort (e.g. no symlinks on a bare Windows checkout) — a wrong link
    // surfaces loudly in `npm run test` either way.
    console.warn('[fix-jest-bin] could not relink node_modules/.bin/jest:', err?.message);
  }
}
