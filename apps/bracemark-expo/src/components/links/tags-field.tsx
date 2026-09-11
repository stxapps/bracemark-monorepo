import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronsUpDown, X } from 'lucide-react-native';

import { useTagMutations, useTags } from '@stxapps/expo-react';
import { treeNameMap } from '@stxapps/shared';

import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Icon } from '../ui/icon';
import { Text } from '../ui/text';
import { TagsCommand } from './tags-command';

// The tag field for the link editors — the add panel and the edit screen — and
// the native cousin of web-ui's TagsField (that header is canonical): a token
// combobox. Chosen tags render as removable chips in the trigger; pressing it
// opens the searchable, multi-select TagsCommand, whose Create row mints by name
// through useTagMutations.findOrCreate (case-insensitive reuse, top-level index
// 0 — the immediate-create web rule; this runs in-process, so it does NOT copy
// the share sheet's deferral, docs/editors.md). Web's popover is a Dialog here,
// for ListSelect's reason: a phone has no anchored popover to drop the picker
// into, least of all from a field inside a panel parked on the keyboard.
//
// The trigger shows only what the user CHOSE, which the user bounds — the whole
// point of the split. The cloud used to render inline under an input and bounded
// nothing (tags-command.tsx records what it did to the add panel).
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

  // Chosen chips: ids → names off the live tree. An id with no row yet (a
  // just-minted tag useTags hasn't surfaced) is skipped until it catches up.
  const nameById = useMemo(() => treeNameMap(tags), [tags]);
  const chosen = value
    .map((id) => ({ id, name: nameById.get(id) }))
    .filter((t): t is { id: string; name: string } => t.name !== undefined);

  const toggle = (tagId: string) => {
    onChange(value.includes(tagId) ? value.filter((t) => t !== tagId) : [...value, tagId]);
  };
  const remove = (tagId: string) => onChange(value.filter((t) => t !== tagId));
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
      {/* A Pressable, not ListSelect's Button: the chips WRAP, so the box has a
          minimum height rather than a fixed one — and Button's size variants
          are fixed heights. The chrome is the Input's instead (`border-input
          bg-input/30`, `min-h-10 sm:min-h-9` for its `h-10 sm:h-9`), plus
          outline Button's press fill. `rounded-3xl` rather than the Input's
          `rounded-4xl` or web's `rounded-2xl`: 24 on a one-row 40pt box
          resolves to 20, the same pill as the Input above it, and stays a
          rounded rectangle once the chips wrap (docs/theme.md, _the radius
          scale_).

          The ✕s are Pressables nested in this one. A touch lands on the
          innermost responder, so a ✕ removes and the rest of the box opens —
          but for VoiceOver this box is ONE element (`accessible` collapses its
          children), so each removal is also a custom action on it, where the
          rotor offers it. `activate` is declared for the same reason: without
          it iOS activates by simulating a tap at the element's centre, which on
          a wrapped trigger can be a chip's ✕. The name carries the chosen tags
          ("Tags: reading, work"), the ShareRow idiom — say what the control is,
          then its value (docs/accessibility.md). */}
      <Pressable
        onPress={openPicker}
        role="combobox"
        aria-expanded={open}
        aria-label={chosen.length > 0 ? `Tags: ${chosen.map((t) => t.name).join(', ')}` : 'Tags'}
        accessibilityActions={[
          { name: 'activate' },
          ...chosen.map((t) => ({ name: `remove:${t.id}`, label: `Remove ${t.name}` })),
        ]}
        onAccessibilityAction={(e) => {
          const action = e.nativeEvent.actionName;
          if (action === 'activate') openPicker();
          else if (action.startsWith('remove:')) remove(action.slice('remove:'.length));
        }}
        className="min-h-10 w-full flex-row items-center gap-2 rounded-3xl border border-input bg-input/30 py-1.5 pr-3 pl-2 active:bg-input/50 sm:min-h-9"
      >
        <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5">
          {chosen.length > 0 ? (
            chosen.map((t) => (
              // `bg-input`, web's chip: it separates from the trigger's own
              // `bg-input/30` in both themes (docs/theme.md, `--input` is three
              // roles). `max-w-full` so one long name truncates instead of
              // overflowing the box.
              <View
                key={t.id}
                className="max-w-full flex-row items-center gap-1 rounded-full bg-input py-0.5 pr-1.5 pl-2.5"
              >
                <Text numberOfLines={1} className="shrink text-sm">
                  {t.name}
                </Text>
                <Pressable
                  role="button"
                  aria-label={`Remove ${t.name}`}
                  onPress={() => remove(t.id)}
                  hitSlop={8}
                  className="rounded-full p-0.5 active:bg-muted"
                >
                  <Icon as={X} className="size-3.5 text-muted-foreground" />
                </Pressable>
              </View>
            ))
          ) : (
            // `pl-1` puts the placeholder on the Input's `px-3` text edge — the
            // box's own `pl-2` is the chips' inset, one step tighter.
            <Text numberOfLines={1} className="pl-1 text-base text-muted-foreground">
              Add tags
            </Text>
          )}
        </View>
        <Icon as={ChevronsUpDown} className="size-4 shrink-0 text-muted-foreground" />
      </Pressable>
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
