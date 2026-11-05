import { View } from 'react-native';

import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { CopySecretButton } from './copy-secret-button';

// The wallet-style "show it once" panel for a recovery code — the native port of
// web-ui's components/auth/show-once-secret.tsx (docs/account.md — "present it like
// a wallet seed"): the secret in a monospace box and a full-width Copy under it
// (copy-secret-button.tsx), no checkbox, because every code it shows is already
// live. RN difference: `selectable` on the secret Text instead of select-all.
export function ShowOnceSecret({
  secret,
  label,
  className,
  testID,
}: {
  secret: string;
  // Screen-reader label for the secret box (e.g. "Your recovery code").
  label: string;
  className?: string;
  // The secret's text, for the e2e flows (docs/e2e.md, _the testID contract_).
  testID?: string;
}) {
  return (
    <View className={cn('flex-col gap-3', className)}>
      <View aria-label={label} className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <Text testID={testID} selectable className="font-mono text-sm">
          {secret}
        </Text>
      </View>

      <CopySecretButton secret={secret} />
    </View>
  );
}
