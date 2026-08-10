// The Link previews settings section — the expo port of bracemark-web's
// `(app)/settings/[section]/_extraction/extraction-section.tsx` (that header is
// canonical: a thin controls surface over the provider's drain, with the opt-in
// colocated beside the controls it governs rather than split off into Misc).
// Same three parts — the toggle, the exact facet counts, the full-library
// controls — with three deliberate omissions and one addition:
//
//  - NO PLAN GATE / UPSELL. Web gates server extraction behind a Plus
//    entitlement because it's a paid, abuse-exposed server path; on-device
//    extraction costs the project nothing, so it's free on every plan
//    (docs/link-extraction.md — _expo drains in the foreground_).
//  - NO TWO-STEP CONFIRM on "Generate all". Web confirms because the job can be
//    thousands of PAID requests. Here nothing is billed — so the button acts
//    immediately, and the honest disclosure ("uses your connection") is stated
//    up front instead of interposed as a modal step.
//  - NO `serverExtraction` TOGGLE. Expo never calls bracemark-extractor, so a switch
//    whose effect is invisible on the device holding it would be worse than no
//    switch; the setting is round-tripped for the web clients and never read
//    here (use-setting-mutations).
//  - The control it DOES render is `deviceExtractionMode`, as THREE RADIOS rather
//    than a switch (entities.ts DEVICE_EXTRACTION_MODES). A boolean forced the
//    gestured/un-gestured split into prose — "links saved here are previewed
//    either way, so what this buys is the residual" — which is a lot to ask of a
//    toggle's hint, and left the gestured fetch with no off position at all. One
//    axis of increasing disclosure says the same thing structurally, and gives the
//    user who wants it a real "never contact these sites" (docs/link-extraction.md
//    — _the stance_). Everything below the radios stays bound to `all`: the counts
//    and Generate all describe the full-library drain, which only that position
//    arms.

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Globe, Pause, ShieldOff, Smartphone, Sparkles } from 'lucide-react-native';

import {
  useExtraction,
  useExtractionCounts,
  useSettingMutations,
  useSettings,
} from '@stxapps/expo-react';
import { DEVICE_EXTRACTION_MODES, type DeviceExtractionMode } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { SettingsHeader, SettingsNotice, SettingsPane } from './settings-kit';

// The ladder, as copy. Ordered by DEVICE_EXTRACTION_MODES (increasing disclosure),
// which the radio list maps over — so a mode added to that tuple shows up here as a
// missing key rather than a silently absent row.
const MODE_OPTIONS: Record<
  DeviceExtractionMode,
  { label: string; hint: string; icon: typeof Globe }
> = {
  off: {
    label: 'Off',
    hint: 'Never contact the sites you save. Links still save and sync — they just show their address and a coloured tile instead of a title and picture.',
    icon: ShieldOff,
  },
  saves: {
    label: 'Links you save on this device',
    hint: 'When you save a link here, the app fetches that one page itself to fill in its title and picture. No server of ours ever sees it.',
    icon: Smartphone,
  },
  all: {
    label: 'All links, including synced and imported',
    hint: 'Also fill in links that arrived from your other devices or an import — pages this device hasn’t opened. Each of those sites sees a request from this device.',
    icon: Globe,
  },
};

// A tappable radio row — misc-section's OptionRow, same shape and same rationale
// (the whole row is the target; the primitive Item renders the mark). Duplicated
// rather than hoisted: it's ~20 lines of layout, and the two sections' rows have
// already drifted once (this one has no fixed-width label column). Worth a shared
// component only when a third caller wants exactly this.
function OptionRow({
  value,
  selected,
  onSelect,
  label,
  hint,
  icon,
}: {
  value: string;
  selected: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
  icon: typeof Globe;
}) {
  return (
    <Pressable
      onPress={onSelect}
      aria-checked={selected}
      className={cn(
        'flex-row items-start gap-3 rounded-lg border border-border p-3',
        selected && 'border-primary bg-muted/40',
      )}
    >
      <RadioGroupItem value={value} className="mt-0.5" />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Icon as={icon} className="size-4 text-foreground" />
          <Text className="font-medium">{label}</Text>
        </View>
        <Text className="text-sm text-muted-foreground">{hint}</Text>
      </View>
    </Pressable>
  );
}

// One labelled count in a bordered tile — web's Stat, in RN boxes.
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View className="flex-1 gap-0.5 rounded-lg border border-border p-3">
      <Text className="text-2xl font-semibold tabular-nums">{value}</Text>
      <Text className="text-sm text-muted-foreground">{label}</Text>
    </View>
  );
}

export function ExtractionSection() {
  const { enabled, isRunning, isExtractingAll, autoLimitReached, extractAll, pause } =
    useExtraction();
  const { done: doneCount, pending: pendingCount, failed: failedCount } = useExtractionCounts();

  // The mode itself. `enabled` above is the composite gate (signed in + store ready
  // + mode `all`), so the radios bind to the raw setting — picking one while the
  // store is still opening still persists the preference.
  const { deviceExtractionMode } = useSettings();
  const { setDeviceExtractionMode } = useSettingMutations();

  // Surface a failed write (e.g. no active account) rather than swallowing it;
  // the control stays live for a retry. MiscSection's `run`, verbatim.
  const [error, setError] = useState<string | null>(null);
  const setMode = (next: DeviceExtractionMode) => {
    setError(null);
    void setDeviceExtractionMode(next).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  const total = doneCount + pendingCount + failedCount;

  return (
    <SettingsPane>
      <SettingsHeader
        title="Link previews"
        description="Bracemark fills in each saved link’s title and preview image automatically — you don’t need to do it by hand. The work happens on this phone: the app fetches the page itself, so no server of ours ever sees it. Choose how far that should go."
      />

      <RadioGroup
        value={deviceExtractionMode}
        onValueChange={(v) => setMode(v as DeviceExtractionMode)}
        className="gap-3"
      >
        {DEVICE_EXTRACTION_MODES.map((mode) => {
          const { label, hint, icon } = MODE_OPTIONS[mode];
          return (
            <OptionRow
              key={mode}
              value={mode}
              selected={deviceExtractionMode === mode}
              onSelect={() => setMode(mode)}
              label={label}
              hint={hint}
              icon={icon}
            />
          );
        })}
      </RadioGroup>

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {deviceExtractionMode === 'all' && !enabled ? (
        <SettingsNotice tone="pending">
          Previews are on but paused — they resume once you&apos;re signed in and your links have
          finished loading.
        </SettingsNotice>
      ) : enabled ? (
        <View>
          <View className="flex-row gap-3">
            <Stat label="With preview" value={doneCount} />
            <Stat label="Pending" value={pendingCount} />
            <Stat label="Failed" value={failedCount} />
          </View>

          <Text className="mt-4 text-sm text-muted-foreground">
            {total === 0
              ? 'No links to preview yet.'
              : `${doneCount} of ${total} link${total === 1 ? '' : 's'} previewed.`}
          </Text>

          {autoLimitReached && !isExtractingAll && (
            <SettingsNotice tone="pending" className="mt-4">
              <Text className="text-sm text-muted-foreground">
                Automatic previews paused for now. Use{' '}
                <Text className="text-sm font-semibold text-muted-foreground">Generate all</Text> to
                finish the remaining links.
              </Text>
            </SettingsNotice>
          )}

          <View className="mt-6 flex-row">
            {isExtractingAll ? (
              <Button variant="outline" onPress={pause}>
                <Icon as={Pause} className="size-4" />
                <Text>{isRunning ? 'Generating… Pause' : 'Pause'}</Text>
              </Button>
            ) : (
              <Button variant="outline" disabled={pendingCount === 0} onPress={extractAll}>
                <Icon as={Sparkles} className="size-4" />
                <Text>Generate all</Text>
              </Button>
            )}
          </View>
          <Text className="mt-2 text-sm text-muted-foreground">
            Generating fetches every pending link over your connection — best on Wi-Fi, and keep the
            app open while it runs.
          </Text>
        </View>
      ) : null}
    </SettingsPane>
  );
}
