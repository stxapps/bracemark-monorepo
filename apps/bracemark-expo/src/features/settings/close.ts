import { router } from 'expo-router';

// Leaving settings — shared by the topbar's ✕ and the drawer's back arrow, the
// two ways out (topbar.tsx, sidebar.tsx).
//
// IT POPS, IT DOESN'T NAVIGATE. Both exits used to `router.push('/links')`,
// which is a different thing entirely: `links` and `settings` are sibling cards
// in the `(app)` stack, so the links screen is still MOUNTED underneath while
// settings sits on top of it — with its route params, its FlashList scroll
// offset, its whole view state. Pushing built a SECOND links card on top of
// settings, at the default `/links` (My List), and the one the user came from
// stayed buried below with everything they had set up on it. So the trip
// "list → settings → close" silently reset the list, the tag, or the search
// they were on, and every round trip grew the stack by two.
//
// Popping reveals the original screen instead, which restores things no URL
// could carry back — scroll position most visibly.
//
// ONE card, not all of them (`dismiss()` over `dismissAll()`): settings is also
// reachable from the add-link screen (its paywall row), and closing a screen
// should uncover whatever it covered, not unwind the user's whole stack.
//
// The `canDismiss` branch is the cold entry: a deep link, or the paywall
// pushing `/settings/subscription` as the first route of the process. There is
// nothing underneath to uncover then, so this becomes a real navigation —
// `replace`, so the settings screen it leaves isn't a back-gesture destination.
//
// Moving BETWEEN sections doesn't affect any of this: the sections are screens
// of the settings Drawer, so expo-router demotes their `push` to a navigate
// within that navigator (no new card). One `dismiss()` always leaves settings,
// however many sections were visited on the way.
export function closeSettings(): void {
  if (router.canDismiss()) {
    router.dismiss();
    return;
  }
  router.replace('/links');
}
