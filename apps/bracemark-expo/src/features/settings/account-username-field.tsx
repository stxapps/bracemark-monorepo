import { View } from 'react-native';

import { LockedUsernameInput } from '../../components/locked-username-input';
import { Text } from '../../components/ui/text';

// WHOSE PASSWORD THIS IS, for a password manager: the native counterpart of web-ui's
// `HiddenUsername`, on change password, where saving is the point: the update a
// manager offers afterwards has to go to the right login. ⚠ NOT on recovery code or
// delete account, where the password only proves who you are: named, it was offered
// for saving as the form went away, on delete account for an account already gone
// (docs/password-manager.md, _a password that only proves who you are_).
// A manager reads a login as a PAIR. A password field with nothing beside it leaves
// iOS Passwords and Android autofill guessing which saved login an update belongs
// to, which one to fill, and what to call an entry it offers to save
// (docs/accessibility.md, _what a field tells the browser_).
//
// ⚠ VISIBLE, NOT HIDDEN, and this is the one place the port differs from web. Web
// hides its field with the `hidden` attribute, which a browser's manager still
// reads. Native has nothing like it: on Android a view that isn't laid out is left
// out of the autofill structure. So the field is a real row, which also tells the
// person which account they are changing.
//
// ⚠ ENABLED BUT LOCKED (LockedUsernameInput), NOT `editable={false}`. What it does,
// measured on both platforms (docs/password-manager.md, _naming the account on
// native_):
//   - Android: it is what names the account. The structure the autofill service
//     gets holds it, hinted `username`, ahead of the password, and nothing does
//     without it. `npm run measure:autofill:android` reads that structure. Google
//     Password Manager then offered to update the right login after a change, and
//     offered nothing without the field.
//   - iOS: AutoFill skips a disabled field, so `editable={false}` changed nothing
//     there. Enabled, iOS reads it as the username.
//   - Never on recovery code or delete account (above).
// None of this shows in lint, types or a flow. account-username-field.spec.tsx
// pins the props.
//
// Only for the ACCOUNT's password. A lock password is a secret that isn't this
// app's login (lock-pane.tsx, lock-password-dialog.tsx), and naming the account
// beside it would file it as one.
export function AccountUsernameField({
  username,
  testID,
}: {
  username: string | null;
  testID: string;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium">Username</Text>
      <LockedUsernameInput testID={testID} username={username} />
    </View>
  );
}
