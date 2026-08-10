import { Pressable, View } from 'react-native';

import { type LinkView } from '@stxapps/expo-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Text } from '../../components/ui/text';
import { useLinksPage } from './page-provider';
import { useEngagedOpen } from './shared';
import { useLinksViewState } from './view-state-provider';

// How many tag chips an item shows before collapsing the rest behind "+N" — the
// budget stand-in for web's measured maxLines overflow.
const MAX_CHIPS = 3;

const TAG_CHIP_CLASS = 'bg-muted active:bg-muted/70 rounded-full px-2 py-0.5';

// The item's tag-chip strip — web's LinkTagChips (`_layouts/shared/
// link-tag-chips.tsx`), minus the measured overflow (MAX_CHIPS above stands
// in): one pressable chip per tag, in the link's own `tagIds` order, each
// navigating to that tag's view via setSimpleQuery — the same canonical
// `/links?tag=…` URL the drawer writes. In bulk-edit mode a chip toggles the
// item's selection instead, matching the item press. Ids the map doesn't know
// (a tag deleted / not yet synced) are skipped; no tags renders nothing, so
// callers can place it unconditionally.
//
// The chips sit INSIDE the item's Pressable — fine on this platform: RN's
// responder hands the touch to the innermost pressable, so a chip press never
// also fires the item (web needed the chips outside the row's <a> instead).
// "+N" opens the overflow tags as a dropdown (the popover stand-in — same
// portaled content, same engagement reporting via useEngagedOpen); in bulk-edit
// mode it toggles selection like every other chip (no menu), web verbatim.
export function LinkTagChips({
  link,
  tagsById,
  className = '',
}: {
  link: LinkView;
  tagsById: Map<string, string>;
  className?: string;
}) {
  const { setSimpleQuery } = useLinksPage();
  const { bulkEditing, toggleSelected } = useLinksViewState();
  const [, onOverflowOpenChange] = useEngagedOpen();

  const chips = link.tagIds
    .map((id) => ({ id, name: tagsById.get(id) }))
    .filter((c): c is { id: string; name: string } => c.name !== undefined);
  if (chips.length === 0) return null;
  const overflow = chips.slice(MAX_CHIPS);

  const onTagPress = (id: string) =>
    bulkEditing ? toggleSelected(link) : setSimpleQuery({ kind: 'tag', id });

  return (
    <View className={`flex-row items-center gap-1 overflow-hidden ${className}`}>
      {chips.slice(0, MAX_CHIPS).map((chip) => (
        <Pressable
          key={chip.id}
          onPress={() => onTagPress(chip.id)}
          className={`shrink ${TAG_CHIP_CLASS}`}
        >
          <Text numberOfLines={1} className="text-xs text-muted-foreground">
            {chip.name}
          </Text>
        </Pressable>
      ))}
      {overflow.length > 0 &&
        (bulkEditing ? (
          <Pressable onPress={() => toggleSelected(link)} className={`shrink-0 ${TAG_CHIP_CLASS}`}>
            <Text className="text-xs text-muted-foreground">+{overflow.length}</Text>
          </Pressable>
        ) : (
          <DropdownMenu onOpenChange={onOverflowOpenChange}>
            <DropdownMenuTrigger asChild>
              <Pressable
                aria-label={`Show ${overflow.length} more ${overflow.length === 1 ? 'tag' : 'tags'}`}
                className={`shrink-0 ${TAG_CHIP_CLASS}`}
              >
                <Text className="text-xs text-muted-foreground">+{overflow.length}</Text>
              </Pressable>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-64">
              {overflow.map((chip) => (
                <DropdownMenuItem key={chip.id} onPress={() => onTagPress(chip.id)}>
                  <Text numberOfLines={1}>{chip.name}</Text>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
    </View>
  );
}
