// The settings drawer's content — the expo port of bracemark-web's
// `(app)/settings/_panes/sidebar.tsx`: the brand lockup pinned at the top over
// the section menu (Account, Subscription, Data, Lists, Tags, Misc., About).
// Each entry navigates to `/settings/[section]`; the active one is derived from
// the pathname (the URL is the source of truth), and the matching section route
// renders the content. On mobile the rail is a Drawer (this group's _layout), so
// selecting an entry also closes it — the links sidebar's pattern.
//
// THE LOCKUP REPLACED A BARE BACK ARROW, and the swap is the point: a drawer
// slid over the app is the one moment the user can't see which app they are in,
// and both this rail and the links rail are reached the same way — so both open
// on the same lockup rather than one opening on brand and the other on an icon.
// Where the back arrow WAS the only exit, it now sits on the lockup's own row as
// its trailing action, so the panel leaves from the row that announces it
// (bracemark-web's SidebarBody takes its drawer dismiss in exactly that slot).

import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePathname, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import { BrandLockup } from '../../components/brand-lockup';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { SETTINGS_SECTIONS, type SettingsSection } from './sections';

const StyledSafeAreaView = withUniwind(SafeAreaView);

function NavItem({
  section,
  onSelected,
}: {
  section: SettingsSection;
  // Fired after the row commits its navigation — the drawer closes on it.
  onSelected: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const href = `/settings/${section.id}`;
  const active = pathname === href;

  return (
    <Pressable
      onPress={() => {
        router.push(href);
        onSelected();
      }}
      aria-current={active}
      className={cn(
        'w-full flex-row items-center gap-2 rounded-md px-2 py-2 active:bg-muted',
        active && 'bg-muted',
      )}
    >
      <Icon
        as={section.icon}
        className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
      />
      <Text
        numberOfLines={1}
        className={cn(
          'min-w-0 flex-1 text-sm',
          active ? 'font-medium text-foreground' : 'text-muted-foreground',
        )}
      >
        {section.label}
      </Text>
    </Pressable>
  );
}

export function Sidebar({ closeDrawer }: { closeDrawer: () => void }) {
  const router = useRouter();

  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      {/* `h-14` and a hairline under it — the same height and the same rule the
          topbar beside it carries, so the two meet across the frame instead of
          the drawer's header floating a few pixels off the bar it covers. */}
      <View className="h-14 justify-center border-b border-border px-4">
        <BrandLockup
          action={
            <Pressable
              onPress={() => router.push('/links')}
              aria-label="Back to links"
              className="-mr-2 size-9 items-center justify-center rounded-md active:bg-muted"
            >
              <Icon as={ArrowLeft} className="size-5 text-muted-foreground" />
            </Pressable>
          }
        />
      </View>

      {/* The section list. `pt-2` sets it off the hairline; the label above the
          group is deliberately absent — seven rows under a lockup need no
          "Settings" heading to explain them, and the topbar already names the
          one you are in. */}
      <ScrollView className="flex-1 px-2 pt-2" contentContainerClassName="gap-0.5 pb-4">
        {SETTINGS_SECTIONS.map((section) => (
          <NavItem key={section.id} section={section} onSelected={closeDrawer} />
        ))}
      </ScrollView>
    </StyledSafeAreaView>
  );
}
