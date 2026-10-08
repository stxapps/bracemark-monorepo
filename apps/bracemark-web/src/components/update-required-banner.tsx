'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { useUpdateRequired } from '@stxapps/web-react';
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
//
// ABOVE THE MODAL LAYER, AND THAT TAKES TWO CLASSES. The moment this banner is
// for is an unsaved draft, which is the moment a dialog is open — and at the
// dialogs' own `z-50` the two were ordered by nothing but which mounted last
// (a portal and this bar are both appended to `body`). A banner that arrived
// under an open editor painted over it; an editor opened under the banner
// buried it behind the blurred `bg-black/80` overlay, unreadable. `z-60` settles
// the order. `pointer-events-auto` is the half that fails silently without it:
// a modal Radix dialog sets `pointer-events: none` on `body`, this bar inherits
// it, and a press on Reload fell THROUGH to the overlay — an outside-click,
// which closes a clean dialog and is swallowed by a dirty one's guard, and in
// neither case reloads. Both orders driven in a browser: Reload reloads.
//
// Two costs, taken deliberately. The bar covers the top of a tall dialog, its ✕
// included (53px of the edit dialog at 1280 wide; 86 at 390, where this text
// wraps to 129px) — Cancel stays reachable, and the tab can no longer save
// whatever is behind that header anyway. And a dialog opened AFTER the banner
// marks it `aria-hidden` along with everything else outside itself, so until
// that dialog closes a screen reader cannot reach Reload; the alert itself was
// announced when it mounted. The pill (update-pill.tsx) stays at `z-40`, under
// the dialogs, on purpose: it is optional and returns when the dialog closes.
//
// `bg-popover`, not the page's `bg-background`: this bar is `fixed` OVER the
// topbar rather than being one — the frames under it are `h-dvh`, so a bar in
// the flow would push them off screen — and above the modal layer it is the
// top-most surface in the app, lying on `bg-popover` dialogs. In the page's
// colour it was darker than the dialog beneath it, and over the page alone it
// had the topbar's own fill and hairline, with `shadow-sm` measuring nothing in
// dark (docs/theme.md, _elevation_). Not `bg-primary` either, for
// update-pill.tsx's reason: the surface contains its primary button.
export function UpdateRequiredBanner() {
  const required = useUpdateRequired();
  const [reloading, setReloading] = useState(false);

  if (!required) return null;

  const reload = () => {
    setReloading(true);
    void reloadIntoNewBuild();
  };

  return (
    <div className="pointer-events-auto fixed inset-x-0 top-0 z-60 border-b border-border bg-popover pt-safe shadow-sm">
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
