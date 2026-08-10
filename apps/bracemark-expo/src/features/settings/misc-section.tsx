// The Misc settings section — the expo port of bracemark-web's
// `(app)/settings/[section]/_misc/misc-section.tsx` (the canonical doc: the
// link LAYOUT and THEME each split across a Sync/Device tab pair where the
// selected tab IS the active source; link SORT is global-only; the APP LOCK is
// inherently device-only — no tabs, just set/remove through LockPasswordDialog,
// enforced by AppLockGate in the (app) layout). RN divergences: the radio rows
// are Pressables wrapping the primitive (no htmlFor label association), and the
// custom-theme crossover times are plain HH:MM text inputs (RN has no
// `type="time"` input).

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
  useEntitlements,
  useLockMutations,
  useLocks,
  useSettingMutations,
  useSettings,
} from '@stxapps/expo-react';
import {
  LINK_SORT_ONS,
  LINK_SORT_ORDERS,
  LINKS_LAYOUTS,
  type LinksLayout,
  type LinkSortOn,
  type LinkSortOrder,
  THEME_MODES,
  type ThemeMode,
  type ThemeState,
} from '@stxapps/shared';

import { LockPasswordDialog } from '../../components/lock-password-dialog';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import { Switch } from '../../components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Text } from '../../components/ui/text';
import { usePaywall } from '../../contexts/paywall-provider';
import { cn } from '../../lib/utils';
import { SettingsGroup, SettingsHeader, SettingsNotice, SettingsPane } from './settings-kit';

const LAYOUT_OPTIONS: Record<LinksLayout, { label: string; hint: string; icon: LucideIcon }> = {
  list: { label: 'List', hint: 'A dense, single-column list.', icon: List },
  card: { label: 'Card', hint: 'A grid of preview cards.', icon: LayoutGrid },
};

const SORT_ON_OPTIONS: Record<LinkSortOn, { label: string; hint: string; icon: LucideIcon }> = {
  updatedAt: {
    label: 'Date modified',
    hint: 'Order by when a link was last changed.',
    icon: Clock,
  },
  createdAt: {
    label: 'Date added',
    hint: 'Order by when a link was saved.',
    icon: CalendarPlus,
  },
};

const SORT_ORDER_OPTIONS: Record<LinkSortOrder, { label: string; hint: string; icon: LucideIcon }> =
  {
    desc: { label: 'Newest first', hint: 'The most recent links at the top.', icon: ArrowDown },
    asc: { label: 'Oldest first', hint: 'The oldest links at the top.', icon: ArrowUp },
  };

const THEME_MODE_OPTIONS: Record<ThemeMode, { label: string; hint: string; icon: LucideIcon }> = {
  light: { label: 'Light', hint: 'Always use the light theme.', icon: Sun },
  dark: { label: 'Dark', hint: 'Always use the dark theme.', icon: Moon },
  system: { label: 'System', hint: "Follow your device's appearance.", icon: Monitor },
  custom: {
    label: 'Custom time',
    hint: 'Light by day, dark by night — you set the times.',
    icon: Clock,
  },
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
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as LinksLayout)}
      className="mt-4 gap-3"
    >
      {LINKS_LAYOUTS.map((layout) => {
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
function ThemeControls({
  value,
  onChange,
}: {
  value: ThemeState;
  onChange: (theme: ThemeState) => void;
}) {
  return (
    <View className="mt-4">
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

      {value.mode === 'custom' && (
        <View className="mt-4 flex-row flex-wrap gap-4">
          <View className="gap-1.5">
            <Text className="text-sm font-medium">Light starts</Text>
            <Input
              value={value.lightStart}
              placeholder="06:00"
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              onChangeText={(text) => onChange({ ...value, lightStart: text })}
              className="w-36"
            />
          </View>
          <View className="gap-1.5">
            <Text className="text-sm font-medium">Dark starts</Text>
            <Input
              value={value.darkStart}
              placeholder="18:00"
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              onChangeText={(text) => onChange({ ...value, darkStart: text })}
              className="w-36"
            />
          </View>
        </View>
      )}
    </View>
  );
}

export function MiscSection() {
  const {
    linksLayoutSource,
    syncLinksLayout,
    localLinksLayout,
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
    setSortOn,
    setSortOrder,
    setThemeSource,
    setSyncTheme,
    setLocalTheme,
  } = useSettingMutations();
  const { appLock, biometricAvailable, biometricLabel } = useLocks();
  const { setAppLock, removeAppLock, setAppBiometric } = useLockMutations();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const [lockDialog, setLockDialog] = useState<'set' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Surface a failed write (e.g. the synced write with no active account) rather
  // than swallowing it; the controls stay live for a retry.
  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <SettingsPane>
      <SettingsHeader title="Misc." description="General preferences for the app." />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      <SettingsGroup
        title="Link layout"
        description={
          <Text className="text-sm text-muted-foreground">
            Choose how your saved links are displayed.{' '}
            <Text className="text-sm font-semibold">Sync</Text> applies your choice across all your
            devices. <Text className="text-sm font-semibold">Device</Text> keeps a separate choice
            for this device only (cleared when you sign out).
          </Text>
        }
      >
        <Tabs
          value={linksLayoutSource}
          onValueChange={(v) => run(setLinksLayoutSource(v as LinksLayoutSource))}
        >
          <TabsList>
            <TabsTrigger value="sync">
              <Text>Sync</Text>
            </TabsTrigger>
            {/* The `'local'` source is labeled "Device" for users. */}
            <TabsTrigger value="local">
              <Text>Device</Text>
            </TabsTrigger>
          </TabsList>

          {/* One radio group per tab, each bound to that source's value. The
              active tab is the active source (use-settings), so the shown radios
              always reflect the layout the app is rendering. */}
          <TabsContent value="sync">
            <LayoutRadioGroup
              value={syncLinksLayout}
              onChange={(l) => run(setSyncLinksLayout(l))}
            />
          </TabsContent>
          <TabsContent value="local">
            <LayoutRadioGroup
              value={localLinksLayout}
              onChange={(l) => run(setLocalLinksLayout(l))}
            />
          </TabsContent>
        </Tabs>
      </SettingsGroup>

      <SettingsGroup
        title="Link sort"
        description="Choose how your saved links are ordered. This applies across all your devices."
      >
        {/* Global-only (synced), so no Sync/Device tabs — the two axes are set
            directly. The RadioGroup value is the raw persisted string, so an
            unknown future value simply shows nothing selected. */}
        <View>
          <Text className="text-sm font-medium">Sort by</Text>
          <RadioGroup
            value={sortOn}
            onValueChange={(v) => run(setSortOn(v as LinkSortOn))}
            className="mt-2 gap-3"
          >
            {LINK_SORT_ONS.map((on) => {
              const { label, hint, icon } = SORT_ON_OPTIONS[on];
              return (
                <OptionRow
                  key={on}
                  value={on}
                  selected={sortOn === on}
                  onSelect={() => run(setSortOn(on))}
                  label={label}
                  hint={hint}
                  icon={icon}
                />
              );
            })}
          </RadioGroup>
        </View>

        <View className="mt-4">
          <Text className="text-sm font-medium">Order</Text>
          <RadioGroup
            value={sortOrder}
            onValueChange={(v) => run(setSortOrder(v as LinkSortOrder))}
            className="mt-2 gap-3"
          >
            {LINK_SORT_ORDERS.map((order) => {
              const { label, hint, icon } = SORT_ORDER_OPTIONS[order];
              return (
                <OptionRow
                  key={order}
                  value={order}
                  selected={sortOrder === order}
                  onSelect={() => run(setSortOrder(order))}
                  label={label}
                  hint={hint}
                  icon={icon}
                />
              );
            })}
          </RadioGroup>
        </View>
      </SettingsGroup>

      <SettingsGroup
        title="Theme"
        description={
          <Text className="text-sm text-muted-foreground">
            Choose the app&apos;s appearance. <Text className="text-sm font-semibold">Sync</Text>{' '}
            applies your choice across all your devices.{' '}
            <Text className="text-sm font-semibold">Device</Text> keeps a separate choice for this
            device only (cleared when you sign out).
          </Text>
        }
      >
        <Tabs value={themeSource} onValueChange={(v) => run(setThemeSource(v as ThemeSource))}>
          <TabsList>
            <TabsTrigger value="sync">
              <Text>Sync</Text>
            </TabsTrigger>
            <TabsTrigger value="local">
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
        title="App lock"
        description="Lock the whole app with a password on this device only — it engages every time the app loads. If you forget the password, sign out and sign back in with your account password; signing out removes all locks on this device."
      >
        <View className="flex-row">
          {appLock.exists ? (
            // Remove stays open even for a free (downgraded) account, so an
            // existing lock is never stranded — mirrors list unlock/remove.
            <Button variant="outline" onPress={() => setLockDialog('remove')}>
              <Text>Remove app lock…</Text>
            </Button>
          ) : (
            // Setting a new lock is the `locks` Plus lever — gate at the button,
            // before any password dialog (nothing sensitive is typed then thrown).
            <Button
              variant="outline"
              onPress={() => (entitlements.locks ? setLockDialog('set') : paywall.show('locks'))}
            >
              <Text>Set app lock…</Text>
            </Button>
          )}
        </View>

        {/* Biometric fast-path — only with an app lock set AND biometry enrolled
            on this device. The password stays the root credential and the
            fallback; this just opts the app lock into Face ID / Touch ID. The
            Switch reflects the persisted flag, so a cancelled enable (the OS
            confirm) leaves it off. */}
        {appLock.exists && biometricAvailable && (
          <View className="flex-row items-center justify-between gap-4">
            <View className="min-w-0 flex-1">
              <Text className="font-medium">Unlock with {biometricLabel}</Text>
              <Text className="mt-0.5 text-sm text-muted-foreground">
                Use {biometricLabel} instead of typing the password. The password still works as a
                fallback.
              </Text>
            </View>
            <Switch value={appLock.biometric} onValueChange={(v) => run(setAppBiometric(v))} />
          </View>
        )}
      </SettingsGroup>

      {lockDialog === 'set' && (
        <LockPasswordDialog
          onOpenChange={(open) => !open && setLockDialog(null)}
          title="Set app lock"
          description="Create a password to lock this app on this device. It takes effect the next time the app loads."
          submitLabel="Set lock"
          onSubmit={async (password) => {
            await setAppLock(password);
          }}
        />
      )}
      {lockDialog === 'remove' && (
        <LockPasswordDialog
          onOpenChange={(open) => !open && setLockDialog(null)}
          title="Remove app lock"
          description="Enter your app lock password to remove it."
          submitLabel="Remove"
          onSubmit={async (password) => {
            if (!(await removeAppLock(password))) {
              throw new Error('Password is not correct. Please try again.');
            }
          }}
        />
      )}
    </SettingsPane>
  );
}
