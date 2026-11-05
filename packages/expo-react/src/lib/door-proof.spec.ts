import { WrongPasswordError, WrongRecoveryCodeError } from '@stxapps/expo-crypto';

import { InvalidCredentialsError } from '../hooks/use-sign-in';
import { InvalidRecoveryCodeError } from '../hooks/use-sign-in-with-recovery';
import { mapOpenError } from './door-proof';

// THE REAL CLASSES, which hooks/use-change-password.spec.tsx cannot use: it mocks
// @stxapps/expo-crypto whole, and its stand-ins carried the `name` the real classes
// lacked. `mapOpenError` matches on `name`, and for as long as the crypto package's
// errors inherited Error's "Error", a wrong current password in Settings and a
// recovery code that had been replaced both read "Could not change your password.
// Please try again." — the generic retry, for an input no retry would fix. Found by
// WEB-ACCOUNT-008, the stale code half.
//
// The package's native crypto is stubbed: only the two error classes are wanted, and
// react-native-quick-crypto throws at import without its TurboModule.
// The sign-in hooks that define the form-facing errors reach expo-sqlite and the
// session store, which need a native runtime too; those errors are stand-ins, as in
// hooks/use-change-password.spec.tsx.
jest.mock('react-native-quick-crypto', () => ({}));
jest.mock('../hooks/use-sign-in', () => ({ InvalidCredentialsError: class extends Error {} }));
jest.mock('../hooks/use-sign-in-with-recovery', () => ({
  InvalidRecoveryCodeError: class extends Error {},
}));
describe('mapOpenError', () => {
  it('reads a wrong password as the form’s credential miss', () => {
    expect(() => mapOpenError(new WrongPasswordError('Invalid password'))).toThrow(
      InvalidCredentialsError,
    );
  });

  it('reads a wrong or replaced recovery code as the recovery miss', () => {
    expect(() => mapOpenError(new WrongRecoveryCodeError('Invalid recovery code'))).toThrow(
      InvalidRecoveryCodeError,
    );
  });

  it('passes anything else through untouched', () => {
    const other = new Error('worker died');
    expect(() => mapOpenError(other)).toThrow(other);
  });
});
