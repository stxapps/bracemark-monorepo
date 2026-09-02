// The JS side of the whole-file crypto boundary. The bytes themselves never
// enter the JS heap — Swift CryptoKit / Kotlin javax.crypto read and write the
// v1 blob frame path-to-path, and NOTHING in this repo tests that native framer
// (it needs a device harness; see the contract-vector file's header). So what is
// testable here is exactly the boundary: what crosses it, and when.
//
// Two things, and both fail silently:
//   - the KEY crosses as HEX, because Hermes has no btoa and hex is already the
//     contract's byte encoding. A hex encoder that dropped a leading zero would
//     hand native a SHORTER key — which fails as "decrypt failed", per file,
//     with nothing pointing at the encoding.
//   - the native module is resolved LAZILY. requireNativeModule throws outside a
//     prebuilt app, so a module-scope resolution would make merely importing
//     @stxapps/expo-crypto throw — in jest, and in any future non-prebuild
//     context. (This spec would be the first casualty, which is the point.)
import { bytesToHex } from '@stxapps/shared';

const mockNative = {
  encryptFile: jest.fn(async () => undefined),
  decryptFile: jest.fn(async () => undefined),
};
// Throws for any other name, the way expo-modules-core does for a module that
// was never registered — so asking for the wrong one fails here, loudly.
const mockRequireNativeModule = jest.fn((name: string) => {
  if (name !== 'BracemarkFileCrypto') throw new Error(`Cannot find native module '${name}'`);
  return mockNative;
});

jest.mock('expo-modules-core', () => ({
  requireNativeModule: (name: string) => mockRequireNativeModule(name),
}));

// A key whose hex is unforgiving: a leading zero byte, a low byte and a high one.
const KEY = new Uint8Array([0x00, 0x0f, 0xff, ...new Array(29).fill(0x42)]);
const KEY_HEX = bytesToHex(KEY);

// The memoized native handle is module-level state, so each test takes a fresh
// copy — otherwise "resolved lazily" is only ever true for the first test to run.
const freshFileCrypto = async () => {
  jest.resetModules();
  jest.clearAllMocks();
  return import('./file-crypto');
};

it('does NOT touch the native runtime at import time', async () => {
  await freshFileCrypto();
  expect(mockRequireNativeModule).not.toHaveBeenCalled();
});

it('resolves BracemarkFileCrypto once, on first use, and reuses it after', async () => {
  const { decryptFile, encryptFile } = await freshFileCrypto();

  await encryptFile('/tmp/a', '/tmp/a.enc', KEY);
  expect(mockRequireNativeModule).toHaveBeenCalledWith('BracemarkFileCrypto');

  await decryptFile('/tmp/a.enc', '/tmp/a', KEY);
  await encryptFile('/tmp/b', '/tmp/b.enc', KEY);
  expect(mockRequireNativeModule).toHaveBeenCalledTimes(1);
});

describe('encryptFile', () => {
  it('hands native the key as full-width hex and the paths untouched', async () => {
    const { encryptFile } = await freshFileCrypto();

    await encryptFile('/var/mobile/files/img.jpg', '/var/mobile/tmp/img.enc', KEY);

    expect(mockNative.encryptFile).toHaveBeenCalledWith(
      '/var/mobile/files/img.jpg',
      '/var/mobile/tmp/img.enc',
      KEY_HEX,
    );
    // 32 bytes → 64 hex chars, with the leading 0x00 spelled '00'.
    expect(KEY_HEX).toHaveLength(64);
    expect(KEY_HEX.startsWith('000fff')).toBe(true);
  });

  it('passes a file:// URI through as-is (the native side normalizes)', async () => {
    // expo-file-system hands out URIs, not paths; stripping or re-encoding the
    // scheme here would duplicate work the native side already does — and get it
    // wrong for anything with a space in it.
    const { encryptFile } = await freshFileCrypto();

    await encryptFile('file:///var/mobile/a%20b.jpg', 'file:///var/mobile/a%20b.enc', KEY);

    expect(mockNative.encryptFile).toHaveBeenCalledWith(
      'file:///var/mobile/a%20b.jpg',
      'file:///var/mobile/a%20b.enc',
      KEY_HEX,
    );
  });

  it('propagates a native failure to the caller', async () => {
    // The upload path has to know the temp .enc was never written; swallowing
    // this would PUT a missing or partial file.
    const { encryptFile } = await freshFileCrypto();
    mockNative.encryptFile.mockRejectedValueOnce(new Error('no such file'));

    await expect(encryptFile('/tmp/missing', '/tmp/out.enc', KEY)).rejects.toThrow('no such file');
  });
});

describe('decryptFile', () => {
  it('hands native the key as full-width hex and the paths untouched', async () => {
    const { decryptFile } = await freshFileCrypto();

    await decryptFile('/var/mobile/tmp/img.enc', '/var/mobile/files/img.jpg', KEY);

    expect(mockNative.decryptFile).toHaveBeenCalledWith(
      '/var/mobile/tmp/img.enc',
      '/var/mobile/files/img.jpg',
      KEY_HEX,
    );
  });

  it('propagates a failed tag to the caller', async () => {
    // A failed GCM tag on a downloaded blob is the whole reason the native side
    // writes to a temp file and renames: the caller must see the rejection and
    // treat the download as failed, never the half-written plaintext.
    const { decryptFile } = await freshFileCrypto();
    mockNative.decryptFile.mockRejectedValueOnce(new Error('authentication failed'));

    await expect(decryptFile('/tmp/in.enc', '/tmp/out.jpg', KEY)).rejects.toThrow(
      'authentication failed',
    );
  });
});
