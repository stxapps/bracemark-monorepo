'use client';

import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import {
  createAccountSchema,
  type CreateAccountValues,
  recoverySignInSchema,
  type RecoverySignInValues,
  signInSchema,
  type SignInValues,
} from '@stxapps/shared';

// Platform-agnostic form setup so bracemark-web (and future bracemark-expo) share one
// configured form per flow. These hooks own only validation + form state; the
// submit sequence (username uniqueness → client KDF → sign → session) is
// platform-specific and stays in the consuming app's onSubmit handler.

// `username` pre-fills the field — the expired state's resume form, where the
// username is the stored one and locked (docs/sessions.md).
export function useSignInForm(username = ''): UseFormReturn<SignInValues> {
  return useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { username, password: '' },
  });
}

// The other sign-in door. It gets the same treatment as the password one — same
// resolver setup, so the same per-field errors and the same submit-level `root`
// error — rather than the hand-rolled useState pair it used to carry, which is how
// it ended up the only submit in the auth forms that disabled itself on empty
// input with nothing on screen saying why (docs/account.md).
export function useRecoverySignInForm(username = ''): UseFormReturn<RecoverySignInValues> {
  return useForm<RecoverySignInValues>({
    resolver: zodResolver(recoverySignInSchema),
    defaultValues: { username, recoveryCode: '' },
  });
}

export function useCreateAccountForm(): UseFormReturn<CreateAccountValues> {
  return useForm<CreateAccountValues>({
    resolver: zodResolver(createAccountSchema),
    defaultValues: { username: '', password: '' },
  });
}
