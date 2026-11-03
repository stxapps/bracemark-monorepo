import * as React from 'react';
import { Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Check, Copy } from 'lucide-react-native';

import { FirstLineSlot } from '../../components/first-line-slot';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';

// The wallet-style "show it once" panel for a recovery code — the native port of
// web-ui's components/auth/show-once-secret.tsx (docs/account.md — "present it like a
// wallet seed"): the secret in a monospace box, a Copy button, and, where something
// is still to come, an "I've saved this" checkbox that gates it. The checkbox is
// optional, and only create-account passes it; the web file says why Settings has
// none. There is no server-side recovery, so this is the only moment the code exists
// in a form the user can save. RN differences: expo-clipboard instead of navigator.clipboard,
// `selectable` on the secret Text instead of select-all, the whole confirm row
// is a Pressable (no htmlFor label association on native), and the checkbox sits
// in a FirstLineSlot where web has `mt-0.5` — that margin is rem there and scales
// with the label; here it is dp beside text that scales, right at 1× only.
//
// The row order, the full-width Copy and the `actions` slot above it all carry
// the web file's argument — read the secret → settle on it → copy it → confirm →
// continue, with the controls that change WHICH secret you get placed before the
// one that acts on it. Read that header before moving anything here; the two
// panels are one design rendered twice. Full width earns more on native than it
// does on web, where the icon-only button was also the smallest touch target in
// the ceremony.
export function ShowOnceSecret({
  secret,
  label,
  confirm,
  actions,
  className,
}: {
  secret: string;
  // Screen-reader label for the secret box (e.g. "Your recovery code").
  label: string;
  // The "I've saved it" checkbox: all of it, or none.
  confirm?: {
    saved: boolean;
    onSavedChange: (saved: boolean) => void;
    // Text beside the checkbox.
    label: string;
  };
  // Controls that change which secret is on screen — create-account's Regenerate.
  // Rendered between the secret and Copy. Omit where there is nothing to settle.
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <View className={cn('flex-col gap-3', className)}>
      <View aria-label={label} className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <Text selectable className="font-mono text-sm">
          {secret}
        </Text>
      </View>

      {actions}

      <CopySecretButton secret={secret} />

      {confirm ? (
        <Pressable
          role="checkbox"
          aria-checked={confirm.saved}
          onPress={() => confirm.onSavedChange(!confirm.saved)}
          className="flex-row items-start gap-3 rounded-lg border border-border p-3"
        >
          <FirstLineSlot textClassName="text-sm">
            <Checkbox
              checked={confirm.saved}
              onCheckedChange={(v) => confirm.onSavedChange(v === true)}
            />
          </FirstLineSlot>
          <Text className="flex-1 text-sm">{confirm.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// The copy itself and its "Copied" flash, shared by the two ways Copy is drawn.
function useCopySecret(secret: string) {
  const [copied, setCopied] = React.useState(false);
  const revertTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRevert = () => {
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = null;
  };

  // A new secret invalidates "Copied" — Regenerate is never more than a row away
  // from Copy (above it on the panel, beside it on create-account's step one), so
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

// Full-width and labelled, the web file's argument: on this panel Copy IS the step.
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
// every Copy and Regenerate in create-account is drawn with it, so they can't drift
// apart. `py-1` makes the drawn box 28 at 1×, and SECRET_TEXT_SLOP takes it to 44 —
// `hitSlop`, not a bigger box (docs/accessibility.md, _a 36dp box is not a 44pt
// target_). 8 is the value with nothing pressable nearer than 16; a caller with a
// nearer neighbour takes half that gap instead.
export const SECRET_TEXT_ACTION = 'flex-row items-center gap-1.5 py-1';
export const SECRET_TEXT_SLOP = 8;

// Copy drawn as SECRET_TEXT_ACTION, for create-account's step one, where saving to a
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
