// A thin wrapper over expo-local-authentication for the lock provider — the
// device-biometric (Face ID / Touch ID / Android BiometricPrompt) fast-path for
// the device-local app/list locks (docs/locks.md). Kept as its own peer-dep-
// backed lib (the image.ts pattern) so the provider stays clean and jest
// mocks ONE module.
//
// The model is deliberately a BOOLEAN GATE, not a released secret (docs/locks.md
// — "biometric is a boolean gate"): a lock guards already-decrypted data and
// derives no key, so biometric success just flips the same in-memory unlock a
// password would — nothing is stored behind the biometry. This wrapper therefore
// only ever answers "did the enrolled user authenticate?" and "is biometry
// usable on this device?"; the provider owns what that unlocks.
//
// `expo-local-authentication` is a peerDependency (the app owns it so Expo
// autolinking sees it) and a native module — it needs `expo prebuild` and a real
// device/simulator with an enrolled biometry; jest/Metro can't exercise the
// prompt.

import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

export interface BiometricCapability {
  // Hardware present AND a biometry enrolled — the gate for offering biometric
  // at all (the settings toggles, the LockPane prompt).
  available: boolean;
  // A user-facing name for the enrolled biometry, for button/prompt copy
  // ("Face ID" / "Touch ID" / "Fingerprint" / "Biometrics"). '' when unavailable.
  label: string;
}

const UNAVAILABLE: BiometricCapability = { available: false, label: '' };

function labelFor(types: LocalAuthentication.AuthenticationType[]): string {
  const { FACIAL_RECOGNITION, FINGERPRINT, IRIS } = LocalAuthentication.AuthenticationType;
  const ios = Platform.OS === 'ios';
  if (types.includes(FACIAL_RECOGNITION)) return ios ? 'Face ID' : 'Face Unlock';
  if (types.includes(FINGERPRINT)) return ios ? 'Touch ID' : 'Fingerprint';
  if (types.includes(IRIS)) return 'Iris';
  return 'Biometrics';
}

// Probe the device once (the provider caches the result). Never throws — any
// failure degrades to "unavailable", so biometry problems only ever cost the
// fast-path, never the password lock underneath.
export async function getBiometricCapability(): Promise<BiometricCapability> {
  try {
    const [hasHardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!hasHardware || !enrolled) return UNAVAILABLE;
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    return { available: true, label: labelFor(types) };
  } catch {
    return UNAVAILABLE;
  }
}

// Run the OS biometric prompt; true = the enrolled user authenticated.
// `disableDeviceFallback` on purpose — the fallback for a bracemark lock is the
// app's OWN password field (LockPane), never the device passcode, which is a
// different auth factor (letting it through would let anyone with the phone PIN
// open every lock). Never throws — a thrown native error reads as "not
// authenticated", so the password path always remains.
export async function authenticateBiometric(promptMessage: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      disableDeviceFallback: true,
      cancelLabel: 'Cancel',
    });
    return result.success;
  } catch {
    return false;
  }
}
