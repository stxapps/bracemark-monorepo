'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { flushLocalWrites, hasUnsavedDrafts, useUpdateRequired } from '@stxapps/web-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@stxapps/web-ui/components/ui/alert-dialog';
import { Button } from '@stxapps/web-ui/components/ui/button';

import { pageBuildId, workerHoldsAnotherBuild } from '@/lib/build-id';
import { isChunkLoadError } from '@/lib/chunk-error';
import { reloadPage } from '@/lib/reload-page';

// The "updated, reload" pill (docs/offline-mode.md, _update policy_). The worker
// takes over at once (`skipWaiting: true`, sw.ts), so a tab that was open when a
// new build's worker activated keeps running its old code under the new worker.
// That tab gets this quiet pill; a routine update never reloads anyone by itself.
//
// WHEN it shows: on `controllerchange` — the moment a new worker actually
// controls this page, i.e. completed activation, never merely "a deploy exists" —
// and only when that worker holds a DIFFERENT BUILD from the one this page loaded
// as (lib/build-id.ts). Two takeovers are not updates of this page:
//   - the first installation, which fires `controllerchange` too (clientsClaim) —
//     so the page must already have been controlled when it loaded;
//   - the worker CATCHING UP with the page. A launch after a deploy is handed the
//     new build's page by the network while the old worker is still installed
//     (sw.ts), and the new worker follows seconds later: the page is already what
//     the worker now holds, and a pill there asks for a reload that changes
//     nothing. That was every user's first launch after every deploy, until the
//     comparison.
// Also when the page fails to load one of its own chunks (lib/chunk-error.ts): the
// old build asking the new worker for something it no longer holds, which only
// the new build fixes.
//
// WHAT the reload does: waits for local saves already started to commit
// (flushLocalWrites — a reload right after Save loses nothing), and never
// discards an editor's unsaved work silently — if one is open and dirty
// (useUnsavedDraft), the user either keeps editing or explicitly discards.
//
// The update-required banner (update-required-banner.tsx) outranks it: once a newer
// build has taken the DATABASE, this tab can't save at all, and that banner says so.
export function UpdatePill() {
  const [updated, setUpdated] = useState(false);
  const dbTaken = useUpdateRequired();
  const [confirming, setConfirming] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let controlled = navigator.serviceWorker.controller !== null;
    // Read once, now: later the attribute can name a newer build than the code
    // running (lib/build-id.ts).
    const loadedAs = pageBuildId();
    let cancelled = false;
    const onControllerChange = () => {
      const wasControlled = controlled;
      controlled = true;
      if (!wasControlled) return;
      void workerHoldsAnotherBuild(loadedAs).then((another) => {
        if (another && !cancelled) setUpdated(true);
      });
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) setUpdated(true);
    };
    const onError = (event: ErrorEvent) => {
      if (isChunkLoadError(event.error)) setUpdated(true);
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);

  if (!updated || dbTaken) return null;

  const reload = async () => {
    setReloading(true);
    await flushLocalWrites();
    reloadPage();
  };

  const onReload = () => {
    if (hasUnsavedDrafts()) setConfirming(true);
    else void reload();
  };

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* `bg-popover` under a closed border — the floating-surface pair
            (docs/theme.md, _elevation_), not the page's `bg-background` and not
            `bg-primary`. The page's colour left the pill nothing but its outline
            in dark, where `shadow-md` measures nothing; primary is the fill of a
            surface that IS the button (the links pane's "New updates" pill),
            and this one CONTAINS its button — on primary, Reload would vanish
            into it, and a pill the doc calls quiet would be the loudest thing
            on the page for as long as the tab stays open. */}
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-popover py-1.5 pr-1.5 pl-4 shadow-md">
          <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
          {/* A status, not an alert: nothing is wrong, and it waits for the user. */}
          <p role="status" className="text-sm">
            Bracemark was updated
          </p>
          <Button size="sm" className="rounded-full" onClick={onReload} disabled={reloading}>
            {reloading ? 'Reloading…' : 'Reload'}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle>Reload and discard your changes?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              An editor on this page has changes that aren’t saved yet. Keep editing to save them
              first, then reload — or reload now and lose them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void reload()}>
              Discard and reload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
