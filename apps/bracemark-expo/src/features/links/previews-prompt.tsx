// The first-run offer for on-device link previews — the one thing that keeps
// "off by default" honest rather than punitive (docs/link-extraction.md — _expo
// drains in the foreground_: the app should offer the opt-in at the first moment
// it MEANS something, so the honest default costs one tap instead of a settings
// expedition).
//
// It shows on the links screen when all three hold: the extraction mode is still
// the default `saves`, this device hasn't dismissed the offer, and there are
// actually links waiting for a preview. That last condition is the point — a fresh
// account with nothing saved gets no banner, and neither does a library that's
// already fully previewed.
//
// It arms on `saves` SPECIFICALLY, not on "anything below `all`" (entities.ts
// DEVICE_EXTRACTION_MODES): `saves` is the default nobody chose, which is exactly
// what an offer is for, while `off` is a decision the user made — and re-asking
// someone who picked "never contact these sites" is nagging, not onboarding. The
// settings section stays the way back up from `off`.
//
// The count comes from `readRawPendingTitleImageCount` (four index counts, no
// decode, no trash-correction join), not `useExtractionCounts`: the exact tally
// is gated on the drain being ENABLED, which is precisely what this banner exists
// to ask about. Raw pending is a strict over-count, which is the right side to err
// on for a "you have links without previews" prompt — and the read runs ONLY while
// the banner could show, so it costs nothing in steady state.

import { Pressable, View } from 'react-native';
import { Sparkles, X } from 'lucide-react-native';

import {
  readRawPendingTitleImageCount,
  useLiveRead,
  useSettingMutations,
  useSettings,
} from '@stxapps/expo-react';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';

export function PreviewsPrompt() {
  const { deviceExtractionMode, previewsPromptDismissed } = useSettings();
  const { setDeviceExtractionMode, dismissPreviewsPrompt } = useSettingMutations();

  // Inert unless the offer could actually be shown — see the header.
  const armed = deviceExtractionMode === 'saves' && !previewsPromptDismissed;
  const pending =
    useLiveRead(
      () => (armed ? readRawPendingTitleImageCount() : Promise.resolve(0)),
      [armed],
      ['items', 'item_facet_statuses'],
    ) ?? 0;

  if (!armed || pending === 0) return null;

  // Both actions are one-way for this device: turning it on makes the banner's
  // condition false, and so does dismissing. A failed write just leaves the
  // banner up — the settings section is the durable surface for retrying.
  const turnOn = () => {
    void setDeviceExtractionMode('all').catch(() => undefined);
    void dismissPreviewsPrompt().catch(() => undefined);
  };

  return (
    <View className="mx-4 mt-3 flex-row items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
      <Icon as={Sparkles} className="mt-0.5 size-4 text-muted-foreground" />
      <View className="min-w-0 flex-1 gap-2">
        <Text className="text-sm font-medium">
          {pending} link{pending === 1 ? '' : 's'} without a preview
        </Text>
        <Text className="text-sm text-muted-foreground">
          Bracemark can fetch their titles and images on this device. Links you save here are always
          previewed; this covers the ones that arrived from your other devices or an import.
        </Text>
        <View className="flex-row">
          <Button size="sm" variant="outline" onPress={turnOn}>
            <Text>Turn on previews</Text>
          </Button>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        hitSlop={8}
        onPress={() => void dismissPreviewsPrompt().catch(() => undefined)}
      >
        <Icon as={X} className="size-4 text-muted-foreground" />
      </Pressable>
    </View>
  );
}
