// The EXPIRED state's persistent notice — the expo port of bracemark-web's
// `components/sync-paused-notice.tsx` (the canonical doc; docs/sessions.md, _the
// expired state on the client_). The server answered this device's token
// `session_expired` or `session_unknown`: nothing is erased, the library opens,
// reads, edits and exports as it does offline, sync is paused, and this asks for a
// sign-in.
//
// Chrome, not a modal: the whole point of the state is that the library stays
// usable. The words are a polite status (docs/accessibility.md, _what must NOT
// announce_) — the user didn't cause this — so they carry `role="status"` and the
// buttons beside them don't.
//
// Divergences from web: "Sign in to resume" PUSHES the `/resume` modal route
// (a router screen, like `/edit-link`, so the keyboard controller works inside it)
// where web opens a dialog; and the confirm action is a plain destructive Button,
// not AlertDialogAction — the rn-primitives Action closes the root BEFORE its press
// handler runs (link-destroy-confirm.tsx has the same note).

import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { CloudOff } from 'lucide-react-native';

import { useAuth, usePendingChangesCount, useSignOut } from '@stxapps/expo-react';
import { SESSION_COPY } from '@stxapps/react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export function SyncPausedNotice() {
  const { sessionState } = useAuth();
  if (sessionState !== 'expired') return null;

  return (
    <View
      testID="sync-paused-notice"
      className="mx-4 mt-3 flex-row items-start gap-3 rounded-lg border border-border bg-muted/40 p-3"
    >
      <Icon as={CloudOff} className="mt-0.5 size-4 text-muted-foreground" />
      <View className="min-w-0 flex-1 gap-2">
        <Text role="status" className="text-sm font-medium">
          {SESSION_COPY.paused.title}
        </Text>
        <Text className="text-sm text-muted-foreground">{SESSION_COPY.paused.description}</Text>
        <SyncPausedActions />
      </View>
    </View>
  );
}

// The two ways out, shared by the notice and the initial-sync gate:
//   - Sign in to resume: a normal sign-in with the username locked to the stored
//     one; success replaces the token and keeps the local store and its queue.
//   - Use a different account: a SIGN-OUT, which erases this device's copy — so it
//     warns first, with the count of edits that exist nowhere else.
export function SyncPausedActions() {
  const pending = usePendingChangesCount();
  const signOut = useSignOut();
  const [switching, setSwitching] = useState(false);

  return (
    <View className="mt-1 flex-row flex-wrap items-center gap-2">
      <Button size="sm" testID="sync-paused-resume" onPress={() => router.push('/resume')}>
        <Text>{SESSION_COPY.paused.resume}</Text>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        testID="sync-paused-switch-account"
        onPress={() => setSwitching(true)}
      >
        <Text>{SESSION_COPY.paused.switchAccount}</Text>
      </Button>

      <AlertDialog
        open={switching}
        onOpenChange={(open) => !signOut.isPending && setSwitching(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{SESSION_COPY.switchAccount.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {SESSION_COPY.switchAccount.description(pending)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signOut.isPending}>
              <Text>{SESSION_COPY.switchAccount.cancel}</Text>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              testID="sync-paused-switch-confirm"
              disabled={signOut.isPending}
              onPress={() => signOut.mutate()}
            >
              <Text>{signOut.isPending ? 'Signing out…' : SESSION_COPY.switchAccount.confirm}</Text>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </View>
  );
}
