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

import { PAYWALL_COPY, type PaywallFeature } from '@stxapps/react';
import { PLAN_LABELS } from '@stxapps/shared';

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
    // onDismiss may re-show its own surface — which, if that surface is a
    // native window, would cover the Subscription screen — so upgrading drops
    // the callback unfired, honoring onDismiss's "closes without upgrading"
    // contract above.
    setFeature(null);
    dismissRef.current = undefined;
    router.push('/settings/subscription');
  }, [router]);

  const copy = feature ? PAYWALL_COPY[feature] : null;

  return (
    <PaywallContext.Provider value={api}>
      {children}
      {copy && (
        <Dialog open onOpenChange={(open) => !open && close()}>
          <DialogContent testID="paywall" className="w-full max-w-sm">
            <DialogHeader>
              <DialogTitle>
                <Icon as={Lock} className="size-4" /> {copy.title}
              </DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" testID="paywall-dismiss" onPress={close}>
                <Text>Not now</Text>
              </Button>
              <Button testID="paywall-upgrade" onPress={upgrade}>
                <Text>Upgrade to {PLAN_LABELS[copy.plan]}</Text>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PaywallContext.Provider>
  );
}
