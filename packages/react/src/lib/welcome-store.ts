'use client';

import { useSyncExternalStore } from 'react';

// THE WELCOME, AND THE ONE PLACE THE NEW PASSWORD IS HELD (docs/account.md, _the
// welcome_). Create-account is one step: it creates the account and signs in, and
// the welcome screen that follows offers what the old ceremony made you do before
// anything existed — a recovery code, a check of the saved password, and a way in.
// Two of those need the password itself: minting a recovery code proves a door
// (useRecoveryCode), and "Forgot your password? Show it again" is the second look for
// someone who saved nothing — who, once signed out, could neither sign in nor, while
// signed in, change the password without proving the one they lost.
//
// So it is held here, in JS memory, for the welcome's lifetime and nothing longer:
// never written to storage, gone on reload, cleared when the welcome finishes and on
// sign-out (both auth providers' `endSession`). A reload therefore skips the welcome;
// Settings → Account's "no recovery code" nudge still covers the code. Module state
// rather than context because the create mutation's `onSuccess` must set it BEFORE
// the session flips the app in, from a hook outside any provider it could reach.

export interface WelcomeCredentials {
  // Canonical. The gate shows only for the account it was begun for.
  username: string;
  password: string;
}

let current: WelcomeCredentials | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function beginWelcome(welcome: WelcomeCredentials): void {
  current = welcome;
  emit();
}

// The password changed during the welcome (the check's "Use this password instead").
// Keeps the held copy the one that opens the account.
export function updateWelcomePassword(password: string): void {
  if (!current) return;
  current = { ...current, password };
  emit();
}

export function endWelcome(): void {
  if (!current) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWelcome(): WelcomeCredentials | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
