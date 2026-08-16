// App-bootstrap global polyfills for the Hermes/Expo runtime. Imported for its
// side effects as the very first line of the root `src/app/_layout.tsx`, so the
// globals exist before any code runs. Keep this module side-effect-only.
//
// Why only atob/btoa of the byte encodings: of the byte-encoding globals
// `@stxapps/shared` reaches for (see packages/shared/src/crypto/encoding.ts),
// Hermes/Expo already provides all but these two — `TextEncoder` is built into
// Hermes and `TextDecoder` is installed by Expo's winter runtime
// (node_modules/expo/src/winter/runtime.native.ts), but that runtime installs
// *neither* `atob` nor `btoa`, and Hermes ships neither itself. So
// `base64ToBytes`/`bytesToBase64` (which call the `atob`/`btoa` globals) throw
// `ReferenceError` on native until we install them here.
//
// The `crypto` global is the same story one layer up — see its own note below.
//
// Back them with the NATIVE Buffer (C++, via @craftzdog/react-native-buffer) —
// these carry multi-hundred-KB extractor images, so the pure-JS `base-64` lib's
// per-char loop would jank the JS thread. 'binary' is latin1 — the 1 byte ⇔ 1
// char mapping `atob`/`btoa` are defined over. Guarded so a runtime that ever
// does provide them wins.
import { Buffer } from '@craftzdog/react-native-buffer';

if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (data: string): string => Buffer.from(data, 'binary').toString('base64');
}

if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (data: string): string => Buffer.from(data, 'base64').toString('binary');
}

// `crypto.getRandomValues`: Hermes has NO `crypto` global at all and Expo's
// winter runtime installs none, so every agnostic caller of the standard global
// throws `ReferenceError: Property 'crypto' doesn't exist` on native. Two kinds
// of caller reach it from `@stxapps/shared`: the secrets it mints in platform-
// agnostic code — `generatePassphrase` (crypto/passphrase.ts, the create-account
// default) and `generateRecoveryCode` (crypto/recovery-code.ts) — and
// @noble/hashes' `randomBytes`, which reads `globalThis.crypto` ONCE at module
// init, which is why this must be installed from the entry file rather than
// lazily by the first caller.
//
// Backed by react-native-quick-crypto's native CSPRNG — already a dependency for
// @stxapps/expo-crypto, so this costs no new native module. NOT quick-crypto's
// own `install()`: that assigns the whole module to `global.crypto` AND replaces
// `global.Buffer`, which is a much larger surface than the one method we need.
//
// THE REQUIRE IS LAZY, for the same reason as @stxapps/expo-crypto's `newId`
// (packages/expo-crypto/src/lib/ids.ts, which explains it in full): this module
// is also the first import of index.share.js, and a static import would put
// quick-crypto's ~390KB of JS into the init of the iOS share extension's
// process — re-created on every share — for a global nothing on that path calls.
// Memoized, so after the first call it's a plain function reference.
//
// Deliberately partial — no `subtle`, no `randomUUID` (native ids go through
// expo-crypto's `newId`, which owns its own lazy require). A caller that
// feature-detects either one finds it missing, exactly as it did before.
if (typeof globalThis.crypto === 'undefined') {
  let getRandomValues: typeof import('react-native-quick-crypto').getRandomValues | null = null;

  globalThis.crypto = {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      getRandomValues ??= (
        require('react-native-quick-crypto') as typeof import('react-native-quick-crypto')
      ).getRandomValues;
      // Fills the view in place and hands back that same view, so we can return
      // the caller's `array` and keep `T`. The cast only bridges quick-crypto's
      // narrower `RandomTypedArrays` union to the DOM signature's ArrayBufferView.
      getRandomValues(array as unknown as Uint8Array);
      return array;
    },
  } as typeof globalThis.crypto;
}

// The audit: in DEV, assert the whole ambient contract `@stxapps/shared` and
// `@stxapps/react` are allowed to assume, and fail at BOOT naming what's missing.
//
// The list below is the runtime half of the same contract the agnostic packages
// are held to statically — `webworker` lib + the deny list in
// tools/eslint/agnostic-globals.mjs (which is where each name's story is
// written). Lint refuses a global that ISN'T portable; this refuses a global that
// is SUPPOSED to be portable and turns out to be missing on this engine. A gap
// between those two is exactly what shipped the create-account crash.
//
// Why it's worth ten lines: the failure it replaces is a `ReferenceError` thrown
// from whatever screen happens to touch the API first — three navigations deep,
// blamed on the feature. This one names the API at launch, before any screen
// mounts. It also covers the case no static rule can see: a polyfill that
// regressed, or an Expo/RN upgrade that stops installing one of these (every
// name here that isn't ours comes from Hermes or Expo's winter runtime,
// node_modules/expo/src/winter/runtime.native.ts — none of it is guaranteed by us).
//
// It canNOT see import ORDER: a module that reads `globalThis.crypto` at its own
// init still loses if it evaluates before this file. That's why polyfills.ts is
// the first import of both native entries and not a lazy import somewhere.
//
// __DEV__ is compile-time constant, so Metro drops this whole block from release
// bundles — it costs the share extension's cold boot nothing in production.
if (__DEV__) {
  const missing = [
    'atob',
    'btoa',
    'TextEncoder',
    'TextDecoder',
    'URL',
    'URLSearchParams',
    'structuredClone',
    'fetch',
    'Response',
    'AbortController',
    'setTimeout',
    'queueMicrotask',
  ].filter((name) => typeof (globalThis as Record<string, unknown>)[name] === 'undefined');

  // Checked by member, not by name: the shim above is deliberately partial, so
  // `typeof crypto !== 'undefined'` would pass while the one method we promise
  // is gone.
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    missing.push('crypto.getRandomValues');
  }

  if (missing.length > 0) {
    throw new Error(
      `bracemark-expo: missing ${missing.length === 1 ? 'global' : 'globals'} ${missing.join(', ')} on this engine. ` +
        'Platform-agnostic code (@stxapps/shared, @stxapps/react) assumes these exist — ' +
        'install them in src/polyfills.ts, or stop assuming them (tools/eslint/agnostic-globals.mjs). ' +
        'See docs/expo-native-deps.md, "runtime polyfills".',
    );
  }
}
