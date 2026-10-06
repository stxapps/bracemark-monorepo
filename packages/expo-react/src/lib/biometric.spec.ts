// Specs for the biometric wrapper. Nothing about this module can be exercised on a device
// from a test — the prompt needs `expo prebuild` and an enrolled biometry — which is exactly
// why the parts that are pure POLICY belong here, because on a device they can only be
// checked by trying to defeat them.
//
// Two of them are security decisions, and both fail OPEN if they regress, silently:
//
//   - `disableDeviceFallback` is deliberate (docs/locks.md). The fallback for a bracemark
//     lock is the app's OWN password field, never the device passcode — that is a different
//     auth factor, and letting it through means anyone who knows the phone PIN opens every
//     lock on the device. Nothing in the app would look different if this flipped.
//   - EVERY failure reads as "not authenticated". A thrown native error resolving to
//     anything truthy would open a lock nobody authenticated for.
//
// And one that fails CLOSED, which is the correct direction but still worth pinning: a
// probe that throws reports "unavailable", so a biometry problem costs the fast path and
// never the password lock underneath.
//
// The capability's LABEL is the third thing here: it is user-facing copy on the settings
// toggle and the prompt, and it is platform-dependent — "Face ID" on iOS is "Face Unlock"
// on Android, which is a naming rule no type checks.

import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { authenticateBiometric, getBiometricCapability } from './biometric';

jest.mock('expo-local-authentication', () => ({
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  supportedAuthenticationTypesAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}));

const mocked = LocalAuthentication as jest.Mocked<typeof LocalAuthentication>;

function device(options: {
  hardware?: boolean;
  enrolled?: boolean;
  types?: number[];
  os?: 'ios' | 'android';
}): void {
  mocked.hasHardwareAsync.mockResolvedValue(options.hardware ?? true);
  mocked.isEnrolledAsync.mockResolvedValue(options.enrolled ?? true);
  mocked.supportedAuthenticationTypesAsync.mockResolvedValue(
    (options.types ?? []) as LocalAuthentication.AuthenticationType[],
  );
  Object.defineProperty(Platform, 'OS', { configurable: true, value: options.os ?? 'ios' });
}

const UNAVAILABLE = { available: false, label: '' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getBiometricCapability', () => {
  // Hardware AND an enrolment: offering biometric on a phone with a sensor nobody has
  // registered a face or finger with produces a prompt that can only ever fail.
  it('is available only when hardware and an enrolment are both present', async () => {
    device({ hardware: true, enrolled: true, types: [2] });
    expect((await getBiometricCapability()).available).toBe(true);

    device({ hardware: false, enrolled: true, types: [2] });
    expect(await getBiometricCapability()).toEqual(UNAVAILABLE);

    device({ hardware: true, enrolled: false, types: [2] });
    expect(await getBiometricCapability()).toEqual(UNAVAILABLE);
  });

  // Skipping the probe when there is nothing to name isn't just tidy — an unavailable
  // device shouldn't be asked what kind of biometry it has.
  it('does not ask what biometry an unusable device has', async () => {
    device({ hardware: false });

    await getBiometricCapability();

    expect(mocked.supportedAuthenticationTypesAsync).not.toHaveBeenCalled();
  });

  // The label is user-facing copy on the toggle and the prompt, and it is genuinely
  // platform-dependent — the same sensor is called two different things.
  it.each([
    ['ios', [2], 'Face ID'],
    ['android', [2], 'Face Unlock'],
    ['ios', [1], 'Touch ID'],
    ['android', [1], 'Fingerprint'],
    ['ios', [3], 'Iris'],
  ] as const)('names %s biometry type %j as %s', async (os, types, label) => {
    device({ os, types: [...types] });

    expect(await getBiometricCapability()).toEqual({ available: true, label });
  });

  // A device reporting several sensors gets the one the user actually meets first — face
  // beats finger, matching how the OS itself presents them.
  it('prefers the face sensor when a device reports several', async () => {
    device({ os: 'ios', types: [1, 2, 3] });

    expect((await getBiometricCapability()).label).toBe('Face ID');
  });

  // Except on Android, where the list is the phone's HARDWARE, not the enrolment, and the
  // OS prompt picks the sensor: a phone with both said "Face Unlock" to a user who had
  // only ever registered a finger. Several sensors there get no specific name.
  it('names no single sensor on an android device that reports several', async () => {
    device({ os: 'android', types: [1, 2] });

    expect((await getBiometricCapability()).label).toBe('Biometrics');
  });

  // An enrolled device whose type list is empty or unrecognized is still usable — it just
  // has no specific name, so the copy stays generic rather than blank.
  it('falls back to a generic name rather than an empty one', async () => {
    device({ types: [] });

    expect(await getBiometricCapability()).toEqual({ available: true, label: 'Biometrics' });
  });

  // Fails CLOSED: a biometry problem costs the fast path, never the password lock
  // underneath.
  it('reports unavailable when the probe itself throws', async () => {
    device({});
    mocked.hasHardwareAsync.mockRejectedValue(new Error('module not linked'));

    expect(await getBiometricCapability()).toEqual(UNAVAILABLE);
  });
});

describe('authenticateBiometric', () => {
  it('reports success only when the enrolled user authenticated', async () => {
    mocked.authenticateAsync.mockResolvedValue({ success: true });
    expect(await authenticateBiometric('Unlock Bracemark')).toBe(true);

    mocked.authenticateAsync.mockResolvedValue({
      success: false,
      error: 'user_cancel',
    } as never);
    expect(await authenticateBiometric('Unlock Bracemark')).toBe(false);
  });

  // THE SECURITY DECISION. Without this, the device passcode opens every bracemark lock —
  // a different auth factor entirely, and one many more people know. The app would look
  // and behave identically.
  it('refuses the device passcode as a fallback', async () => {
    mocked.authenticateAsync.mockResolvedValue({ success: true });

    await authenticateBiometric('Unlock Bracemark');

    expect(mocked.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ disableDeviceFallback: true }),
    );
  });

  it('shows the caller’s prompt message', async () => {
    mocked.authenticateAsync.mockResolvedValue({ success: true });

    await authenticateBiometric('Unlock Reading');

    expect(mocked.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: 'Unlock Reading' }),
    );
  });

  // A thrown native error must read as NOT authenticated. Any other resolution opens a
  // lock nobody authenticated for — the one failure direction this wrapper cannot take.
  it('treats a native failure as not authenticated', async () => {
    mocked.authenticateAsync.mockRejectedValue(new Error('biometry lockout'));

    expect(await authenticateBiometric('Unlock Bracemark')).toBe(false);
  });
});
