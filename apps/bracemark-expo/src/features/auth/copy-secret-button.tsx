import * as React from 'react';
import { Pressable } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Check, Copy } from 'lucide-react-native';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';

// Copy for a secret, in the two ways it is drawn — the native port of web-ui's
// components/auth/copy-secret-button.tsx, which carries the argument: full-width
// under the recovery code's panel (show-once-secret.tsx) and the new password in
// Settings, and as quiet text on the new-password field (new-password-field.tsx).
// RN difference: expo-clipboard instead of navigator.clipboard.

// The copy itself and its "Copied" flash, shared by the two ways Copy is drawn.
function useCopySecret(secret: string) {
  const [copied, setCopied] = React.useState(false);
  const revertTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRevert = () => {
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = null;
  };

  // A new secret invalidates "Copied" — Regenerate is never more than a row away
  // from Copy on the new-password field, beside it, so
  // without the reset the affordance would go on claiming a secret that is no
  // longer on screen had been saved. Doubles as the unmount cleanup.
  React.useEffect(() => {
    setCopied(false);
    clearRevert();
    return clearRevert;
  }, [secret]);

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(secret);
      setCopied(true);
      // Revert the affordance after a beat so it can be copied again.
      clearRevert();
      revertTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable: leave the button as-is. The secret is visible
      // and selectable, so the user can still copy it by hand.
    }
  };

  return { copied, copy };
}

// Full-width and labelled, the web file's argument: where it is drawn this way, Copy
// IS the step. Full width earns more on native than it does on web, where the
// icon-only button was also the smallest touch target on the screen.
export function CopySecretButton({ secret }: { secret: string }) {
  const { copied, copy } = useCopySecret(secret);
  return (
    <Button variant="outline" onPress={copy} className="w-full">
      <Icon as={copied ? Check : Copy} className={cn('size-4', copied && 'text-primary')} />
      <Text>{copied ? 'Copied' : 'Copy'}</Text>
    </Button>
  );
}

// The quiet text-button look for an action ON a secret, web's SECRET_TEXT_ACTION:
// the new-password field's Copy and Regenerate are drawn with it, so they can't drift
// apart. `py-1` makes the drawn box 28 at 1×, and SECRET_TEXT_SLOP takes it to 44 —
// `hitSlop`, not a bigger box (docs/accessibility.md, _a 36dp box is not a 44pt
// target_). 8 is the value with nothing pressable nearer than 16; a caller with a
// nearer neighbour takes half that gap instead.
export const SECRET_TEXT_ACTION = 'flex-row items-center gap-1.5 py-1';
export const SECRET_TEXT_SLOP = 8;

// Copy drawn as SECRET_TEXT_ACTION, for the new-password field, where saving to a
// password manager is the main path and Copy the fallback (docs/account.md, _creating
// an account_). The check is tinted, as on the full-width button.
export function CopySecretTextButton({ secret }: { secret: string }) {
  const { copied, copy } = useCopySecret(secret);
  return (
    <Pressable
      role="button"
      onPress={copy}
      hitSlop={SECRET_TEXT_SLOP}
      className={SECRET_TEXT_ACTION}
    >
      <Icon
        as={copied ? Check : Copy}
        className={cn('size-3.5', copied ? 'text-primary' : 'text-muted-foreground')}
      />
      <Text className="text-sm text-muted-foreground">{copied ? 'Copied' : 'Copy'}</Text>
    </Pressable>
  );
}
