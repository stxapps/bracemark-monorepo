// The content box of a scroller whose ANCESTOR claims touches. Without it, on
// iOS a drag that starts on anything in the scroller that claims no touch of its
// own (a field label, a hint, an alert's description, the gap between two rows)
// does not scroll at all.
//
// How it happens: React Native's responder negotiation bubbles an unclaimed
// touch up from the view under the finger to the first ancestor that wants it.
// In this app that ancestor is often a claimant wrapped AROUND the scroller:
// the in-app sheet's panel (ui/sheet.tsx), DialogContent (@rn-primitives'
// native Content answers `onStartShouldSetResponder` with true), the
// AlertDialog's overlay Pressable (ui/alert-dialog.tsx), the share sheet's frame
// (features/share/share-kit.tsx). Each claims those touches for a good reason.
// But Fabric's iOS scroll view refuses to scroll while ANY ancestor is the JS
// responder (`RCTScrollViewComponentView`'s `_shouldDisableScrollInteraction`,
// answered from `touchesShouldCancelInContentView:`), so the drag is dead. A
// drag that starts on an Input or a row Pressable scrolls, because that control
// claims the touch itself from BELOW the scroller. Two more things make the bug
// easy to miss:
//
//   - With the keyboard up a `keyboardShouldPersistTaps="handled"` ScrollView
//     claims those touches itself, so it only shows with the keyboard down.
//   - Android's scroller ignores the JS responder, so it is iOS-only.
//
// So this claims them first, from INSIDE the scroller. It is a responder that is
// a descendant of the scroll view, the same position an Input is in, so the
// scroll view takes over the drag as usual. A plain tap that ends here drops the
// keyboard, which is the job the ancestor's claim (or the `handled`
// ScrollView's) did before this one existed. `accessible={false}`, because as a
// focus stop it would hide the whole body behind one unlabelled element
// (docs/accessibility.md, _modality_). `android_disableSound`, because a tap on
// blank form is not a press.
//
// RULE: a scroller inside a touch-claiming ancestor wraps its content in this.
// Nothing reports the omission. It type-checks and lints, and the only symptom
// is an iOS drag that does nothing (docs/soft-keyboard.md, _the traps_). The
// existing hosts pin the structure in their specs through
// `testing/scroll-claim.ts`'s `touchClaim`; a new host should too.

import type { Ref } from 'react';
import { Keyboard, Pressable, type PressableProps, type View } from 'react-native';

export function ScrollClaim({ ref, ...props }: PressableProps & { ref?: Ref<View> }) {
  return (
    <Pressable
      ref={ref}
      accessible={false}
      android_disableSound
      onPress={Keyboard.dismiss}
      {...props}
    />
  );
}
