'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { isUpdateRequired, onUpdateRequired } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';

import { reloadPage } from '@/lib/reload-page';

// The update-required state (docs/offline-mode.md, _version skew_). A newer build,
// in another tab, upgraded one of this origin's databases; this tab has already
// let go of it (data/db.ts, data/session-store.ts — without waiting for anyone,
// or the upgrade would hang) and can't read or write it again. Sync has stopped
// (SyncProvider).
//
// A BANNER, not a modal, on purpose: whatever the user was typing stays on screen
// and selectable, so an unsaved draft can be copied out before anything reloads.
// Save can no longer work in this tab — a write against the closed database fails
// and the editor says so — which is why the banner says it first. The tab never
// reloads by itself: reloading is the explicit discard, and it is the user's.
//
// Reloading has one wrinkle: if the newer build's worker is still installed but
// WAITING (it takes over at once — `skipWaiting: true`, sw.ts — but a reload can
// land before its activation finishes), a plain reload would be served the old
// shell again, which would meet the upgraded database again — a loop. So the
// reload first asks a waiting worker to take over.
//
// An alert, not a status: it arrives unasked, but every save the user makes from
// here on fails, and they need to know before the next one.
export function UpdateRequiredBanner() {
  const [required, setRequired] = useState(isUpdateRequired);
  const [reloading, setReloading] = useState(false);
  useEffect(() => onUpdateRequired(() => setRequired(true)), []);

  if (!required) return null;

  const reload = () => {
    setReloading(true);
    void reloadIntoNewBuild();
  };

  return (
    <div className="fixed inset-x-0 top-0 z-50 border-b border-border bg-background pt-safe shadow-sm">
      <div className="flex items-start gap-3 px-4 py-3">
        <RefreshCw className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div role="alert" className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm font-medium">Bracemark was updated in another tab</p>
          <p className="text-sm text-muted-foreground">
            This tab can’t save changes anymore. Copy anything you haven’t saved, then reload to
            continue.
          </p>
        </div>
        <Button size="sm" onClick={reload} disabled={reloading}>
          {reloading ? 'Reloading…' : 'Reload'}
        </Button>
      </div>
    </div>
  );
}

async function reloadIntoNewBuild(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const waiting = registration?.waiting;
    if (waiting) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        });
        waiting.postMessage({ type: 'SKIP_WAITING' });
        // Never strand the button: reload anyway if the handover doesn't report.
        setTimeout(resolve, 3000);
      });
    }
  } finally {
    reloadPage();
  }
}
