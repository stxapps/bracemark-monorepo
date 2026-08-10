import { View } from 'react-native';
// Deep-imported, unlike every other lucide call site in the app: the share sheet
// renders this banner, so it sits in the iOS share-extension bundle, where the
// lucide barrel's ~1600 icon modules would be executed on every cold share
// (features/share/share-kit.tsx carries the full reasoning).
import Lock from 'lucide-react-native/icons/lock';

import { PLAN_LABELS } from '@stxapps/shared';

import { Icon } from '../ui/icon';
import { Text } from '../ui/text';

// What a create surface renders INSTEAD of its form once the library is at the
// plan's link cap — the native cousin of web-ui's LinkQuotaBanner (that header
// is canonical: why it replaces the form rather than sitting above it, why the
// cap does NOT route through the paywall dialog — a full library isn't an
// action the user took — and why the copy points at emptying the Trash, not
// deleting links: trashed links still count, see useLinkQuota). The CTA is a
// slot so the host owns its routing (here: dismiss the modal, then push
// /settings/subscription — a screen can't be pushed under an open modal).

export function LinkQuotaBanner({
  count,
  max,
  action,
}: {
  count: number;
  max: number;
  // The upgrade CTA — a button owned by the host screen (its router).
  action: React.ReactNode;
}) {
  return (
    <View className="gap-3">
      <View className="flex-row items-start gap-2 rounded-md bg-muted px-3 py-2">
        <Icon as={Lock} className="mt-0.5 size-3.5 text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-xs text-muted-foreground">
          You’ve saved{' '}
          <Text className="text-xs font-medium text-foreground">
            {count} of {max}
          </Text>{' '}
          links on the {PLAN_LABELS.free} plan. Upgrade to save more — or empty some of the Trash to
          free up room. Everything you’ve saved stays here, and stays syncing.
        </Text>
      </View>
      {action}
    </View>
  );
}
