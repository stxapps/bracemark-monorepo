import { useEffect } from 'react';
import { Pressable } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@stxapps/expo-react';
import { SESSION_COPY } from '@stxapps/react';

import { Text } from '../../components/ui/text';
import { AuthScreen } from './auth-screen';
import { SignInForm } from './sign-in-form';

// "Sign in to resume" — the expired session's way back (docs/sessions.md, _the
// expired state on the client_), presented as a modal over the app (the `/resume`
// route; web opens the same form in a dialog). A normal sign-in, password or
// recovery code, with the username locked to the account whose library is on this
// device. Success replaces the token, keeps everything local — the edits queued
// while sync was paused included — and closes this screen; a failure leaves the
// paused state exactly as it was.
export function ResumeScreen() {
  const { username, sessionState } = useAuth();

  // Resumed (or opened while nothing needed resuming): back to where the user was.
  useEffect(() => {
    if (sessionState === 'expired') return;
    if (router.canGoBack()) router.back();
    else router.replace('/links');
  }, [sessionState]);

  return (
    <AuthScreen
      title={SESSION_COPY.resume.title}
      description={SESSION_COPY.resume.description(username ?? '')}
      footer={
        <Pressable
          testID="resume-cancel"
          role="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/links'))}
          className="mt-4 items-center py-2"
        >
          <Text className="text-center text-sm text-muted-foreground underline">Not now</Text>
        </Pressable>
      }
    >
      {username ? <SignInForm lockedUsername={username} /> : null}
    </AuthScreen>
  );
}
