import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { PortalHost } from '@rn-primitives/portal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AuthProvider, useQueryManagers } from '@stxapps/expo-react';
import { ApiClientProvider } from '@stxapps/react';

import { ThemeProvider } from '../components/theme-provider';
import { apiClient } from '../lib/api-client';

import '../../global.css';

// The root route. expo-router auto-detects this `src/app` directory as the app
// root (no EXPO_ROUTER_APP_ROOT needed), and `expo-router/entry` (package.json
// `main`) is the native entry — there is no registerRootComponent/index.js.
//
// Inter is embedded natively at build time via the expo-font config plugin
// (app.config.ts), under the family name "Inter" (the file's name table was
// renamed from "Inter Variable" by tools/scripts/rename-inter.py). So `fontFamily:
// 'Inter'` / the `font-sans` utility resolve at first paint on both iOS and
// Android with no runtime load — no useFonts, no splash gate. Single variable
// file, mirroring the web/extension build; the `wght` axis backs the
// font-weight utilities. `global.css` is imported here (once, at the top of the
// app tree) as Uniwind wants.
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
// the `(auth)` GuestGuard, and the landing's future AuthedHomeRedirect all read
// the same `useAuth`. It hydrates the session from secure-store once on mount.
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
// above the screen tree. Last sibling of the Stack so portaled content draws
// on top; inside the providers so it can still read their contexts.
//
// ThemeProvider is the read/apply half of the theme (docs/theme.md): it reads
// the resolved ThemeState from useSettings and applies it via Uniwind. Mounted
// here at the root so it covers every route group (auth + app) — settings read
// from the sqlite singletons, so it needs no account. It also drives
// `Appearance`, so the `<StatusBar style="auto">` above it follows the app
// theme. `useTheme()` (the rendered light/dark) is available to anything below.
const queryClient = new QueryClient();

export default function RootLayout() {
  useQueryManagers();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <ApiClientProvider client={apiClient}>
            <AuthProvider>
              <ThemeProvider>
                <StatusBar style="auto" />
                <Stack screenOptions={{ headerShown: false }} />
                <PortalHost />
              </ThemeProvider>
            </AuthProvider>
          </ApiClientProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
