// The bar above a settings section — the expo merge of bracemark-web's settings
// topbar and the links screen's topbar idiom: web's always-visible rail becomes
// a Drawer here, so the leading action is the drawer toggle; the title names the
// ACTIVE section (web's static "Settings" is a surface label in the rail, which
// on mobile is hidden in the drawer); and the trailing ✕ returns to the app (the
// links screen) — the counterpart to the sidebar's back arrow, so either surface
// gets you out.
//
// THE TITLE IS A SURFACE LABEL, NOT THE HEADING. The section's real heading is
// the `SettingsHeader` at the top of the pane below (settings-kit.tsx), which is
// why this one is `text-base font-medium` rather than the `text-lg font-semibold`
// it used to be: at the old size the two sat within a hair of each other, one
// above the other, and read as the same title printed twice. The bar names where
// you are while you scroll past the heading; the heading is the document's.
//
// The two icon buttons are `size-9` with the row's own padding pulling them to
// the frame edge (`-ml-1`/`-mr-1`), so the touch targets stay ≥44pt with the
// glyphs optically aligned to the 16px content inset the pane below uses — the
// links topbar does the same, and the two bars have to agree since a user
// crosses between them constantly.
//
// That 16 is now the pane's inset for EVERY section on a phone, where it used to
// be only the two table ones (settings-kit.tsx carries why the pane's `px-4 md:px-6`
// replaced a flat `px-6` plus two overrides). Nothing here had to move for it, and
// nothing here should chase the `md:` half either: on a tablet the pane is a
// centred 672 column while this bar spans the frame, so the glyph and the content
// are on different axes at that width whatever the numbers say. Web's settings
// topbar is the surface that DOES ride the content column — its title sits on the
// section heading's left edge — and it spells the pane's inset exactly for that
// reason. This bar leads with a drawer toggle instead, so its title never sat on
// that edge to begin with.

import { View } from 'react-native';
import { DrawerActions } from '@react-navigation/native';
import { useNavigation } from 'expo-router';
import { Menu, X } from 'lucide-react-native';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { useWideWindow } from '../../lib/window-class';
import { closeSettings } from './close';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './sections';

export function Topbar({ section }: { section: SettingsSectionId }) {
  const navigation = useNavigation();
  // Docked beside this bar on a wide window ((app)/settings/_layout.tsx), the
  // rail is the menu the toggle would open, so the toggle goes — and the label
  // takes the links bar's docked inset (links/topbar.tsx), for the same reason.
  const wide = useWideWindow();
  const label = SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? 'Settings';

  return (
    <View
      className={cn(
        'h-14 shrink-0 flex-row items-center gap-2 border-b border-border px-3',
        wide && 'pl-4',
      )}
    >
      {!wide && (
        <Button
          variant="ghost"
          size="icon-sm"
          testID="settings-open-navigation"
          onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
          aria-label="Open settings navigation"
          // 48x48 effective — see links/topbar.tsx for why the boxes stay 36 and
          // the slop makes up the difference. Neither button here has a pressable
          // neighbour (the label between them is a Text), so both take the full 6.
          hitSlop={6}
          className="-ml-1"
        >
          <Icon as={Menu} className="size-5 text-foreground" />
        </Button>
      )}
      <Text numberOfLines={1} className="min-w-0 flex-1 text-base font-medium">
        {label}
      </Text>
      <Button
        variant="ghost"
        size="icon-sm"
        testID="settings-close"
        onPress={closeSettings}
        aria-label="Close settings"
        hitSlop={6}
        className="-mr-1"
      >
        <Icon as={X} className="size-5 text-foreground" />
      </Button>
    </View>
  );
}
