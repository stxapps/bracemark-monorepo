// The links screen's View options — the expo port of bracemark-web's
// `links/_components/view-options-popover.tsx` (the canonical doc: the layout, its
// display options and the sort, edited in place on whichever source of the pack is
// ACTIVE, with a line saying where that is saved and the way to Settings →
// Appearance, which owns the switch). docs/link-layouts.md.
//
// RN divergences:
//   - An in-app SHEET (components/ui/sheet.tsx — a bottom sheet on a phone, a
//     centred card on a tablet), not a popover, opened from the header's ⋯ menu
//     (more-options-menu.tsx) rather than from an icon of its own: a phone header
//     holds the title, Search and ⋯, and a fourth target there would crowd the
//     title and the hit areas the bar has already budgeted (links/topbar.tsx).
//   - A HOST, like Advanced Search's (search-bar.tsx): the sheet renders as a
//     sibling of the links Drawer inside SheetHost, never portaled, which is where
//     the sheet kit requires its bodies to be (sheet.tsx has why).
// Nothing here is a draft — each control writes as it changes, so the backdrop and
// Android's back close it like the ✕. No text field, so nothing here raises the
// keyboard (docs/soft-keyboard.md has nothing to ask of it).

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { useSettingMutations, useSettings } from '@stxapps/expo-react';
import { LAYOUT_OPTION_COPY, SORT_ON_OPTION_COPY, SORT_ORDER_OPTION_COPY } from '@stxapps/react';
import {
  LINK_SORT_ONS,
  LINK_SORT_ORDERS,
  type LinksLayout,
  type LinkSortOn,
  type LinkSortOrder,
  NATIVE_LINKS_LAYOUTS,
} from '@stxapps/shared';

import { ChoiceRow, LayoutOptionsControls } from '../../components/layout-options-controls';
import { Button } from '../../components/ui/button';
import { Sheet } from '../../components/ui/sheet';
import { Text } from '../../components/ui/text';
import { useFocusedFieldReveal } from '../../lib/use-focused-field-reveal';

const ViewOptionsContext = createContext<{ openViewOptions: () => void } | null>(null);

export function ViewOptionsHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ openViewOptions: () => setOpen(true) }), []);
  return (
    <ViewOptionsContext.Provider value={value}>
      {children}
      {open && <ViewOptionsSheet onClose={close} />}
    </ViewOptionsContext.Provider>
  );
}

export function useViewOptions() {
  const value = useContext(ViewOptionsContext);
  if (!value) throw new Error('useViewOptions must be used within ViewOptionsHost');
  return value;
}

function ViewOptionsSheet({ onClose }: { onClose: () => void }) {
  const { linksLayout, linksLayoutSource, layoutOptions, sortOn, sortOrder } = useSettings();
  const { setLinksLayout, setLayoutOptions, setSort } = useSettingMutations();
  const router = useRouter();
  const reveal = useFocusedFieldReveal();
  const [error, setError] = useState<string | null>(null);
  const optionLayout = linksLayout === 'card' || linksLayout === 'list' ? linksLayout : undefined;

  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <Sheet
      title="View options"
      closeLabel="Close view options"
      closeTestID="view-options-close"
      onClose={onClose}
      onDismiss={onClose}
      reveal={reveal}
    >
      <View>
        <ChoiceRow<LinksLayout>
          testID="view-layout"
          label="Layout"
          value={linksLayout as LinksLayout}
          values={NATIVE_LINKS_LAYOUTS}
          copy={(v) => LAYOUT_OPTION_COPY[v]?.label ?? v}
          onChange={(layout) => run(setLinksLayout(layout))}
        />
        {optionLayout && (
          <LayoutOptionsControls
            testIDPrefix="view"
            layout={optionLayout}
            options={layoutOptions}
            onChange={(patch) => run(setLayoutOptions(patch))}
          />
        )}
        <ChoiceRow<LinkSortOn>
          testID="view-sort-on"
          label="Sort by"
          value={sortOn as LinkSortOn}
          values={LINK_SORT_ONS}
          copy={(v) => SORT_ON_OPTION_COPY[v]?.label ?? v}
          onChange={(on) => run(setSort({ sortOn: on }))}
        />
        <ChoiceRow<LinkSortOrder>
          testID="view-sort-order"
          label="Order"
          value={sortOrder as LinkSortOrder}
          values={LINK_SORT_ORDERS}
          copy={(v) => SORT_ORDER_OPTION_COPY[v]?.label ?? v}
          onChange={(order) => run(setSort({ sortOrder: order }))}
        />
      </View>
      {error && (
        <Text role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </Text>
      )}
      <View className="mt-3 flex-row flex-wrap items-center gap-x-1">
        <Text className="text-sm text-muted-foreground">
          {linksLayoutSource === 'local'
            ? 'Saved on this device only.'
            : 'Saved on all your devices.'}
        </Text>
        <Button
          variant="link"
          size="sm"
          testID="view-options-settings"
          className="px-0"
          onPress={() => {
            onClose();
            router.push('/settings/appearance');
          }}
        >
          <Text>Change in Settings</Text>
        </Button>
      </View>
    </Sheet>
  );
}
