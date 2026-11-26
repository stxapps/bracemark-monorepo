// The Appearance settings section — the expo port of bracemark-web's
// `(app)/settings/[section]/_appearance/appearance-section.tsx` (the canonical
// doc: theme, then the link layout with the SELECTED layout's display options,
// then the sort; theme and the layout each split across a Sync/Device tab pair
// where the selected tab IS the active source; the layout's tab covers the whole
// pack — layout, options and sort — so the sort has no tabs of its own and edits
// the source the layout tab made active). RN divergences: the radio rows are
// Pressables wrapping the primitive (no htmlFor label association), and the
// custom-theme crossover times go through `TimeField` — RN has no `type="time"`
// input, so the native picker stands in for the browser's (its header carries
// why a text input can't work here).

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  ArrowDown,
  ArrowUp,
  CalendarPlus,
  Clock,
  LayoutGrid,
  List,
  type LucideIcon,
  Monitor,
  Moon,
  Sun,
} from 'lucide-react-native';

import {
  type LinksLayoutSource,
  type ThemeSource,
  useSettingMutations,
  useSettings,
} from '@stxapps/expo-react';
import {
  LAYOUT_OPTION_COPY,
  SORT_ON_OPTION_COPY,
  SORT_ORDER_OPTION_COPY,
  THEME_MODE_OPTION_COPY,
} from '@stxapps/react';
import {
  type LayoutOptions,
  type LayoutOptionsPatch,
  LINK_SORT_ONS,
  LINK_SORT_ORDERS,
  type LinksLayout,
  type LinkSortOn,
  type LinkSortOrder,
  NATIVE_LINKS_LAYOUTS,
  type OptionLayout,
  THEME_MODES,
  type ThemeMode,
  type ThemeState,
} from '@stxapps/shared';

import { FirstLineSlot } from '../../components/first-line-slot';
import { LayoutOptionsControls } from '../../components/layout-options-controls';
import { Icon } from '../../components/ui/icon';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { SettingsGroup, SettingsHeader, SettingsNotice, SettingsPane } from './settings-kit';
import { TimeField } from './time-field';

// No table: it is web-only (NATIVE_LINKS_LAYOUTS).
const LAYOUT_OPTIONS: Record<
  (typeof NATIVE_LINKS_LAYOUTS)[number],
  { label: string; hint: string; icon: LucideIcon }
> = {
  list: { ...LAYOUT_OPTION_COPY.list, icon: List },
  card: { ...LAYOUT_OPTION_COPY.card, icon: LayoutGrid },
};

const SORT_ON_OPTIONS: Record<LinkSortOn, { label: string; hint: string; icon: LucideIcon }> = {
  updatedAt: { ...SORT_ON_OPTION_COPY.updatedAt, icon: Clock },
  createdAt: { ...SORT_ON_OPTION_COPY.createdAt, icon: CalendarPlus },
};

const SORT_ORDER_OPTIONS: Record<LinkSortOrder, { label: string; hint: string; icon: LucideIcon }> =
  {
    desc: { ...SORT_ORDER_OPTION_COPY.desc, icon: ArrowDown },
    asc: { ...SORT_ORDER_OPTION_COPY.asc, icon: ArrowUp },
  };

const THEME_MODE_OPTIONS: Record<ThemeMode, { label: string; hint: string; icon: LucideIcon }> = {
  light: { ...THEME_MODE_OPTION_COPY.light, icon: Sun },
  dark: { ...THEME_MODE_OPTION_COPY.dark, icon: Moon },
  system: { ...THEME_MODE_OPTION_COPY.system, icon: Monitor },
  custom: { ...THEME_MODE_OPTION_COPY.custom, icon: Clock },
};

// A reusable radio row, shared by the layout, sort, and theme option lists so
// all read identically. The whole row is tappable (web's Label association);
// the primitive Item inside renders the radio mark and stays pressable itself.
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
  icon: LucideIcon;
}) {
  return (
    <Pressable
      role="radio"
      onPress={onSelect}
      aria-checked={selected}
      className={cn(
        'flex-row items-start gap-3 rounded-lg border border-border p-3',
        selected && 'border-primary bg-muted/40',
      )}
    >
      <FirstLineSlot>
        <RadioGroupItem value={value} />
      </FirstLineSlot>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-start gap-2">
          <FirstLineSlot>
            <Icon as={icon} className="size-4 text-foreground" />
          </FirstLineSlot>
          <Text className="min-w-0 flex-1 font-medium">{label}</Text>
        </View>
        <Text className="text-sm text-muted-foreground">{hint}</Text>
      </View>
    </Pressable>
  );
}

// The layout radios for one source. `value` is the raw persisted `string` — an
// unknown future layout matches no radio and renders NOTHING selected, the
// honest rendering (web's rationale, verbatim); `onChange` stays `LinksLayout`,
// so we can only ever write a real one.
function LayoutRadioGroup({
  value,
  onChange,
}: {
  value: string;
  onChange: (layout: LinksLayout) => void;
}) {
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as LinksLayout)} className="gap-3">
      {NATIVE_LINKS_LAYOUTS.map((layout) => {
        const { label, hint, icon } = LAYOUT_OPTIONS[layout];
        return (
          <OptionRow
            key={layout}
            value={layout}
            selected={value === layout}
            onSelect={() => onChange(layout)}
            label={label}
            hint={hint}
            icon={icon}
          />
        );
      })}
    </RadioGroup>
  );
}

// The four mode radios for one source, plus the two crossover-time inputs
// revealed only in `custom` mode. Source-agnostic like LayoutRadioGroup; each
// edit emits a whole new ThemeState (the mutations take the full object).
//
// No top margin on the wrapper — nor on LayoutRadioGroup above. These render
// inside a TabsContent, and `Tabs` already spaces the strip from its panel by 8;
// a `mt-4` on top of that pushed it to 24, so the Sync/Device pills sat further
// from the radios they govern than from the section heading above, and exactly
// as far as one whole section sits from the next. The View stays because the
// custom-time block needs a sibling.
function ThemeControls({
  value,
  onChange,
}: {
  value: ThemeState;
  onChange: (theme: ThemeState) => void;
}) {
  return (
    <View>
      <RadioGroup
        value={value.mode}
        onValueChange={(v) => onChange({ ...value, mode: v as ThemeMode })}
        className="gap-3"
      >
        {THEME_MODES.map((mode) => {
          const { label, hint, icon } = THEME_MODE_OPTIONS[mode];
          return (
            <OptionRow
              key={mode}
              value={mode}
              selected={value.mode === mode}
              onSelect={() => onChange({ ...value, mode })}
              label={label}
              hint={hint}
              icon={icon}
            />
          );
        })}
      </RadioGroup>

      {/* `ml-10` is OptionRow's own inset — p-3 + a size-4 radio + gap-3 — so these two
          fields align under "Custom time" and read as part of that option (web's
          rationale, verbatim). The pair is 272pt at TimeField's minimum width, 312 with
          the inset, and SettingsPane is px-4 — so it sits side by side as on web from a
          360pt screen up. `flex-wrap` is for when it can't: the fields grow with the
          text size and the locale's time format, and then they stack AT the inset,
          which still reads as nested. */}
      {value.mode === 'custom' && (
        <View className="mt-4 ml-10 flex-row flex-wrap gap-4">
          <TimeField
            label="Light starts"
            value={value.lightStart}
            onChange={(lightStart) => onChange({ ...value, lightStart })}
          />
          <TimeField
            label="Dark starts"
            value={value.darkStart}
            onChange={(darkStart) => onChange({ ...value, darkStart })}
          />
        </View>
      )}
    </View>
  );
}

// Whether a stored layout takes display options here — web's twin.
const optionLayoutOf = (layout: string): OptionLayout | undefined =>
  layout === 'card' || layout === 'list' ? layout : undefined;

// The layout radios plus the selected layout's options, for one source.
function LayoutControls({
  source,
  layout,
  options,
  onLayoutChange,
  onOptionsChange,
}: {
  source: LinksLayoutSource;
  layout: string;
  options: LayoutOptions;
  onLayoutChange: (layout: LinksLayout) => void;
  onOptionsChange: (patch: LayoutOptionsPatch) => void;
}) {
  const optionLayout = optionLayoutOf(layout);
  return (
    <View className="gap-6">
      <LayoutRadioGroup value={layout} onChange={onLayoutChange} />
      {optionLayout && (
        <View className="gap-1">
          <Text role="heading" className="text-sm font-medium">
            {LAYOUT_OPTION_COPY[optionLayout].label} options
          </Text>
          <LayoutOptionsControls
            testIDPrefix={`appearance-${source}`}
            layout={optionLayout}
            options={options}
            onChange={onOptionsChange}
          />
        </View>
      )}
    </View>
  );
}

export function AppearanceSection() {
  const {
    linksLayoutSource,
    syncLinksLayout,
    localLinksLayout,
    syncLayoutOptions,
    localLayoutOptions,
    sortOn,
    sortOrder,
    themeSource,
    syncTheme,
    localTheme,
  } = useSettings();
  const {
    setLinksLayoutSource,
    setSyncLinksLayout,
    setLocalLinksLayout,
    setSyncLayoutOptions,
    setLocalLayoutOptions,
    setSort,
    setThemeSource,
    setSyncTheme,
    setLocalTheme,
  } = useSettingMutations();
  const [error, setError] = useState<string | null>(null);

  // Surface a failed write (e.g. the synced write with no active account) rather
  // than swallowing it; the controls stay live for a retry.
  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <SettingsPane>
      <SettingsHeader title="Appearance" description="How the app and your links look." />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      <SettingsGroup
        title="Theme"
        description={
          <Text className="text-sm text-muted-foreground">
            Choose the app’s colours. <Text className="text-sm font-semibold">Sync</Text> applies
            your choice across all your devices.{' '}
            <Text className="text-sm font-semibold">Device</Text> keeps a separate choice for this
            device only (cleared when you sign out).
          </Text>
        }
      >
        <Tabs value={themeSource} onValueChange={(v) => run(setThemeSource(v as ThemeSource))}>
          <TabsList>
            {/* testIDs on both pairs of tabs: this section has two "Sync" tabs, and a
                flow that taps the text gets whichever is first on screen. */}
            <TabsTrigger value="sync" testID="theme-source-sync">
              <Text>Sync</Text>
            </TabsTrigger>
            <TabsTrigger value="local" testID="theme-source-local">
              <Text>Device</Text>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sync">
            <ThemeControls value={syncTheme} onChange={(t) => run(setSyncTheme(t))} />
          </TabsContent>
          <TabsContent value="local">
            <ThemeControls value={localTheme} onChange={(t) => run(setLocalTheme(t))} />
          </TabsContent>
        </Tabs>
      </SettingsGroup>

      <SettingsGroup
        title="Link layout"
        description={
          <Text className="text-sm text-muted-foreground">
            Choose how your saved links are displayed, and what each link shows.{' '}
            <Text className="text-sm font-semibold">Sync</Text> applies your layout, its options and
            the sort below across all your devices.{' '}
            <Text className="text-sm font-semibold">Device</Text> keeps separate ones for this
            device only (cleared when you sign out).
          </Text>
        }
      >
        <Tabs
          value={linksLayoutSource}
          onValueChange={(v) => run(setLinksLayoutSource(v as LinksLayoutSource))}
        >
          <TabsList>
            <TabsTrigger value="sync" testID="layout-source-sync">
              <Text>Sync</Text>
            </TabsTrigger>
            {/* The `'local'` source is labeled "Device" for users. */}
            <TabsTrigger value="local" testID="layout-source-local">
              <Text>Device</Text>
            </TabsTrigger>
          </TabsList>

          {/* One set of controls per tab, each bound to that source's values. The
              active tab is the active source (use-settings), so the shown controls
              always reflect what the app is rendering. */}
          <TabsContent value="sync">
            <LayoutControls
              source="sync"
              layout={syncLinksLayout}
              options={syncLayoutOptions}
              onLayoutChange={(l) => run(setSyncLinksLayout(l))}
              onOptionsChange={(p) => run(setSyncLayoutOptions(p))}
            />
          </TabsContent>
          <TabsContent value="local">
            <LayoutControls
              source="local"
              layout={localLinksLayout}
              options={localLayoutOptions}
              onLayoutChange={(l) => run(setLocalLinksLayout(l))}
              onOptionsChange={(p) => run(setLocalLayoutOptions(p))}
            />
          </TabsContent>
        </Tabs>
      </SettingsGroup>

      <SettingsGroup
        title="Link sort"
        description={
          linksLayoutSource === 'local'
            ? 'Choose how your saved links are ordered. Saved on this device only, with your layout.'
            : 'Choose how your saved links are ordered. Saved across all your devices, with your layout.'
        }
      >
        {/* No tabs: the sort is part of the layout pack, so it edits the source the
            Link layout tab made active. The RadioGroup value is the raw persisted
            string, so an unknown future value simply shows nothing selected. */}
        <View>
          <Text className="text-sm font-medium">Sort by</Text>
          <RadioGroup
            value={sortOn}
            onValueChange={(v) => run(setSort({ sortOn: v as LinkSortOn }))}
            className="mt-2 gap-3"
          >
            {LINK_SORT_ONS.map((on) => {
              const { label, hint, icon } = SORT_ON_OPTIONS[on];
              return (
                <OptionRow
                  key={on}
                  value={on}
                  selected={sortOn === on}
                  onSelect={() => run(setSort({ sortOn: on }))}
                  label={label}
                  hint={hint}
                  icon={icon}
                />
              );
            })}
          </RadioGroup>
        </View>

        {/* No `mt-4` here: this is a direct child of SettingsGroup, so the group's
            own gap already spaces it off the "Sort by" block above. */}
        <View>
          <Text className="text-sm font-medium">Order</Text>
          <RadioGroup
            value={sortOrder}
            onValueChange={(v) => run(setSort({ sortOrder: v as LinkSortOrder }))}
            className="mt-2 gap-3"
          >
            {LINK_SORT_ORDERS.map((order) => {
              const { label, hint, icon } = SORT_ORDER_OPTIONS[order];
              return (
                <OptionRow
                  key={order}
                  value={order}
                  selected={sortOrder === order}
                  onSelect={() => run(setSort({ sortOrder: order }))}
                  label={label}
                  hint={hint}
                  icon={icon}
                />
              );
            })}
          </RadioGroup>
        </View>
      </SettingsGroup>
    </SettingsPane>
  );
}
