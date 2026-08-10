// Jest-only stand-in for react-native-quick-crypto (see jest.config.cts
// moduleNameMapper). quick-crypto is a JSI/Nitro module that needs a real RN
// runtime; under jest we substitute the SAME API on Node primitives:
//
//   hkdfSync / createCipheriv / createDecipheriv / randomBytes / randomUUID
//     → node:crypto exports directly — quick-crypto deliberately mirrors the
//       Node crypto API, so these are drop-in.
//   argon2 → hash-wasm's argon2id (RFC 9106 v1.3, the same spec quick-crypto's
//       C++ implements), adapted to quick-crypto's (algorithm, params, cb)
//       shape including its param names (passes/memory/tagLength).
//
// The specs therefore exercise OUR code — param mapping, tag placement, wire
// format, derivation order — against the frozen contract vectors; they don't
// re-test quick-crypto's internals (upstream's job).
//
// Be clear about what that leaves UNPROVEN: nothing in this repo runs the
// contract vectors against the real JSI module, so "quick-crypto's C++ Argon2id/
// HKDF/AES-GCM produces the same bytes as web" rests on both implementing the
// same specs, not on a test. Closing it needs a device/simulator harness (which
// would also cover the Swift/Kotlin BracemarkFileCrypto framer, likewise untested).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';

import { argon2id } from 'hash-wasm';

export { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID };

interface Argon2Params {
  message: Uint8Array;
  nonce: Uint8Array;
  parallelism: number;
  tagLength: number;
  memory: number;
  passes: number;
}

export function argon2(
  algorithm: string,
  params: Argon2Params,
  callback: (err: Error | null, result: Buffer) => void,
): void {
  if (algorithm !== 'argon2id') {
    callback(new Error(`shim only implements argon2id, got: ${algorithm}`), Buffer.alloc(0));
    return;
  }
  argon2id({
    password: params.message,
    salt: params.nonce,
    parallelism: params.parallelism,
    iterations: params.passes,
    memorySize: params.memory,
    hashLength: params.tagLength,
    outputType: 'binary',
  })
    .then((hash) => callback(null, Buffer.from(hash)))
    .catch((err: Error) => callback(err, Buffer.alloc(0)));
}
