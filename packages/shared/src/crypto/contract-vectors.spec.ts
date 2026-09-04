import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CRYPTO_CONTRACT_VECTOR } from './contract-vectors';

// The JSON twin of the vector exists for one reason: Swift and Kotlin cannot
// import TypeScript, and the BlobFrame tests on both platforms assert the v1
// frame against `blob.packedHex`. Feeding them a hand-copied hex string would
// have rebuilt the exact problem those tests were written to close — a second
// copy of a frozen value, drifting in silence — one layer further out.
//
// So the JSON is generated (tools/scripts/generate-contract-vectors.ts) and this
// is the only thing standing between it and staleness. It runs in `shared`,
// where the TypeScript vector lives, so editing the vector fails HERE rather
// than in a native suite most changes never run.
describe('contract-vectors.json', () => {
  it('matches the TypeScript vector byte for byte', () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, 'contract-vectors.json'), 'utf8'),
    ) as unknown;

    // Through JSON so `as const` readonly-ness and key order stop mattering —
    // the values are the contract, not the literal file bytes.
    expect(json).toEqual(JSON.parse(JSON.stringify(CRYPTO_CONTRACT_VECTOR)));
  });
});
