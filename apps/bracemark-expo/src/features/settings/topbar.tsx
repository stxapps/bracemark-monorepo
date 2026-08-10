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

import { Pressable, View } from 'react-native';
import { DrawerActions } from '@react-navigation/native';
import { useNavigation, useRouter } from 'expo-router';
import { Menu, X } from 'lucide-react-native';

import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './sections';

export function Topbar({ section }: { section: SettingsSectionId }) {
  const navigation = useNavigation();
  const router = useRouter();
  const label = SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? 'Settings';

  return (
    <View className="h-14 shrink-0 flex-row items-center gap-2 border-b border-border px-3">
      <Pressable
        onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
        aria-label="Open settings navigation"
        className="-ml-1 size-9 items-center justify-center rounded-md active:bg-muted"
      >
        <Icon as={Menu} className="size-5 text-foreground" />
      </Pressable>
      <Text numberOfLines={1} className="min-w-0 flex-1 text-base font-medium">
        {label}
      </Text>
      <Pressable
        onPress={() => router.push('/links')}
        aria-label="Close settings"
        className="-mr-1 size-9 items-center justify-center rounded-md active:bg-muted"
      >
        <Icon as={X} className="size-5 text-muted-foreground" />
      </Pressable>
    </View>
  );
}
