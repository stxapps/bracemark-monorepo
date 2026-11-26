'use client';

// The Appearance settings section: how the app looks. In order —
//
//   - THEME — light / dark / system / custom time;
//   - LINK LAYOUT — list / card, and under the radios the display options of the
//     SELECTED layout only (components/layout-options-controls.tsx, shared with the
//     links page's View options popover);
//   - LINK SORT — the order links come in.
//
// Theme and the layout each have a Sync/Device tab that picks WHERE the choice lives,
// and the selected tab IS the active source (use-settings.ts resolves the applied
// value from it):
//   - Sync   → settings/general.enc for the theme, settings/layout.enc for the layout
//              pack — shared across the user's devices;
//   - Device → the off-sync localSettings store, this device only (wiped on sign-out).
// Each tab shows the same controls bound to that source's value, so switching tabs
// both changes which value applies and reveals it for editing.
//
// The layout's tab covers the whole PACK — the layout, its options AND the sort
// (docs/link-layouts.md, _the settings model_). So Link sort has no tabs of its own:
// it edits whichever source the layout tab has made active, and says which. Theme is
// a separate pack with its own tab.
//
// Sort lives here, beside the layout, because the table layout's column headers sort:
// the two are one decision about how the library reads.

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
  Table2,
} from 'lucide-react';

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
  LINKS_LAYOUTS,
  type LinksLayout,
  type LinkSortOn,
  type LinkSortOrder,
  type OptionLayout,
  THEME_MODES,
  type ThemeMode,
  type ThemeState,
} from '@stxapps/shared';
import {
  type LinksLayoutSource,
  type ThemeSource,
  useEntitlements,
  useSettingMutations,
  useSettings,
} from '@stxapps/web-react';
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

import { LayoutOptionsControls } from '@/components/layout-options-controls';
import { TableColumnsChooser } from '@/components/table-columns-chooser';
import { usePaywall } from '@/contexts/paywall-provider';

const LAYOUT_OPTIONS: Record<LinksLayout, { label: string; hint: string; icon: React.ReactNode }> =
  {
    list: { ...LAYOUT_OPTION_COPY.list, icon: <List className="size-4" /> },
    card: { ...LAYOUT_OPTION_COPY.card, icon: <LayoutGrid className="size-4" /> },
    table: { ...LAYOUT_OPTION_COPY.table, icon: <Table2 className="size-4" /> },
  };

const SORT_ON_OPTIONS: Record<LinkSortOn, { label: string; hint: string; icon: React.ReactNode }> =
  {
    updatedAt: { ...SORT_ON_OPTION_COPY.updatedAt, icon: <Clock className="size-4" /> },
    createdAt: { ...SORT_ON_OPTION_COPY.createdAt, icon: <CalendarPlus className="size-4" /> },
  };

const SORT_ORDER_OPTIONS: Record<
  LinkSortOrder,
  { label: string; hint: string; icon: React.ReactNode }
> = {
  desc: { ...SORT_ORDER_OPTION_COPY.desc, icon: <ArrowDown className="size-4" /> },
  asc: { ...SORT_ORDER_OPTION_COPY.asc, icon: <ArrowUp className="size-4" /> },
};

const THEME_MODE_OPTIONS: Record<
  ThemeMode,
  { label: string; hint: string; icon: React.ReactNode }
> = {
  light: { ...THEME_MODE_OPTION_COPY.light, icon: <Sun className="size-4" /> },
  dark: { ...THEME_MODE_OPTION_COPY.dark, icon: <Moon className="size-4" /> },
  system: { ...THEME_MODE_OPTION_COPY.system, icon: <Monitor className="size-4" /> },
  custom: { ...THEME_MODE_OPTION_COPY.custom, icon: <Clock className="size-4" /> },
};

// A reusable radio-row Label, shared by the layout and theme option lists so both
// read identically. `has-data-checked` styles the row when its radio is selected.
//
// The radio and the icon both sit on the label's FIRST line, however far it wraps:
// each is a 16px glyph beside a 20px line (`text-sm`), so `mt-0.5` under
// `items-start` centres it there, and `shrink-0` keeps the icon 16 wide. The icon
// was `items-center` with nothing holding its width — fine on one line, but a
// wrapped label squeezed it to 7px and floated it to the middle of the block.
// Everything in that sum is rem, so it holds at any root font size; expo's twin
// can't say the same and uses a strut instead (its components/first-line-slot.tsx).
function OptionRow({
  id,
  value,
  label,
  hint,
  icon,
  badge,
}: {
  id: string;
  value: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  // A plan tag after the label — the Table option's "Plus" for a free account.
  badge?: string;
}) {
  return (
    <Label
      htmlFor={id}
      className="flex items-start gap-3 rounded-lg border border-border p-3 has-data-checked:border-primary has-data-checked:bg-muted/40"
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-start gap-2 font-medium">
          <span className="mt-0.5 shrink-0">{icon}</span>
          {label}
          {badge && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {badge}
            </span>
          )}
        </span>
        <span className="text-sm text-muted-foreground">{hint}</span>
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
  idPrefix,
  value,
  onChange,
  tableEntitled,
}: {
  idPrefix: string;
  value: string;
  onChange: (layout: LinksLayout) => void;
  tableEntitled: boolean;
}) {
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as LinksLayout)}>
      {LINKS_LAYOUTS.map((layout) => {
        const { label, hint, icon } = LAYOUT_OPTIONS[layout];
        return (
          <OptionRow
            key={layout}
            id={`${idPrefix}-layout-${layout}`}
            value={layout}
            label={label}
            hint={hint}
            icon={icon}
            badge={layout === 'table' && !tableEntitled ? 'Plus' : undefined}
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
//
// No top margin on the wrapper — neither here nor on LayoutRadioGroup's RadioGroup.
// These render inside a TabsContent, and `Tabs` already spaces the strip from its
// panel by 8; a `mt-4` on top of that pushed to 24, so the Sync/Device pills ended
// up further from the radios they govern than from the section heading above, and
// exactly as far as one whole section sits from the next. The div stays because the
// custom-time block below needs something to be a sibling of.
function ThemeControls({
  value,
  onChange,
}: {
  value: ThemeState;
  onChange: (theme: ThemeState) => void;
}) {
  return (
    <div>
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

      {/* The 40px inset is OptionRow's own: p-3 + a size-4 radio + gap-3 is where its
          label text starts, so these two fields align under "Custom time" and read as
          part of that option. Flush left they share an edge with all four cards and
          read as a peer of the whole group, like the sort field pairs above. */}
      {value.mode === 'custom' && (
        <div className="mt-4 ml-10 flex flex-wrap gap-4">
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

// Whether a stored layout takes display options here. A layout this build doesn't
// know (a newer client's) shows none — the links page is rendering its fallback.
const optionLayoutOf = (layout: string): OptionLayout | undefined =>
  layout === 'card' || layout === 'list' ? layout : undefined;

// The layout radios plus the selected layout's options, for one source. The Table
// option is a Plus one: a free account sees it badged, and picking it opens the
// upgrade instead of writing it (the caller's `onLayoutChange` gates that). A
// table stored while entitled stays selected after a downgrade — the links page
// shows the list meanwhile, and says nothing it doesn't have to.
function LayoutControls({
  source,
  layout,
  options,
  onLayoutChange,
  onOptionsChange,
  tableEntitled,
}: {
  source: LinksLayoutSource;
  layout: string;
  options: LayoutOptions;
  onLayoutChange: (layout: LinksLayout) => void;
  onOptionsChange: (patch: LayoutOptionsPatch) => void;
  tableEntitled: boolean;
}) {
  const optionLayout = optionLayoutOf(layout);
  return (
    <div className="flex flex-col gap-6">
      <LayoutRadioGroup
        idPrefix={source}
        value={layout}
        onChange={onLayoutChange}
        tableEntitled={tableEntitled}
      />
      {layout === 'table' && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Table columns</h3>
          <p className="text-sm text-muted-foreground">
            The title always comes first. On a narrow window the list shows instead, and columns
            that don’t fit are hidden, starting with the least important.
          </p>
          <TableColumnsChooser
            idPrefix={source}
            columns={options.table.columns}
            onChange={(columns) => onOptionsChange({ table: { columns } })}
          />
        </div>
      )}
      {optionLayout && (
        <div className="flex flex-col gap-1">
          {/* `font-medium` against Label's normal default, like the sort headings. */}
          <h3 className="text-sm font-medium">{LAYOUT_OPTION_COPY[optionLayout].label} options</h3>
          <LayoutOptionsControls
            idPrefix={source}
            layout={optionLayout}
            options={options}
            onChange={onOptionsChange}
          />
        </div>
      )}
    </div>
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
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const [error, setError] = useState<string | null>(null);

  // The Table is a Plus layout: for a free account, picking it opens the upgrade
  // instead of writing it (iap/plans.ts, `tableLayout`).
  const pickLayout = (layout: LinksLayout, write: (layout: LinksLayout) => Promise<void>) => {
    if (layout === 'table' && !entitlements.tableLayout) paywall.show('tableLayout');
    else run(write(layout));
  };

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
          <>
            Choose the app’s colours. <strong>Sync</strong> applies your choice across all your
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
        title="Link layout"
        description={
          <>
            Choose how your saved links are displayed, and what each link shows.{' '}
            <strong>Sync</strong> applies your layout, its options and the sort below across all
            your devices. <strong>Device</strong> keeps separate ones for this device only (cleared
            when you sign out).
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

          {/* One set of controls per tab, each bound to that source's values. The
              active tab is the active source (use-settings.ts), so the shown controls
              always reflect what the app is rendering. */}
          <TabsContent value="sync">
            <LayoutControls
              source="sync"
              layout={syncLinksLayout}
              options={syncLayoutOptions}
              onLayoutChange={(l) => pickLayout(l, setSyncLinksLayout)}
              onOptionsChange={(p) => run(setSyncLayoutOptions(p))}
              tableEntitled={entitlements.tableLayout}
            />
          </TabsContent>
          <TabsContent value="local">
            <LayoutControls
              source="local"
              layout={localLinksLayout}
              options={localLayoutOptions}
              onLayoutChange={(l) => pickLayout(l, setLocalLinksLayout)}
              onOptionsChange={(p) => run(setLocalLayoutOptions(p))}
              tableEntitled={entitlements.tableLayout}
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
            Link layout tab made active (`sortOn`/`sortOrder` are that source's
            values, setSort writes to it). The RadioGroup value is the raw persisted
            string, so an unknown future value simply shows nothing selected. */}
        <div>
          {/* `font-medium` against Label's normal default: these two are headings
              over the OptionRows below, whose own titles are medium. Left to
              inherit, the heading would be lighter than the options it heads. */}
          <Label className="font-medium">Sort by</Label>
          <RadioGroup
            value={sortOn}
            onValueChange={(v) => run(setSort({ sortOn: v as LinkSortOn }))}
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
          <Label className="font-medium">Order</Label>
          <RadioGroup
            value={sortOrder}
            onValueChange={(v) => run(setSort({ sortOrder: v as LinkSortOrder }))}
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
    </SettingsPane>
  );
}
