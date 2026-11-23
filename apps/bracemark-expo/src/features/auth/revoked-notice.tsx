import { View } from 'react-native';
import { LogOut } from 'lucide-react-native';

import { useAuth } from '@stxapps/expo-react';
import { SESSION_COPY } from '@stxapps/react';

import { FirstLineSlot } from '../../components/first-line-slot';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';

// The expo port of bracemark-web's `(auth)/_components/revoked-notice.tsx`, which
// carries the argument: after the server told this device to forget
// (`session_revoked`), /sign-in says why the library is gone — as a BLOCK in the
// paused notice's shape (components/sync-paused-notice.tsx), not as a muted line
// under the heading, where it read as a standing caption and went unread. It sits
// at the top of the card's content, above the form, as on web.
//
// The reason lives in the auth provider's memory, so a relaunch drops it.
// `role="status"` on the Text: the user didn't cause it (docs/accessibility.md,
// _what must NOT announce_), and the role belongs on the Text that holds the
// words, not on a wrapping View (same doc, _the iOS asterisk_).
export function RevokedNotice() {
  const { reason } = useAuth();
  if (reason !== 'revoked') return null;
  return (
    <View
      testID="revoked-notice"
      className="mb-6 flex-row items-start gap-3 rounded-lg border border-border bg-muted/40 p-3"
    >
      <FirstLineSlot textClassName="text-sm">
        <Icon as={LogOut} className="size-4 text-muted-foreground" />
      </FirstLineSlot>
      <Text role="status" className="min-w-0 flex-1 text-sm">
        {SESSION_COPY.revoked}
      </Text>
    </View>
  );
}
