'use client';

import type { ReactNode } from 'react';

import { useLocks } from '@stxapps/web-react';

import { LockPane } from './lock-pane';

// Holds the whole signed-in app behind the device-local app lock (Settings →
// Misc). A CONTENT SWAP like InitialSyncGate, not a redirect — and mounted ABOVE
// it in the (app) layout, so the lock screen is the first thing shown (it covers
// even the decrypting screen, and the first sync proceeds behind it: the sync
// providers sit above this gate).
//
// 'checking' — the first locks read (one IndexedDB read) — renders nothing, the
// same no-flash guarantee as InitialSyncGate: a device with no app lock must
// never flash a lock screen, and a locked one must never flash the app.
// Whether the lock is UNLOCKED is in-memory only (lock-provider), so a reload
// always re-engages it.
export function AppLockGate({ children }: { children: ReactNode }) {
  const { status, appLock, unlockApp } = useLocks();

  if (status === 'checking') return null;

  if (appLock.exists && !appLock.unlocked) {
    return (
      // The insets live on this wrapper, not on LockPane's className: the pane
      // roots at `px-6 py-8`, and `safe-area` is a plain `padding` declaration
      // too, so the two would collide on one element (docs/safe-area.md). The
      // wrapper owns the height and the insets; the pane fills what's left.
      // Full-screen only in this gate — the in-pane list-lock caller renders
      // inside the links frame, which already carries its own.
      <div className="flex min-h-dvh flex-col safe-area">
        <LockPane
          className="flex-1"
          title="Bracemark is locked"
          description="Enter your app lock password to continue."
          onUnlock={unlockApp}
        />
      </div>
    );
  }

  return children;
}
