import { argon2 } from 'react-native-quick-crypto';

import { ARGON2_PARAMS, utf8 } from '@stxapps/shared';

// Runs Argon2id(password, salt) and resolves the raw 32-byte hash — the Expo
// sibling of web-crypto's deriveArgon2Hash. Same "dumb KDF step" contract: the
// caller (derivePasswordKek) computes the per-user salt via @stxapps/shared's
// deriveUserSalt and hands it in ready-to-use.
//
// The ~1–3s compute runs in C++ off the JS thread (react-native-quick-crypto's
// Nitro module; the callback form is the async path) — the native counterpart
// of web-crypto's Web Worker. Both implement RFC 9106 Argon2id v1.3 (0x13,
// quick-crypto's default `version`, and the only version hash-wasm produces),
// so given the frozen ARGON2_PARAMS the output is byte-identical to web. The
// param names differ; the mapping is part of what the contract-vector spec
// pins: iterations → passes, memorySize → memory (both KiB), hashLength →
// tagLength. The password is utf8-encoded HERE (hash-wasm does the same
// internally on web) so the bytes fed to the KDF are never ambiguous.
export function deriveArgon2Hash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: utf8(password),
        nonce: salt,
        parallelism: ARGON2_PARAMS.parallelism,
        passes: ARGON2_PARAMS.iterations,
        memory: ARGON2_PARAMS.memorySize,
        tagLength: ARGON2_PARAMS.hashLength,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(new Uint8Array(result));
      },
    );
  });
}
