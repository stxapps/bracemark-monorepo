import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCSSVariable } from 'uniwind';

import {
  AuthProvider,
  startStallProbe,
  startSyncTrace,
  useQueryManagers,
} from '@stxapps/expo-react';
import { ApiClientProvider } from '@stxapps/react';

import { SplashHold } from '../components/splash-hold';
import { ThemeProvider } from '../contexts/theme-provider';
import { apiClient } from '../lib/api-client';

import '../../global.css';

// The JS-thread stall probe (expo-react lib/stall-probe.ts), in measurement
// bundles only. Metro inlines the flag at build time, and only the measurement
// tool sets it — in Metro's environment, never in an env file
// (e2e/measure/native.ts) — so every other build compiles this to nothing.
if (process.env.EXPO_PUBLIC_MEASURE_STALLS === '1') startStallProbe();

// The sync engine's timing spans (expo-react lib/sync-trace.ts), printed per
// cycle as `[sync-trace]` tables. Same arrangement as the probe above: inlined
// at build time, set only in Metro's environment for a measuring run.
if (process.env.EXPO_PUBLIC_SYNC_TRACE === '1') startSyncTrace();

// The root route. expo-router auto-detects this `src/app` directory as the app
// root (no EXPO_ROUTER_APP_ROOT needed), and `expo-router/entry` (package.json
// `main`) is the native entry — there is no registerRootComponent/index.js.
//
// Inter is embedded natively at build time under the family name "Inter" — by
// the expo-font config plugin on iOS (the file's name table was renamed from
// "Inter Variable" by tools/scripts/rename-inter.py) and by
// plugins/with-android-variable-font.js on Android (app.config.ts). So
// `fontFamily: 'Inter'` / the `font-sans` utility resolve at first paint on both
// iOS and Android with no runtime load — no useFonts, and nothing the splash
// hold below has to wait for. Single variable file, mirroring the web and
// browser-extension builds; the `wght` axis backs the font-weight utilities.
// `global.css` is imported here (once, at the top of the app tree) as Uniwind
// wants.
//
// expo-router mounts a NavigationContainer that already provides a safe-area
// context (react-navigation's SafeAreaProviderCompat), so screens can use
// `SafeAreaView` without an explicit SafeAreaProvider here.
//
// ApiClientProvider hands the shared query/mutation hooks the env-configured
// client (lib/api-client.ts, bound to EXPO_PUBLIC_API_URL) so they don't hardcode
// a baseUrl. It wraps AuthProvider — above every route group — because both the
// `(auth)` public endpoints (username check, sign-in, create-account) and the
// `(app)` SyncProvider read through it; this mirrors bracemark-web's root-level
// ApiClientProvider placement.
//
// AuthProvider wraps the whole Stack (mirroring bracemark-web's root-level placement)
// so one auth state is shared across every route group: the `(app)` AuthGuard,
// the `(auth)` GuestGuard, and the landing's HomeGuard all read the same
// `useAuth`. It hydrates the session from secure-store once on mount.
//
// KeyboardProvider is react-native-keyboard-controller's root: it feeds the
// WindowInsetsAnimation-synced keyboard values that KeyboardAwareScrollView
// (auth screens, future editors) animates from. Needed on both platforms —
// with edge-to-edge (enforced on Android 15+) `adjustResize` no longer resizes
// the window, so Android overlays the keyboard just like iOS. Outermost so any
// screen in any route group can consume keyboard state.
//
// GestureHandlerRootView is react-native-gesture-handler's root, required once
// at the very top of the tree for the links Drawer's swipe gesture
// ((app)/links/_layout.tsx); flex-1 so it doesn't collapse the app to zero
// height. Outermost even around KeyboardProvider — gestures must win the
// responder chain from the first touch.
//
// PortalHost is @rn-primitives/portal's default host: floating primitive
// content (the links topbar's dropdown menu) portals into it so it renders
// above the screen tree. After RootNavigator (the Stack) so portaled content
// draws on top; inside the providers of THIS file so it can still read their
// contexts. Only theirs: the host is above the whole `(app)` layout, and an
// @rn-primitives portal re-parents its children rather than carrying context
// the way a DOM portal does — so portaled content sees no SyncProvider,
// LockProvider or PaywallProvider, nor a links provider. A hook that needs one
// is called on the host side and its result handed in
// (features/links/move-to-dialog.tsx carries the specimen).
//
// ThemeProvider is the read/apply half of the theme (docs/theme.md): it reads
// the resolved ThemeState from useSettings and applies it via Uniwind. Mounted
// here at the root so it covers every route group (auth + app) — settings read
// from the sqlite singletons, so it needs no account. It also drives
// `Appearance`, so the `<StatusBar style="auto">` inside it follows the app
// theme. `useTheme()` (the rendered light/dark) is available to anything below.
//
// SplashHold + `preventAutoHideAsync()` are one mechanism in two places, and the
// call has to be HERE, at module scope: expo-router arms its own auto-hide in a
// `setTimeout` at entry (renderRootComponent) explicitly so an app can get its
// prevent in first, and it then hides one frame after the navigator is ready —
// which is before AuthProvider has read the session back. Preventing it makes
// components/splash-hold.tsx the only thing that hides the splash, on the auth
// decision instead of on the first paintable frame. That file carries the whole
// reasoning; it is mounted under AuthProvider because that is the status it
// reads. docs/theme.md, _per-app wiring_.
SplashScreen.preventAutoHideAsync().catch(() => {
  // Nothing to recover: the worst case is the auto-hide we were trying to
  // outrun, which is exactly the behaviour this app shipped before the hold.
});

const queryClient = new QueryClient();

// The Stack, plus the ONE navigation-theme value the whole app needs. Every
// navigator in the tree (this Stack, `(app)`'s, `(auth)`'s, settings' and the
// links Drawer) reads react-navigation's theme from the nearest provider, and
// with none of our own they all took `DefaultTheme` — whose `colors.background`
// is `rgb(242, 242, 242)`, a light grey that native-stack hands to every screen
// as its default `contentStyle`. That is invisible under a screen that paints its
// own `bg-background`, and it is the ONLY thing on screen whenever one doesn't:
// the null frames of the guards and the gates. In dark mode it read as a flash of
// near-white between the dark splash and a near-black app.
//
// Overriding `background` alone — rather than swapping in `DarkTheme` — is
// deliberate: `card`, `text` and `border` still reach real surfaces (the Drawer
// panel takes `colors.card`), and nothing in this app has ever rendered against
// them, so flipping the whole palette would be a visual change nobody asked for.
// The value comes from `--color-background` through Uniwind rather than a hex
// pair, for the reason ui/switch.tsx gives at length: it is the same token
// `bg-background` resolves to, re-read when `Uniwind.setTheme` fires, so it
// cannot drift from global.css. Missing (jest mocks `uniwind`; an unknown var
// returns undefined) falls back to the stock theme.
function RootNavigator() {
  const background = useCSSVariable('--color-background');
  const navigationTheme = useMemo(() => {
    if (background === undefined) return DefaultTheme;
    // `useCSSVariable` is typed `string | number | undefined` because Uniwind can
    // hand back an already-processed color int on native — RN takes that
    // anywhere a color goes, react-navigation's `Theme` only admits a string.
    return {
      ...DefaultTheme,
      colors: { ...DefaultTheme.colors, background: background as string },
    };
  }, [background]);

  return (
    <NavigationThemeProvider value={navigationTheme}>
      <Stack screenOptions={{ headerShown: false }} />
    </NavigationThemeProvider>
  );
}

export default function RootLayout() {
  useQueryManagers();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <ApiClientProvider client={apiClient}>
            <AuthProvider>
              <SplashHold />
              <ThemeProvider>
                <StatusBar style="auto" />
                <RootNavigator />
                <PortalHost />
              </ThemeProvider>
            </AuthProvider>
          </ApiClientProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
