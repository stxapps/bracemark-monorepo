import * as React from 'react';
import { Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Check, Copy } from 'lucide-react-native';

import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';

// The wallet-style "show it once" panel shared by the ceremony's generated
// passphrase and the recovery code — the native port of web-ui's
// components/auth/show-once-secret.tsx (docs/account.md — "present it like a
// wallet seed"): the secret in a monospace box, a Copy button, and an "I've
// saved this" checkbox that gates whatever comes next. There is no server-side
// recovery, so this ceremony is the only moment the secret exists in a form the
// user can save. RN differences: expo-clipboard instead of navigator.clipboard,
// `selectable` on the secret Text instead of select-all, and the whole
// confirm row is a Pressable (no htmlFor label association on native).
export function ShowOnceSecret({
  secret,
  saved,
  onSavedChange,
  label,
  confirmLabel,
  className,
}: {
  secret: string;
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
  // Screen-reader label for the secret box (e.g. "Your passphrase").
  label: string;
  // Text beside the confirm checkbox.
  confirmLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const revertTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (revertTimer.current) clearTimeout(revertTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(secret);
      setCopied(true);
      // Revert the affordance after a beat so it can be copied again.
      if (revertTimer.current) clearTimeout(revertTimer.current);
      revertTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable: leave the button as-is. The secret is visible
      // and selectable, so the user can still copy it by hand.
    }
  };

  return (
    <View className={cn('flex-col gap-3', className)}>
      <View className="flex-row items-stretch gap-2">
        <View
          aria-label={label}
          className="flex-1 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
        >
          <Text selectable className="font-mono text-sm">
            {secret}
          </Text>
        </View>
        <Button
          variant="outline"
          size="icon"
          onPress={copy}
          aria-label={copied ? 'Copied' : 'Copy'}
          className="shrink-0 self-start"
        >
          <Icon as={copied ? Check : Copy} className={cn('size-4', copied && 'text-primary')} />
        </Button>
      </View>

      <Pressable
        onPress={() => onSavedChange(!saved)}
        className="flex-row items-start gap-3 rounded-lg border border-border p-3"
      >
        <Checkbox
          checked={saved}
          onCheckedChange={(v) => onSavedChange(v === true)}
          className="mt-0.5"
        />
        <Text className="flex-1 text-sm">{confirmLabel}</Text>
      </Pressable>
    </View>
  );
}
