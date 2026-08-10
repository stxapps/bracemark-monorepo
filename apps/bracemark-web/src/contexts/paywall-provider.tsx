'use client';

// One hoisted upgrade dialog for every action-triggered value-capture gate. Any
// authed surface calls `usePaywall().show(feature)` when a free user reaches for
// a gated action — the provider renders a single Dialog with the feature's copy
// and the CTA to /settings/subscription. The house style
// is "free users SEE the feature": the affordance stays visible and routes here
// on use, rather than being hidden or replaced by a pitch.
//
// This is the ACTION-INTERRUPT pattern (click Search, click "Lock list…"). It is
// NOT for whole-section upsells where the feature IS the page — those keep their
// own inline "See plans" surface (e.g. the extraction section), which has room to
// explain and isn't interrupting a click.
//
// Deliberately imperative (show(feature)) rather than local state per call site,
// since the gate fires from many places and only one dialog is ever open. The
// optional `onDismiss` lets a caller that kept its own UI open underneath (the
// advanced-search popover) restore itself when the user backs out with "Not now".
// The dialog + feature copy live here with the provider — one cohesive unit with a
// single render path, so there's nothing to gain by splitting the dialog into its
// own file.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import Link from 'next/link';

import { type AvailablePaidPlan, PLAN_LABELS } from '@stxapps/shared';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@stxapps/web-ui/components/ui/dialog';

export type PaywallFeature = 'searchEditor' | 'locks' | 'nestedLists';

// title/description per gated feature + the plan that unlocks it. Keep in sync
// with the entitlement table in @stxapps/shared (iap/plans.ts): the plan named
// here must actually grant the feature, and the copy only promises what's live.
const FEATURE_COPY: Record<
  PaywallFeature,
  { plan: AvailablePaidPlan; title: string; description: string }
> = {
  searchEditor: {
    plan: 'plus',
    title: 'Advanced search',
    description:
      'Field-scoped search across URL and title, with multi-list and multi-tag filters, is a Plus feature. Basic word search stays free.',
  },
  // Covers both app lock (Misc) and per-list locks (Lists) — one `locks`
  // entitlement gates them together.
  locks: {
    plan: 'plus',
    title: 'Locks',
    description:
      'Locking the app, or a single list, on this device is a Plus feature. Your links stay end-to-end encrypted on every plan — this is the convenience layer on top.',
  },
  nestedLists: {
    plan: 'plus',
    title: 'Nested lists',
    description:
      'Nesting a list inside another is a Plus feature. Flat lists and tags stay free and fully usable.',
  },
};

type PaywallApi = {
  // Show the paywall for a feature. `onDismiss` (optional) fires when the dialog
  // closes without upgrading — for callers keeping their own surface open behind
  // it, to restore normal behavior.
  show: (feature: PaywallFeature, onDismiss?: () => void) => void;
};

const PaywallContext = createContext<PaywallApi | null>(null);

export function usePaywall(): PaywallApi {
  const ctx = useContext(PaywallContext);
  if (!ctx) throw new Error('usePaywall must be used within <PaywallProvider>');
  return ctx;
}

export function PaywallProvider({ children }: { children: React.ReactNode }) {
  const [feature, setFeature] = useState<PaywallFeature | null>(null);
  // The current caller's dismiss callback, held out of state so `show` stays
  // identity-stable (callers put it in dep arrays).
  const dismissRef = useRef<(() => void) | undefined>(undefined);
  // The element that triggered the gate, so closing can hand focus back to it —
  // see onCloseAutoFocus below.
  const invokerRef = useRef<HTMLElement | null>(null);

  const api = useMemo<PaywallApi>(
    () => ({
      show: (f, onDismiss) => {
        invokerRef.current = document.activeElement as HTMLElement | null;
        dismissRef.current = onDismiss;
        setFeature(f);
      },
    }),
    [],
  );

  const close = useCallback(() => {
    setFeature(null);
    const dismiss = dismissRef.current;
    dismissRef.current = undefined;
    dismiss?.();
  }, []);

  // Radix's modal DialogContent hardcodes close-focus to the DialogTrigger
  // (preventing the usual restore-to-previous), but this dialog is imperative and
  // has no trigger — so its `triggerRef.current?.focus()` no-ops and focus falls to
  // <body>. Restore to the element that called `show` instead: the gate is an
  // interrupt, so backing out belongs where the user pressed (e.g. the advanced
  // popover's Search button, whose query is still sitting there untouched), not
  // nowhere. Our preventDefault short-circuits Radix's branch via
  // composeEventHandlers' checkForDefaultPrevented.
  const onCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
    invokerRef.current?.focus();
    invokerRef.current = null;
  }, []);

  const copy = feature ? FEATURE_COPY[feature] : null;

  return (
    <PaywallContext.Provider value={api}>
      {children}
      {copy && (
        <Dialog open onOpenChange={(open) => !open && close()}>
          <DialogContent className="sm:max-w-sm" onCloseAutoFocus={onCloseAutoFocus}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Lock className="size-4" /> {copy.title}
              </DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Not now
              </Button>
              {/* Upgrade leaves for /settings/subscription, which unmounts the
                  caller's surface anyway — so "close both" needs no extra wiring. */}
              <Button asChild onClick={close}>
                <Link href="/settings/subscription">Upgrade to {PLAN_LABELS[copy.plan]}</Link>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PaywallContext.Provider>
  );
}
