// One hoisted upgrade dialog for every action-triggered value-capture gate —
// the expo port of bracemark-web's contexts/paywall-provider.tsx (the canonical
// doc: the ACTION-INTERRUPT pattern, why it's imperative `show(feature)`, and
// the "free users SEE the feature" house style). Divergences here: no
// focus-restore machinery (no DOM focus to hand back on native), and the
// upgrade CTA routes to the Subscription settings section — which on this
// platform shows plan status and where to manage/purchase (docs/iap.md; the
// in-app store checkout arrives with store IAP).

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'expo-router';
import { Lock } from 'lucide-react-native';

import { type AvailablePaidPlan, PLAN_LABELS } from '@stxapps/shared';

import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Icon } from '../components/ui/icon';
import { Text } from '../components/ui/text';

export type PaywallFeature = 'searchEditor' | 'locks' | 'nestedLists';

// title/description per gated feature + the plan that unlocks it — bracemark-web's
// FEATURE_COPY, verbatim. Keep in sync with the entitlement table in
// @stxapps/shared (iap/plans.ts).
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

export function PaywallProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [feature, setFeature] = useState<PaywallFeature | null>(null);
  // The current caller's dismiss callback, held out of state so `show` stays
  // identity-stable (callers put it in dep arrays).
  const dismissRef = useRef<(() => void) | undefined>(undefined);

  const api = useMemo<PaywallApi>(
    () => ({
      show: (f, onDismiss) => {
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

  const upgrade = useCallback(() => {
    // Diverges from web's upgrade button, whose close fires onDismiss on the
    // way out — harmless there because navigating unmounts the caller's
    // surface. Here a push keeps the caller mounted underneath, and a caller's
    // onDismiss may re-show its own surface (the search sheet reopens its
    // native Modal, which would cover the Subscription screen) — so upgrading
    // drops the callback unfired, honoring onDismiss's "closes without
    // upgrading" contract above.
    setFeature(null);
    dismissRef.current = undefined;
    router.push('/settings/subscription');
  }, [router]);

  const copy = feature ? FEATURE_COPY[feature] : null;

  return (
    <PaywallContext.Provider value={api}>
      {children}
      {copy && (
        <Dialog open onOpenChange={(open) => !open && close()}>
          <DialogContent className="w-full max-w-sm">
            <DialogHeader>
              <DialogTitle>
                <Icon as={Lock} className="size-4" /> {copy.title}
              </DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onPress={close}>
                <Text>Not now</Text>
              </Button>
              <Button onPress={upgrade}>
                <Text>Upgrade to {PLAN_LABELS[copy.plan]}</Text>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PaywallContext.Provider>
  );
}
