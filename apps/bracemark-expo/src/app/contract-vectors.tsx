import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Redirect } from 'expo-router';

import {
  decryptEntity,
  deriveArgon2Hash,
  unlockAccount,
  unlockAccountWithRecovery,
} from '@stxapps/expo-crypto';
import {
  BLOB_FORMAT_V1,
  bytesToHex,
  canonicalizePassword,
  codePointsToString,
  CRYPTO_CONTRACT_VECTOR as V,
  deriveUserSalt,
  hexToBytes,
  utf8,
} from '@stxapps/shared';

// `/contract-vectors` — a DEV-ONLY screen that runs the frozen crypto contract
// vectors against the REAL native primitives, and renders the result as
// something Maestro can assert on (`e2e/mobile/contract/vectors.yaml`).
//
// Why a screen, when `@stxapps/expo-crypto` already has contract-vectors.spec.ts:
// under jest, react-native-quick-crypto is shimmed onto Node and hash-wasm
// (packages/expo-crypto/src/testing/quick-crypto-node-shim.ts), so that suite
// proves our param mapping, derivation order and framing — NOT that
// quick-crypto's C++ Argon2id/HKDF/AES-GCM emit these bytes on a device. Nothing
// in the repo asserted that, and there is no way to assert it off-device: it
// needs Hermes, the JSI and the real library, which means running inside the app.
//
// It is not redundant with the web⇄mobile contract runs either, and the
// difference is the whole point of a FROZEN vector. Those prove the two
// platforms agree with EACH OTHER today; they would stay green if both drifted
// together — a param change shipped to web and native in one release passes the
// round trip and locks every existing user out of their own data. This pins the
// bytes themselves, on device, so that drift fails here instead.
//
// It sits at the root of `src/app/`, a sibling of `(app)` and `(auth)`, so it
// renders outside AuthGuard and GuestGuard — the vectors carry their own account
// and need no session. In production it redirects to `/`, and because `__DEV__`
// is a build-time constant Metro drops the branch below from release bundles.
//
// The imports are STATIC, deliberately, even though a `require` inside the
// `__DEV__` branch would keep the vector table out of release bundles entirely:
// `@nx/enforce-module-boundaries` treats a library lazy-loaded ANYWHERE as
// lazy-loaded everywhere, so one `require('@stxapps/shared')` here turned every
// static import of it across this app into a lint error — 46 of them, the first
// time this file tried it. What static imports cost is that the vector constant
// ships: ~1 KB of data whose own header says it is a test fixture and not a
// secret. That is the trade, made knowingly.
export default function ContractVectors() {
  if (!__DEV__) return <Redirect href="/" />;
  return <ContractVectorsRunner />;
}

interface Check {
  name: string;
  status: 'running' | 'pass' | 'fail';
  detail?: string;
}

function ContractVectorsRunner() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const door = {
        wrappedDek: hexToBytes(V.passwordDoor.wrappedDekHex),
        iv: hexToBytes(V.passwordDoor.ivHex),
      };
      const recoveryDoor = {
        wrappedDek: hexToBytes(V.recovery.wrappedDekHex),
        iv: hexToBytes(V.recovery.ivHex),
      };

      // Each entry asserts by throwing, so a check that forgets to compare
      // cannot report a pass. Ordered cheapest first, so a salt or param-mapping
      // break shows before the ~seconds of Argon2id.
      const cases: { name: string; run: () => Promise<void> }[] = [
        {
          name: 'salt',
          run: async () => {
            expectHex(bytesToHex(deriveUserSalt(V.username)), V.saltHex);
          },
        },
        {
          // The one that needs a device: quick-crypto's native Argon2id at the
          // frozen params, not hash-wasm standing in for it.
          name: 'argon2id-kek',
          run: async () => {
            const kek = await deriveArgon2Hash(V.password, deriveUserSalt(V.username));
            expectHex(bytesToHex(kek), V.kekHex);
          },
        },
        {
          name: 'password-door',
          run: async () => {
            const account = await unlockAccount(V.username, V.password, door);
            expectHex(account.publicKey, V.publicKeyHex);
            expectHex(bytesToHex(account.encryptionKey), V.encryptionKeyHex);
            expectHex(await account.sign(V.signPayload), V.signatureHex);
          },
        },
        {
          name: 'recovery-door',
          run: async () => {
            const account = await unlockAccountWithRecovery(V.recovery.code, recoveryDoor);
            expectHex(account.publicKey, V.publicKeyHex);
          },
        },
        {
          // Hermes's String.prototype.normalize, which goes through a different
          // library on iOS than on Android — and through neither under jest.
          // A row that differs here is a password that derives another key on
          // this platform than the same keystrokes do everywhere else.
          name: 'password-canonical',
          run: async () => {
            for (const { input, utf8Hex } of V.passwordCanonical) {
              const actual = bytesToHex(utf8(canonicalizePassword(codePointsToString(input))));
              if (actual !== utf8Hex)
                throw new Error(`${input}: expected ${utf8Hex}, got ${actual}`);
            }
          },
        },
        {
          // The v1 frame through the real framer — the same bytes the Swift and
          // Kotlin BlobFrame suites open, here through quick-crypto's AES-GCM
          // with the path as AAD: it opens under its path, and under no other.
          name: 'blob-frame',
          run: async () => {
            const key = hexToBytes(V.encryptionKeyHex);
            const packed = hexToBytes(V.blob.packedHex);
            if (packed[0] !== BLOB_FORMAT_V1) throw new Error(`format byte ${packed[0]}`);
            const text = new TextDecoder().decode(await decryptEntity(key, packed, V.blob.path));
            if (text !== V.blob.plaintext) throw new Error(`plaintext ${text}`);
            const opened = await decryptEntity(key, packed, 'links/other.enc').then(
              () => true,
              () => false,
            );
            if (opened) throw new Error('opened under another path');
          },
        },
      ];

      if (!cancelled) {
        setChecks(cases.map(({ name }) => ({ name, status: 'running' })));
      }

      for (const { name, run } of cases) {
        let result: Check;
        try {
          await run();
          result = { name, status: 'pass' };
        } catch (error) {
          result = {
            name,
            status: 'fail',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        if (cancelled) return;
        setChecks((prev) => prev.map((check) => (check.name === name ? result : check)));
      }

      if (!cancelled) setDone(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const failed = checks.filter((check) => check.status === 'fail');
  const passed = done && failed.length === 0 && checks.length > 0;

  return (
    <ScrollView className="flex-1 bg-background p-4">
      <Text className="text-lg font-bold text-foreground">crypto contract vectors</Text>

      {checks.map((check) => (
        <View key={check.name} className="flex-row justify-between py-1">
          <Text className="text-foreground">{check.name}</Text>
          <Text testID={`vector-${check.name}`} className="text-foreground">
            {check.status.toUpperCase()}
          </Text>
        </View>
      ))}

      {/* The two markers the Maestro flow binds to. Exactly one ever renders,
          and neither renders while checks are still running — so a flow that
          asserts the pass marker cannot pass by catching the screen early. */}
      {passed ? (
        <Text testID="contract-vectors-pass" className="pt-4 text-foreground">
          ALL VECTORS PASS
        </Text>
      ) : null}
      {done && failed.length > 0 ? (
        <Text testID="contract-vectors-fail" className="pt-4 text-foreground">
          {`FAILED: ${failed.map((check) => `${check.name} (${check.detail})`).join(', ')}`}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function expectHex(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}
