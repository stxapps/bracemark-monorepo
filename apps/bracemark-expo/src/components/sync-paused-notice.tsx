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
// (a router screen, so the keyboard controller works inside it)
// where web opens a dialog; and the confirm action is a plain destructive Button,
// not AlertDialogAction — the rn-primitives Action closes the root BEFORE its press
// handler runs (link-destroy-confirm.tsx has the same note).

import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { CloudOff } from 'lucide-react-native';

import { useAuth, usePendingChangesCount, useSignOut } from '@stxapps/expo-react';
import { SESSION_COPY } from '@stxapps/react';

import { cn } from '../lib/utils';
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
import { FirstLineSlot } from './first-line-slot';

export function SyncPausedNotice() {
  const { sessionState } = useAuth();
  if (sessionState !== 'expired') return null;

  return (
    <View
      testID="sync-paused-notice"
      className="mx-4 mt-3 flex-row items-start gap-3 rounded-lg border border-border bg-muted/40 p-3"
    >
      <FirstLineSlot textClassName="text-sm">
        <Icon as={CloudOff} className="size-4 text-muted-foreground" />
      </FirstLineSlot>
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
//
// STACKED below `sm`, a row from it, with the ghost button pulled `-ml-3` onto
// the text edge while it is stacked — web's classes, and the argument is in web's
// file: a ghost aligns by its label, not by its box, so under the filled button it
// read as indented by its own `px-3`. A LAYOUT step, so it stays a breakpoint
// where the controls' `sm:` height steps did not (ui/input.tsx): every phone held
// upright gets the stack, and a tablet or a phone on its side — 640 and up —
// gets the row, as web does. `align="center"` is the initial-sync
// gate, whose column is centred: there the pair centres and nothing is pulled.
export function SyncPausedActions({ align = 'start' }: { align?: 'start' | 'center' }) {
  const pending = usePendingChangesCount();
  const signOut = useSignOut();
  const [switching, setSwitching] = useState(false);

  return (
    <View
      className={cn(
        'mt-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center',
        align === 'center' ? 'items-center sm:justify-center' : 'items-start',
      )}
    >
      <Button size="sm" testID="sync-paused-resume" onPress={() => router.push('/resume')}>
        <Text>{SESSION_COPY.paused.resume}</Text>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={cn(align === 'start' && '-ml-3 sm:ml-0')}
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
