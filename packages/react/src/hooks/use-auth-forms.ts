'use client';

import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import {
  createAccountSchema,
  type CreateAccountValues,
  signInSchema,
  type SignInValues,
} from '@stxapps/shared';

// Platform-agnostic form setup so bracemark-web (and future bracemark-expo) share one
// configured form per flow. These hooks own only validation + form state; the
// submit sequence (username uniqueness → client KDF → sign → session) is
// platform-specific and stays in the consuming app's onSubmit handler.

export function useSignInForm(): UseFormReturn<SignInValues> {
  return useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { username: '', password: '' },
  });
}

export function useCreateAccountForm(): UseFormReturn<CreateAccountValues> {
  return useForm<CreateAccountValues>({
    resolver: zodResolver(createAccountSchema),
    defaultValues: { username: '', password: '' },
  });
}
