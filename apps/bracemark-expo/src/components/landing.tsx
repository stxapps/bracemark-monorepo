import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link } from 'expo-router';
import { withUniwind } from 'uniwind';

import { BRAND } from '@stxapps/shared';

import { Button } from './ui/button';
import { Text } from './ui/text';
import { BrandLockup } from './brand-lockup';

// The public landing UI. Presentational, and kept OUT of `src/app/` so its spec
// can sit beside it — every file under the app root becomes a route. The route
// that renders it (`src/app/index.tsx`) owns the navigation concerns (the authed
// redirect); this component just renders. Its CTAs deep-link into the `(auth)`
// group, which adds no URL segment, so the hrefs are `/create-account` /
// `/sign-in`.
//
// Its web counterpart is bracemark-site's hero on the marketing apex, NOT
// bracemark-web's `/`, which is a bare redirect (docs/hosting.md). A native app
// can't hand off to a website for its first screen, so this landing ships in the
// binary — and it inherits that page's design rule verbatim: ACHROMATIC, AND IT
// SHOWS ALMOST NOTHING, because "the server can't read your library" is easier to
// feel on a screen that does the same. What was here before — a wordmark over "Save links
// to visit later." — said what a hundred bookmark apps say, in raw
// `gray-900`/`gray-950` palette values that ignored the token set the rest of the
// app is built on (and, being blue-tinted, disagreed with the neutral card the
// next screen shows).
//
// THE HIERARCHY IS THE POINT, and the NAME does not
// tell anyone what this is, so the name stays at lockup scale and the TAGLINE
// gets the hero weight. The tagline's one weakness is that "can't read" can momentarily parse
// as broken rather than blind — which is why the slogan sits under it as the
// sign-off rather than anywhere else on the screen: the two lines resolve each
// other, and docs/brand-assets.md says the tagline is safest exactly where supporting copy
// does that immediately.
//
// All three lines come from `BRAND` (shared `brand/brand.ts`) rather than
// being typed here. That file exists because five consoles and three apps have to
// agree on them, and this screen is a store screenshot's worth of surface — a
// hand-typed variant would ship to a storefront and disagree with the listing
// beside it.

// Core host components (View, Text) accept `className` directly; SafeAreaView is
// a composite component, so Uniwind's HOC is needed to bridge className→style.
const StyledSafeAreaView = withUniwind(SafeAreaView);

export function Landing() {
  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center px-6">
        {/* `max-w-md`, one step wider than the auth screens' `max-w-sm`, and it
            only binds on a tablet or a phone on its side (a phone's column is
            already narrower). There is no card here to draw the column's edge,
            and at 384 the `text-3xl` tagline broke into three ragged lines — a
            thin strip down the middle of a tablet. 448 gives it two. The type
            stays unprefixed: a `text-*` under a breakpoint makes
            `testing/line-budget.ts` phone-only (docs/safe-area.md). */}
        <View className="w-full max-w-md gap-8 self-center">
          <BrandLockup testID="heading" />

          <Text
            role="heading"
            aria-level="1"
            className="text-3xl leading-tight font-semibold tracking-tight"
          >
            {BRAND.tagline}
          </Text>

          {/* Full-width buttons, stacked — the native idiom, and the one place
              this screen has any weight at all. "Get started" rather than
              "Create account" matches the marketing site's hero CTA, which is
              this screen's counterpart; the alt-action rule (name the link for
              the screen it opens) governs the doors BETWEEN the two auth
              screens, not the conversion CTA into them. */}
          <View className="gap-3">
            <Link href="/create-account" asChild>
              <Button size="lg">
                <Text>Get started</Text>
              </Button>
            </Link>
            <Link href="/sign-in" asChild>
              <Button size="lg" variant="outline">
                <Text>Sign in</Text>
              </Button>
            </Link>
          </View>
        </View>
      </View>

      {/* The sign-off, docked at the foot rather than sitting in the column
          above: it is the belief behind the tagline, not another selling line,
          and it earns its place by resolving the tagline's momentary "…is it
          broken?" reading from a step away. */}
      <View className="px-6 pb-8">
        <Text className="max-w-md self-center text-center text-xs leading-5 text-muted-foreground">
          {BRAND.slogan}
        </Text>
      </View>
    </StyledSafeAreaView>
  );
}
