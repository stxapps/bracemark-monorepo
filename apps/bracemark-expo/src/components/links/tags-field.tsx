import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { ChevronsUpDown } from 'lucide-react-native';

import { useTagMutations, useTags } from '@stxapps/expo-react';
import { treeNameMap } from '@stxapps/shared';

import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Icon } from '../ui/icon';
import { Text } from '../ui/text';
import { TagsCommand } from './tags-command';

// Two names preserve the common case without letting this disclosure control
// become the tag editor itself. The picker holds the complete selection.
const MAX_VISIBLE_SELECTED_TAGS = 2;

// The tag field for the link editors — the add panel and the edit screen — and
// the native cousin of web-ui's TagsField: a compact combobox trigger. Chosen
// tags render as a single-line summary; pressing it opens the searchable,
// multi-select TagsCommand, whose Create row mints by name
// through useTagMutations.findOrCreate (case-insensitive reuse, top-level index
// 0 — the immediate-create web rule; this runs in-process, so it does NOT copy
// the share sheet's deferral, docs/editors.md). Web's popover is a Dialog here,
// for ListSelect's reason: a phone has no anchored popover to drop the picker
// into, least of all from a field inside a panel parked on the keyboard.
//
// The trigger shows only what the user CHOSE, within one fixed-height row — the
// whole point of the split. The picker used to render inline under an input and
// bounded nothing (tags-command.tsx records what it did to the add panel).
//
// The dialog does not close on a press, where ListSelect's does: tags are a set,
// so Done is the way out (share-tags-picker.tsx makes the same call). Query
// state resets on close for free: the Dialog unmounts its content.
//
// Controlled: the caller owns the chosen tag-id list; this owns only the open
// state.

export function TagsField({
  value,
  onChange,
}: {
  // The chosen tag ids, in chosen order.
  value: string[];
  onChange: (tagIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const tags = useTags();
  const { findOrCreate } = useTagMutations();

  // Chosen names: ids → names off the live tree. An id with no row yet (a
  // just-minted tag useTags hasn't surfaced) is skipped until it catches up.
  const nameById = useMemo(() => treeNameMap(tags), [tags]);
  const chosen = value
    .map((id) => ({ id, name: nameById.get(id) }))
    .filter((t): t is { id: string; name: string } => t.name !== undefined);
  const visibleChosen = chosen.slice(0, MAX_VISIBLE_SELECTED_TAGS);
  const hiddenChosenCount = chosen.length - visibleChosen.length;

  const toggle = (tagId: string) => {
    onChange(value.includes(tagId) ? value.filter((t) => t !== tagId) : [...value, tagId]);
  };
  const create = async (name: string) => {
    const tag = await findOrCreate(name);
    if (tag && !value.includes(tag.id)) onChange([...value, tag.id]);
  };

  // No Keyboard.dismiss here: DialogContent drops the keyboard on open, which
  // puts away the field the editors' `"handled"` scrollers leave focused behind
  // the dialog (ui/dialog.tsx). The picker is a list first and a search box
  // second (docs/editors.md, the MoveToSurface note): the filter input is one
  // tap away.
  const openPicker = () => setOpen(true);

  return (
    <>
      {/* A single-row outline Button, exactly like ListSelect above it — and
          exactly like it down to the box and the type: `px-3` over the size's
          `px-4`, and `text-base leading-5 font-normal` restated on the Texts
          because nothing cascades here. The leading is not decoration — it is
          the Input's own pairing, and a bare `text-base` label's 24pt line box
          is what used to lose the g of `Add tags` off the bottom edge.
          ListSelect's trigger comment carries the derivation for both.

          All tag toggling now happens in the dialog's full-width checkbox rows,
          so this trigger neither grows with the selection nor nests removal
          Pressables that VoiceOver would collapse. Each of the first two visible
          names truncates independently and a fixed `+N` counts the rest; the
          accessible name still carries every chosen tag. */}
      <Button
        variant="outline"
        onPress={openPicker}
        // Button's default role is spread before caller props, so this replaces
        // it with the field's actual composite-control role.
        role="combobox"
        aria-expanded={open}
        aria-label={chosen.length > 0 ? `Tags: ${chosen.map((t) => t.name).join(', ')}` : 'Tags'}
        className="justify-between px-3"
      >
        {chosen.length > 0 ? (
          <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
            {visibleChosen.map((tag, index) => (
              <Text
                key={tag.id}
                numberOfLines={1}
                className="min-w-0 shrink text-base leading-5 font-normal"
              >
                {tag.name}
                {index < visibleChosen.length - 1 ? ',' : ''}
              </Text>
            ))}
            {hiddenChosenCount > 0 && (
              <View
                aria-label={`${hiddenChosenCount} more selected ${hiddenChosenCount === 1 ? 'tag' : 'tags'}`}
                className="shrink-0 rounded-full bg-input px-2 py-0.5"
              >
                <Text className="text-xs">+{hiddenChosenCount}</Text>
              </View>
            )}
          </View>
        ) : (
          <Text
            numberOfLines={1}
            className="min-w-0 flex-1 text-base leading-5 font-normal text-muted-foreground"
          >
            Add tags
          </Text>
        )}
        <Icon as={ChevronsUpDown} className="size-4 shrink-0 text-muted-foreground" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose tags</DialogTitle>
          </DialogHeader>
          <TagsCommand value={value} onToggle={toggle} onCreate={create} />
          <DialogFooter>
            <Button size="sm" onPress={() => setOpen(false)}>
              <Text>Done</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
