import { View } from 'react-native';

import { useStorageReadout } from '@stxapps/react';

import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';

// Settings → Subscription's storage readout — bracemark-web's
// `_subscription/storage-usage.tsx`, drawn natively; change both. What the library
// stores against the ceiling the pricing page publishes, so it appears only
// against a published ceiling and draws nothing while loading, after a failed
// read, or on Free (useStorageReadout, @stxapps/react).
//
// The SENTENCE is the readout and the bar is decoration. ⚠ `aria-hidden` rides a
// wrapping View because only View implements it on RN (docs/accessibility.md,
// _the first-sync counter_). Not the shared ProgressMeter: that is a
// `progressbar` for jobs, and storage is a gauge whose visible text already says
// everything a role would announce.
export function StorageUsage() {
  const readout = useStorageReadout();
  if (!readout) return null;

  return (
    <View className="mt-4" testID="storage-usage">
      <Text className="text-sm font-medium">Storage</Text>
      <Text className="mt-1 text-sm text-muted-foreground tabular-nums">{readout.text}</Text>
      <View aria-hidden className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <View
          className={cn('h-full rounded-full', readout.full ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${readout.fraction * 100}%` }}
        />
      </View>
      <Text className="mt-2 text-xs text-muted-foreground">{readout.note}</Text>
    </View>
  );
}
