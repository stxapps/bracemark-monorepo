import { WrongPasswordError, WrongRecoveryCodeError } from '@stxapps/web-crypto';

import { mapOpenError } from './use-change-password';
import { InvalidCredentialsError } from './use-sign-in';
import { InvalidRecoveryCodeError } from './use-sign-in-with-recovery';

// THE REAL CLASSES, which use-change-password.spec.tsx cannot use: it mocks
// @stxapps/web-crypto whole, and its stand-ins carried the `name` the real classes
// lacked. `mapOpenError` matches on `name`, and for as long as the crypto package's
// errors inherited Error's "Error", a wrong current password in Settings and a
// recovery code that had been replaced both read "Could not change your password.
// Please try again." — the generic retry, for an input no retry would fix. Found by
// WEB-ACCOUNT-008, the stale code half.
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
