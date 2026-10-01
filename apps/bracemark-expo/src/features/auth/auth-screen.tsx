import { type ReactNode } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

import { BrandLockup } from '../../components/brand-lockup';
import { DogEaredCard } from '../../components/dog-eared-card';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';

// Shared chrome for the auth screens (/create-account, /sign-in) — the native
// merge of bracemark-web's `(auth)/layout.tsx` (the lockup, the dog-eared card, the
// encryption line) and each page's CardHeader/Content/Footer sections. No nav —
// these screens are intentionally focused. The route group's `_layout.tsx` keeps
// only the GuestGuard + Stack; this component owns the visuals, so it lives
// outside `src/app/` (every file under the app root becomes a route).
//
// THE LOCKUP IS HERE FOR THE SAME REASON WEB'S IS. These two screens are the
// only place in the signed-in app rendered with no drawer, so they are the only
// place it never says its own name — and a native app has no tab title to fall
// back on, which makes the case STRONGER here than on web. Three entry points
// drop a user in mid-flow with nothing else identifying the origin: the landing
// hero's two CTAs, and the share sheet bouncing a not-signed-in save.
//
// The background is `--muted` / `--background`, not a raw palette pair. Web's
// layout carries the argument: `--muted` INVERTS relative to `--card` between
// themes (light muted 0.97 is darker than the card at 1.0; dark muted 0.269 is
// LIGHTER than the card at 0.205), so reusing it in dark would sink the card
// into the page — in dark the page drops to `--background` and the card lifts
// off it instead.
//
// Mobile-only concerns web's layout doesn't have: the scroll view keeps long
// content (the ceremony's recovery step) reachable on small screens, and it's
// keyboard-controller's KeyboardAwareScrollView because the keyboard overlays
// the window on BOTH platforms now — with edge-to-edge (enforced on
// Android 15+) `adjustResize` no longer resizes the window, and RN core only
// emits keyboard events without moving anything. It scrolls the focused field
// clear of the keyboard, frame-synced with the keyboard animation
// (KeyboardProvider lives in the root `_layout.tsx`). `keyboardShouldPersistTaps`
// lets a tap on a button land while the keyboard is up instead of only
// dismissing it.

// Both are composites (not core hosts), so they need Uniwind's HOC to accept
// `className` — which also maps KeyboardAwareScrollView's
// `contentContainerClassName` onto `contentContainerStyle`.
const StyledSafeAreaView = withUniwind(SafeAreaView);
const StyledKeyboardAwareScrollView = withUniwind(KeyboardAwareScrollView);

export function AuthScreen({
  // Both optional, and both asymmetries are deliberate. /sign-in passes a title
  // and no description — a signup has expectations to set, a sign-in just needs
  // to ask. /create-account now passes NEITHER: its form replaces the heading at
  // every step of the ceremony, so the heading is rendered down there by the
  // component that knows the step (see its StepHeader). Omitting the title drops
  // this block entirely rather than leaving an empty one — and with it the `mt-6`
  // that only exists to separate a header from the content below it.
  title,
  description,
  footer,
  children,
}: {
  title?: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <StyledSafeAreaView className="flex-1 bg-muted dark:bg-background">
      <StyledKeyboardAwareScrollView
        contentContainerClassName="grow justify-center px-4 py-12"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        bottomOffset={16}
      >
        <View className="w-full max-w-sm gap-6 self-center">
          <BrandLockup />

          <DogEaredCard>
            {/* The page step (`text-xl font-semibold tracking-tight`), sized UP
                from the card-title default: that default is the SECTION step —
                right for a settings card sitting among five others, wrong here
                where this card is the entire screen. Same step the settings
                sections and the browser extension's options page use — and the
                step create-account's StepHeader matches when it renders the
                heading itself. */}
            {title ? (
              <View className="gap-1.5">
                <Text
                  role="heading"
                  aria-level="1"
                  className="text-xl font-semibold tracking-tight text-card-foreground"
                >
                  {title}
                </Text>
                {description ? (
                  <Text className="text-sm text-muted-foreground">{description}</Text>
                ) : null}
              </View>
            ) : null}

            <View className={cn(title && 'mt-6')}>{children}</View>

            {footer}
          </DogEaredCard>

          {/* Why the account behaves the way it does — no email field, no reset
              link, a password ceremony that insists you save something. Said once
              here, quietly, under both screens, so neither form has to re-argue
              it. Both halves are literal (docs/account.md, "a password-unlocked
              wallet"): the DEK never leaves the device, and the server stores a
              wrapped key it cannot unwrap. Don't inflate this into a marketing
              line — it's load-bearing context for the next thing the user does. */}
          {/* `px-6` matches DogEaredCard's own p-6, putting this line on the same
              text axis as the wordmark and the card's content instead of hanging
              against the card's outer edge — the argument is in bracemark-web's
              `(auth)/layout.tsx`. */}
          <Text className="px-6 text-xs leading-5 text-muted-foreground">
            Your links are encrypted on your device before they sync. Bracemark’s servers never see
            your password.
          </Text>
        </View>
      </StyledKeyboardAwareScrollView>
    </StyledSafeAreaView>
  );
}
