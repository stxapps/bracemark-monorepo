// App-bootstrap global polyfills for the Hermes/Expo runtime. Imported for its
// side effects as the very first line of the root `src/app/_layout.tsx`, so the
// globals exist before any code runs. Keep this module side-effect-only.
//
// Why only atob/btoa: of the byte-encoding globals `@stxapps/shared` reaches for
// (see packages/shared/src/crypto/encoding.ts), Hermes/Expo already provides all
// but these two — `TextEncoder` is built into Hermes and `TextDecoder` is
// installed by Expo's winter runtime (node_modules/expo/src/winter/runtime.native.ts),
// but that runtime installs *neither* `atob` nor `btoa`, and Hermes ships neither
// itself. So `base64ToBytes`/`bytesToBase64` (which call the `atob`/`btoa`
// globals) throw `ReferenceError` on native until we install them here.
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
