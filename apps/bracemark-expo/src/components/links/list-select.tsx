import { useState } from 'react';
import { ChevronsUpDown } from 'lucide-react-native';

import { useListMutations, useLists } from '@stxapps/expo-react';

import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Icon } from '../ui/icon';
import { Text } from '../ui/text';
import { ListCommand, useListRows } from './list-command';

// The list picker for the link editors — the native cousin of web-ui's
// ListSelect + ListCommand pair (those headers are canonical: the combobox
// shape, why the editors create INLINE and why the create is TOP-LEVEL ONLY).
// A phone has no anchored popover to drop a tree into, so the shell is a
// form-control trigger opening a Dialog (the MoveToDialog idiom) whose body is
// the shared ListCommand (list-command.tsx — the search/tree/path rendering
// and the Create row). The trigger shows the selected list's ancestor path —
// the popup row's context shouldn't vanish once it closes.
//
// `allowCreate` wires ListCommand's Create row to useListMutations: creates
// land top-level at index 0 and select immediately — this editor runs
// in-process, so it creates the entity the moment the name is confirmed (the
// web rule, NOT the share sheet's deferred-to-Add machinery, which exists only
// for its process split — see docs/editors.md).
//
// Query state resets on close for free: the Dialog unmounts its content.
// Callers filter only TRASH_ID — never hidden/locked lists (docs/editors.md).

export function ListSelect({
  value,
  onValueChange,
  excludeIds,
  allowCreate,
}: {
  value: string;
  onValueChange: (listId: string) => void;
  // List ids to leave out of the options — e.g. Trash in the editors, where
  // trashing is its own explicit action, never a "move".
  excludeIds?: readonly string[];
  // Offer the Create row (see the header) — the editors opt in; a picker that
  // only reassigns an existing link must not.
  allowCreate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lists = useLists();
  const { create } = useListMutations();
  const selected = useListRows(excludeIds).find((row) => row.item.id === value);

  const select = (listId: string) => {
    onValueChange(listId);
    setOpen(false);
  };

  // Prepend to the root group — `lists` IS that group (useLists returns the
  // top level), and index 0 matches the settings CreateRow. Select the new
  // list right away; its row reaches the trigger a beat later, when useLists
  // catches up (the same catch-up gap web's trigger has). A blank name returns
  // null — nothing to select.
  const onCreate = async (name: string) => {
    const list = await create(
      name,
      null,
      lists.map((node) => node.item),
      0,
    );
    if (list) select(list.id);
  };

  return (
    <>
      {/* The trigger is the kit's `outline` Button, as web's is
          (web-ui/components/links/list-select.tsx) — same box, same fill, same
          edge as the Input it sits beside in every editor. `px-3` is restated
          because the native default size carries `px-4` where web's carries
          `px-3` (ui/button.tsx's header records that drift), which is what puts
          this label on the Input's text edge; and the type is restated on the
          Texts below: web puts `text-base font-normal` on the button and lets it
          cascade, which native cannot do — the label would otherwise take the
          kit's `text-sm font-medium` and sit 2px under the Input beside it, the
          exact defect web's comment there records.

          `leading-5` IS PART OF THAT TYPE, not a nudge. `text-base` alone
          carries Tailwind's paired 1.5 line-height — a 24pt box for a 16pt font
          — and while the default size still carried `py-2` there were only 22pt
          inside `h-10` to measure it against: the paragraph's frame was clamped
          to 22 and iOS, having dropped the glyphs by half the box's surplus over
          Inter's natural 1.21×, cut the DESCENDER off the bottom — the y of `My
          List` here, the g of `Add tags` in tags-field.tsx. That padding is now
          gone from the kit (ui/button.tsx carries the derivation, and it was
          clipping every default-size label at one Dynamic Type step up), so what
          this class is for is the Input's own pairing: `text-base leading-5`,
          measured-centred as a `Text` (docs/theme.md, _extending_), which is
          what keeps the two controls on one baseline. */}
      <Button
        variant="outline"
        // No Keyboard.dismiss: DialogContent drops the keyboard on open, so
        // the field focused before this press (the add panel's URL, most often)
        // can't take keystrokes unseen behind the dialog (ui/dialog.tsx).
        onPress={() => setOpen(true)}
        accessibilityRole="combobox"
        aria-expanded={open}
        aria-label="List"
        className="justify-between px-3"
      >
        {selected ? (
          <Text numberOfLines={1} className="min-w-0 flex-1 text-base leading-5 font-normal">
            {selected.ancestors.length > 0 && (
              <Text className="text-muted-foreground">{`${selected.ancestors.join(' / ')} / `}</Text>
            )}
            {selected.item.name}
          </Text>
        ) : (
          <Text
            numberOfLines={1}
            className="min-w-0 flex-1 text-base leading-5 font-normal text-muted-foreground"
          >
            Choose a list
          </Text>
        )}
        <Icon as={ChevronsUpDown} className="size-4 shrink-0 text-muted-foreground" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose a list</DialogTitle>
          </DialogHeader>
          <ListCommand
            value={value}
            excludeIds={excludeIds}
            onCreate={allowCreate ? onCreate : undefined}
            onSelect={select}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
