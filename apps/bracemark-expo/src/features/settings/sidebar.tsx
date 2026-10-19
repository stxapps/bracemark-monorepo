// The settings drawer's content — the expo port of bracemark-web's
// `(app)/settings/_panes/sidebar.tsx`: the brand lockup pinned at the top over
// the section menu (Account, Subscription, Data, Lists, Tags, Misc., About).
// Each entry navigates to `/settings/[section]`; the active one is derived from
// the pathname (the URL is the source of truth), and the matching section route
// renders the content. On a phone-width window the rail is a Drawer (this
// group's _layout), so selecting an entry also closes it — the links sidebar's
// pattern; on a wide one it is docked beside the pane and the close is a no-op.
//
// THE LOCKUP REPLACED A BARE BACK ARROW, and the swap is the point: a drawer
// slid over the app is the one moment the user can't see which app they are in,
// and both this rail and the links rail are reached the same way — so both open
// on the same lockup rather than one opening on brand and the other on an icon.
//
// THE ARROW DID NOT MOVE ONTO THE LOCKUP'S ROW — IT WENT AWAY. It sat there for
// a while as the lockup's trailing action, on the reading that "the panel leaves
// from the row that announces it", and citing bracemark-web's SidebarBody as the
// precedent. That citation was the wrong slot: on web that action is the LINKS
// drawer's `SheetClose` (`links/_panes/sidebar-drawer.tsx` — a ✕ named "Close
// navigation"), which closes the drawer and leaves nothing. Web's SETTINGS rail
// carries no action at all, and its header is the record for why — a bare back
// arrow in a rail's top-RIGHT corner is anchored to nothing, and it duplicates
// the topbar's ✕. Leaving settings is the topbar's job, in one place, where a
// close control is looked for: every section renders that bar
// (`(app)/settings/[section].tsx`, and `/settings` redirects to a concrete
// section), so the ✕ is always one press away.
//
// RE-SKINNING IT AS A ✕ WOULD HAVE BEEN WORSE, not better, which is the part
// worth writing down. The arrow's real fault was never its direction — iOS pops
// a card rightward under a back chevron all day, and `settings` is an ordinary
// stack card — it was a LEADING-edge affordance parked in a TRAILING slot with
// no destination beside it, plus one action (`closeSettings`) wearing two icons
// and two names. But in a drawer header a ✕ means CLOSE THIS DRAWER, as it does
// in this very product, while this control left the whole surface: the arrow was
// misread, and a ✕ would have been misread more confidently, with a worse
// outcome behind the misreading.
//
// What the drawer keeps are its three ordinary dismissals — the scrim, a left
// swipe, picking a section — and every one of them uncovers the bar. The cost,
// taken deliberately: the drawer covers the topbar, so leaving settings from
// inside the drawer is two actions rather than one. That is a rare path; this
// drawer is opened to switch sections. Both expo rails are now the same header —
// `h-14`, a hairline, a bare BrandLockup — and so is web's.

import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePathname, useRouter } from 'expo-router';
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
      role="button"
      testID={`settings-nav-${section.id}`}
      onPress={() => {
        router.push(href);
        onSelected();
      }}
      // NOT `aria-current`, which the web twin uses: RN declares 14 `aria-*`
      // props and that isn't one of them, so it was inert here and the active
      // section announced no differently from the rest. `accessibilityState`
      // is the spelling that maps (→ the selected trait on both platforms);
      // `aria-selected` would map too, but jsx-a11y rejects it on `button`.
      accessibilityState={{ selected: active }}
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
  return (
    // `bg-popover` + `border-r`: the drawer's lifted fill and its one edge, the
    // same pair the links rail wears — features/links/sidebar.tsx carries the
    // reasoning (in dark the scrim separates nothing, and the navigator draws
    // no edge for a `front` drawer).
    <StyledSafeAreaView className="flex-1 border-r border-border bg-popover">
      {/* `h-14` and a hairline under it — the same height and the same rule the
          topbar beside it carries, so the two meet across the frame instead of
          the drawer's header floating a few pixels off the bar it covers. */}
      <View className="h-14 justify-center border-b border-border px-4">
        <BrandLockup />
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
