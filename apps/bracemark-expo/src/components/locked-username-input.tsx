import { useState } from 'react';
import { View } from 'react-native';

import { Input } from './ui/input';

// A USERNAME A PASSWORD MANAGER CAN READ AND A PERSON CANNOT CHANGE: the account's
// name beside a password field, so iOS Passwords and Android autofill know whose
// password it is. Used by the welcome's check (welcome-gate.tsx) and the Account
// views (features/settings/account-username-field.tsx).
//
// ⚠ ENABLED, NOT `editable={false}`. React Native's `editable={false}` is a disabled
// UITextField, and iOS AutoFill skips a disabled field: with it, iOS behaved as if
// there were no username at all, and so never offered to save a new account's
// password, not at create account and not when the welcome's check passed. With the
// field enabled, the check raised "Save Password?" as it passed, which is the one
// save the one-step create account exists to give (docs/password-manager.md, _the
// iOS app_). Nothing reports a regression: no lint, no type error, no flow.
//
// So it is locked by other means, all of them needed:
//   - no touches reach it (`pointerEvents: 'none'`), so a tap cannot focus it;
//   - no keyboard and no caret if it gets focus anyway, from VoiceOver or a
//     hardware keyboard's Tab (`showSoftInputOnFocus`, `caretHidden`), and no
//     edit menu (`contextMenuHidden`);
//   - and if a hardware keyboard edits it all the same, it remounts with the
//     account's name, because a controlled value alone is not re-applied when
//     nothing re-renders.
// `aria-disabled` tells a screen reader it is not for editing ("dimmed" on iOS).
// That is an accessibility trait only; AutoFill still reads the field.
export function LockedUsernameInput({
  username,
  testID,
}: {
  username: string | null;
  testID?: string;
}) {
  const value = username ?? '';
  const [epoch, setEpoch] = useState(0);
  return (
    <View style={{ pointerEvents: 'none' }}>
      <Input
        key={epoch}
        testID={testID}
        // RN has no <label for>: the field is named directly.
        aria-label="Username"
        aria-disabled
        autoComplete="username"
        textContentType="username"
        showSoftInputOnFocus={false}
        caretHidden
        contextMenuHidden
        value={value}
        onChangeText={(text) => {
          if (text !== value) setEpoch((n) => n + 1);
        }}
      />
    </View>
  );
}
