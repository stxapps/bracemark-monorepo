// The bar above the reader AND the capture screen — the two faces of one place
// (docs/reader.md, _the way in_), which trade places by `router.replace` and so must
// not shift as they do. The expo twin of bracemark-web's
// `(app)/read/_components/topbar.tsx`, in its order: the host on the left; on
// the right the screen's actions, a divider, then the ✕ (docs/reader.md, _the expo
// reader_).
//
//   - THE ACTIONS ARE ONE ⋯ MENU, NOT A ROW OF ICONS. The reader has three (_Open
//     page_, _Update from the page_, the Wayback Machine) and no room for a word, and
//     as bare icons two of them read alike — RefreshCw and History are both a circular
//     arrow. In the menu each has its name beside its glyph. The cost is a second tap
//     to _Open page_; the gain is that no action is a guess. Web's bar is the same
//     shape, with its two ways out in the menu, so the reader looks alike on both.
//   - THE ✕ IS LAST, past a divider, as on web and in Settings' bar: it closes the
//     screen, it is not one more action, and it sits in the corner the other bars put
//     theirs. Not a back arrow on the left: the leading slot on this app's bars is the
//     drawer's, and the ✕ is how Settings is left too.
//   - BEHIND A LOCK THE HOST GOES, and the menu with it — the host is the locked
//     list's contents (docs/locks.md, _the two enforcement edges_). Enforced here,
//     whatever the caller passes, so neither screen can print it above its unlock
//     pane: both once did, because each computed its own label.
//   - THE LINKS AND SETTINGS BARS' BOXES. `icon-sm` (36) with `hitSlop` making up the
//     44/48 floors, glyphs `size-5` (links/topbar.tsx has both rules at length). The ⋯
//     and the ✕ are 9 apart (`gap-1`, the 1px divider, `gap-1`), so each takes 4 of
//     that gap — never more than half the gap to a pressable neighbour, since RN
//     resolves overlapping slop by tree order and the loser's visible box gets eaten.

import { View } from 'react-native';
import { type LucideIcon, MoreHorizontal, X } from 'lucide-react-native';

import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';

export type ReaderTopbarAction = {
  label: string;
  icon: LucideIcon;
  testID: string;
  onPress: () => void;
};

// `topbar.tsx`, like links' and Settings', but exported as ReaderTopbar rather than
// their bare `Topbar`: the capture screen imports it from another feature, where a
// bare name would not say whose bar it is. Web's twin has the same file and export
// names.
export function ReaderTopbar({
  host,
  locked,
  fallback,
  actions,
  closeLabel,
  testIDPrefix,
  onClose,
}: {
  host: string;
  locked: boolean;
  // The label while there is no host to show — behind a lock, or before the link reads.
  fallback: string;
  actions: ReaderTopbarAction[];
  closeLabel: string;
  testIDPrefix: 'reader' | 'capture';
  onClose: () => void;
}) {
  const shown = locked ? [] : actions;
  const label = !locked && host ? host : fallback;

  return (
    <View className="h-14 shrink-0 flex-row items-center gap-2 border-b border-border px-3">
      <Text
        testID={`${testIDPrefix}-title`}
        className="min-w-0 flex-1 pl-1 text-sm font-medium text-muted-foreground"
        numberOfLines={1}
      >
        {label}
      </Text>
      <View className="flex-row items-center gap-1">
        {shown.length > 0 ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  testID={`${testIDPrefix}-more-options`}
                  aria-label="More options"
                  // The label to its left is a Text, so the full 6 that way.
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 4 }}
                >
                  <Icon as={MoreHorizontal} className="size-5 text-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-36">
                {shown.map((action) => (
                  <DropdownMenuItem
                    key={action.testID}
                    testID={action.testID}
                    onPress={action.onPress}
                  >
                    <Icon as={action.icon} className="size-4" />
                    <Text>{action.label}</Text>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <View aria-hidden className="h-4 w-px bg-border" />
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          testID={`${testIDPrefix}-close`}
          aria-label={closeLabel}
          hitSlop={{ top: 6, bottom: 6, left: shown.length > 0 ? 4 : 6, right: 6 }}
          // Pulled to the frame edge, as Settings' ✕ is, so its glyph lands where
          // that one's does.
          className="-mr-1"
          onPress={onClose}
        >
          <Icon as={X} className="size-5 text-foreground" />
        </Button>
      </View>
    </View>
  );
}
