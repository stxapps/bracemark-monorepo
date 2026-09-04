// Emits packages/shared/src/crypto/contract-vectors.json from the TypeScript
// vector, for the test suites that cannot import TypeScript: the Swift and
// Kotlin BlobFrame tests read that JSON off disk.
//
// The JSON is CHECKED IN and generated, never hand-edited —
// contract-vectors.spec.ts fails if the two drift, which is what stops the
// native side from quietly asserting a stale frame.
//
//   npx tsx tools/scripts/generate-contract-vectors.ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CRYPTO_CONTRACT_VECTOR } from '../../packages/shared/src/crypto/contract-vectors';

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'crypto',
  'contract-vectors.json',
);

writeFileSync(out, `${JSON.stringify(CRYPTO_CONTRACT_VECTOR, null, 2)}\n`, 'utf8');
console.log(`wrote ${out}`);
