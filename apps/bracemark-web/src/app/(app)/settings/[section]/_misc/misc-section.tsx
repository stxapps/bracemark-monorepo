'use client';

// The Misc settings section: small app-wide preferences. It owns the link LAYOUT —
// list / card — and the THEME — light / dark / system / custom time. Both
// follow the same shape: a Sync/Device tab picks WHERE the choice lives, and the
// selected tab IS the active source (use-settings.ts resolves the applied value from
// it):
//   - Sync   → settings/general.enc, shared across the user's devices;
//   - Device → the off-sync localSettings store, this device only (wiped on sign-out).
// Each tab shows the same controls bound to that source's value, so switching tabs
// both changes which value applies and reveals it for editing.
//
// It also owns the APP LOCK — inherently device-only (locks never sync; wiped on
// sign-out — see LockRecord in web-react's db.ts), so no Sync/Device tabs: just
// set/remove, both through LockPasswordDialog. The lock itself is enforced by
// AppLockGate in the (app) layout.

import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CalendarPlus,
  Clock,
  LayoutGrid,
  List,
  Monitor,
  Moon,
  Sun,
} from 'lucide-react';

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
import {
  type LinksLayoutSource,
  type ThemeSource,
  useEntitlements,
  useLockMutations,
  useLocks,
  useSettingMutations,
  useSettings,
} from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Input } from '@stxapps/web-ui/components/ui/input';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@stxapps/web-ui/components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@stxapps/web-ui/components/ui/tabs';

import {
  SettingsGroup,
  SettingsHeader,
  SettingsNotice,
  SettingsPane,
} from '../../_components/settings-kit';

import { LockPasswordDialog } from '@/components/lock-password-dialog';
import { usePaywall } from '@/contexts/paywall-provider';

const LAYOUT_OPTIONS: Record<LinksLayout, { label: string; hint: string; icon: React.ReactNode }> =
  {
    list: {
      label: 'List',
      hint: 'A dense, single-column list.',
      icon: <List className="size-4" />,
    },
    card: {
      label: 'Card',
      hint: 'A grid of preview cards.',
      icon: <LayoutGrid className="size-4" />,
    },
  };

const SORT_ON_OPTIONS: Record<LinkSortOn, { label: string; hint: string; icon: React.ReactNode }> =
  {
    updatedAt: {
      label: 'Date modified',
      hint: 'Order by when a link was last changed.',
      icon: <Clock className="size-4" />,
    },
    createdAt: {
      label: 'Date added',
      hint: 'Order by when a link was saved.',
      icon: <CalendarPlus className="size-4" />,
    },
  };

const SORT_ORDER_OPTIONS: Record<
  LinkSortOrder,
  { label: string; hint: string; icon: React.ReactNode }
> = {
  desc: {
    label: 'Newest first',
    hint: 'The most recent links at the top.',
    icon: <ArrowDown className="size-4" />,
  },
  asc: {
    label: 'Oldest first',
    hint: 'The oldest links at the top.',
    icon: <ArrowUp className="size-4" />,
  },
};

const THEME_MODE_OPTIONS: Record<
  ThemeMode,
  { label: string; hint: string; icon: React.ReactNode }
> = {
  light: {
    label: 'Light',
    hint: 'Always use the light theme.',
    icon: <Sun className="size-4" />,
  },
  dark: {
    label: 'Dark',
    hint: 'Always use the dark theme.',
    icon: <Moon className="size-4" />,
  },
  system: {
    label: 'System',
    hint: "Follow your device's appearance.",
    icon: <Monitor className="size-4" />,
  },
  custom: {
    label: 'Custom time',
    hint: 'Light by day, dark by night — you set the times.',
    icon: <Clock className="size-4" />,
  },
};

// A reusable radio-row Label, shared by the layout and theme option lists so both
// read identically. `has-data-checked` styles the row when its radio is selected.
function OptionRow({
  id,
  value,
  label,
  hint,
  icon,
}: {
  id: string;
  value: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <Label
      htmlFor={id}
      className="flex items-start gap-3 rounded-lg border border-border p-3 has-data-checked:border-primary has-data-checked:bg-muted/40"
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 font-medium">
          {icon}
          {label}
        </span>
        <span className="text-sm font-normal text-muted-foreground">{hint}</span>
      </span>
    </Label>
  );
}

// The layout radios for one source. `value`/`onChange` are wired to either the
// synced or the device layout by the parent, so this row is source-agnostic.
//
// `value` is the raw persisted `string`, not a `LinksLayout`: the synced setting can
// hold a layout this build doesn't offer (see LINKS_LAYOUTS in entities.ts), and
// `useSettings` passes it through rather than rewriting it. When it matches no radio,
// RadioGroup renders with NOTHING selected — which is the honest rendering: the
// active layout genuinely isn't one of these, and the links page is showing its
// fallback. Picking any option here writes a layout this build knows and repairs it
// (clobbering the other device's choice — deliberately, since the user just asked
// for this one). `onChange` stays `LinksLayout`, so we can only ever write a real one.
function LayoutRadioGroup({
  value,
  onChange,
}: {
  value: string;
  onChange: (layout: LinksLayout) => void;
}) {
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as LinksLayout)} className="mt-4">
      {LINKS_LAYOUTS.map((layout) => {
        const { label, hint, icon } = LAYOUT_OPTIONS[layout];
        return (
          <OptionRow
            key={layout}
            id={`layout-${layout}`}
            value={layout}
            label={label}
            hint={hint}
            icon={icon}
          />
        );
      })}
    </RadioGroup>
  );
}

// The four mode radios for one source, plus the two crossover-time inputs revealed
// only in `custom` mode. Source-agnostic like LayoutRadioGroup: the parent binds
// `value`/`onChange` to the synced or the device ThemeState. Each edit emits a whole
// new ThemeState (the mutations take the full object).
function ThemeControls({
  value,
  onChange,
}: {
  value: ThemeState;
  onChange: (theme: ThemeState) => void;
}) {
  return (
    <div className="mt-4">
      <RadioGroup
        value={value.mode}
        onValueChange={(v) => onChange({ ...value, mode: v as ThemeMode })}
      >
        {THEME_MODES.map((mode) => {
          const { label, hint, icon } = THEME_MODE_OPTIONS[mode];
          return (
            <OptionRow
              key={mode}
              id={`theme-${mode}`}
              value={mode}
              label={label}
              hint={hint}
              icon={icon}
            />
          );
        })}
      </RadioGroup>

      {value.mode === 'custom' && (
        <div className="mt-4 flex flex-wrap gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="theme-light-start">Light starts</Label>
            <Input
              id="theme-light-start"
              type="time"
              value={value.lightStart}
              onChange={(e) => onChange({ ...value, lightStart: e.target.value })}
              className="w-36"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="theme-dark-start">Dark starts</Label>
            <Input
              id="theme-dark-start"
              type="time"
              value={value.darkStart}
              onChange={(e) => onChange({ ...value, darkStart: e.target.value })}
              className="w-36"
            />
          </div>
        </div>
      )}
    </div>
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
  const { appLock } = useLocks();
  const { setAppLock, removeAppLock } = useLockMutations();
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
          <>
            Choose how your saved links are displayed. <strong>Sync</strong> applies your choice
            across all your devices. <strong>Device</strong> keeps a separate choice for this device
            only (cleared when you sign out).
          </>
        }
      >
        <Tabs
          value={linksLayoutSource}
          onValueChange={(v) => run(setLinksLayoutSource(v as LinksLayoutSource))}
        >
          <TabsList>
            <TabsTrigger value="sync">Sync</TabsTrigger>
            {/* The `'local'` source is labeled "Device" for users. */}
            <TabsTrigger value="local">Device</TabsTrigger>
          </TabsList>

          {/* One radio group per tab, each bound to that source's value. The active
              tab is the active source (use-settings.ts), so the shown radios always
              reflect the layout the app is rendering. */}
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
            directly. The RadioGroup value is the raw persisted string, so an unknown
            future value simply shows nothing selected (like the layout radios). */}
        <div>
          <Label className="text-sm font-medium">Sort by</Label>
          <RadioGroup
            value={sortOn}
            onValueChange={(v) => run(setSortOn(v as LinkSortOn))}
            className="mt-2"
          >
            {LINK_SORT_ONS.map((on) => {
              const { label, hint, icon } = SORT_ON_OPTIONS[on];
              return (
                <OptionRow
                  key={on}
                  id={`sort-on-${on}`}
                  value={on}
                  label={label}
                  hint={hint}
                  icon={icon}
                />
              );
            })}
          </RadioGroup>
        </div>

        <div>
          <Label className="text-sm font-medium">Order</Label>
          <RadioGroup
            value={sortOrder}
            onValueChange={(v) => run(setSortOrder(v as LinkSortOrder))}
            className="mt-2"
          >
            {LINK_SORT_ORDERS.map((order) => {
              const { label, hint, icon } = SORT_ORDER_OPTIONS[order];
              return (
                <OptionRow
                  key={order}
                  id={`sort-order-${order}`}
                  value={order}
                  label={label}
                  hint={hint}
                  icon={icon}
                />
              );
            })}
          </RadioGroup>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Theme"
        description={
          <>
            Choose the app's appearance. <strong>Sync</strong> applies your choice across all your
            devices. <strong>Device</strong> keeps a separate choice for this device only (cleared
            when you sign out).
          </>
        }
      >
        <Tabs value={themeSource} onValueChange={(v) => run(setThemeSource(v as ThemeSource))}>
          <TabsList>
            <TabsTrigger value="sync">Sync</TabsTrigger>
            <TabsTrigger value="local">Device</TabsTrigger>
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
        <div>
          {appLock.exists ? (
            // Remove stays open even for a free (downgraded) account, so an
            // existing lock is never stranded — mirrors list unlock/remove.
            <Button variant="outline" onClick={() => setLockDialog('remove')}>
              Remove app lock…
            </Button>
          ) : (
            // Setting a new lock is the `locks` Plus lever — gate at the button,
            // before any password dialog (nothing sensitive is typed then thrown).
            <Button
              variant="outline"
              onClick={() => (entitlements.locks ? setLockDialog('set') : paywall.show('locks'))}
            >
              Set app lock…
            </Button>
          )}
        </div>
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
