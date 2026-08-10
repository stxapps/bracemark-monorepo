import { Stack } from 'expo-router';

import { GuestGuard } from '../../components/guest-guard';

// The auth group — `/sign-in`, `/create-account`. A `(group)` adds no URL
// segment (identical semantics to Next.js), so this mirrors bracemark-web's
// `src/app/(auth)`: focused screens with no app navigation.
//
// GuestGuard is now wired: it bounces already-authenticated visitors to `/links`
// (or the `?next=` AuthGuard stashed) — including right after create-account /
// sign-in, once setSession flips auth state. It reads the AuthProvider mounted in
// the root `_layout`.
export default function AuthLayout() {
  return (
    <GuestGuard>
      <Stack screenOptions={{ headerShown: false }} />
    </GuestGuard>
  );
}
