// Whether the links section is covered by another screen, for its LiveReadPause
// (app/(app)/links/_layout.tsx, and @stxapps/expo-react contexts/live-read-pause.tsx
// for why a pause rather than native-stack's freezeOnBlur).

import { useEffect, useState } from 'react';
import { useNavigation } from 'expo-router';

// The native-stack events a route receives. Called from the links layout,
// `useNavigation()` is the (app) stack's navigation for the `links` route, because
// the layout sits outside its own Drawer. The transition events are typed on
// native-stack's navigation prop, which this app doesn't depend on, so the ones
// used are declared here.
interface TransitionEvents {
  addListener(
    type: 'transitionStart' | 'transitionEnd',
    callback: (event: { data: { closing: boolean } }) => void,
  ): () => void;
  addListener(type: 'focus', callback: () => void): () => void;
}

// True from the moment this route has DISAPPEARED under another screen until it
// starts to reappear. Keyed on the native disappear and appear, not on focus:
//
//  - A card push (Settings) makes the route disappear, so it pauses once the
//    push has finished, not while its own slide-out is still on screen.
//  - A presentation that leaves the links screen showing behind it (an iOS
//    pageSheet — `resume`, as the link editor once was) never makes it
//    disappear, so it keeps updating. The in-app sheets (add, edit, Advanced
//    Search — components/ui/sheet.tsx) are not routes at all: they are drawn
//    inside the links section, so they cannot pause it.
//  - It resumes at `transitionStart` with `closing: false`, which fires when a
//    pop or a back-swipe begins, so the reveal already shows the screen
//    catching up. A cancelled swipe ends with the route disappearing again,
//    which pauses it again.
//  - `focus` also resumes, in case a route ever regains focus with no appear
//    event before it.
export function usePausedWhileCovered(): boolean {
  const navigation = useNavigation() as unknown as TransitionEvents;
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const offEnd = navigation.addListener('transitionEnd', ({ data }) => {
      if (data.closing) setPaused(true);
    });
    const offStart = navigation.addListener('transitionStart', ({ data }) => {
      if (!data.closing) setPaused(false);
    });
    const offFocus = navigation.addListener('focus', () => setPaused(false));
    return () => {
      offEnd();
      offStart();
      offFocus();
    };
  }, [navigation]);
  return paused;
}
