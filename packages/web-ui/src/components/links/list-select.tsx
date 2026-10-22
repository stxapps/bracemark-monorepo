'use client';

// The list picker shared by the link editors — the web quick-add popover, the
// extension's save editor, and the edit dialog — so the three surfaces render one
// picker over the same live list tree instead of drifting. Wired straight to
// web-react's useLists (via list-command), the same way the auth forms pair
// shared field UI with their web-react submit hooks (docs/architecture.md —
// web-ui may depend on the React-logic layer, never the reverse).
//
// A Combobox: a form-control trigger opening ListCommand (list-command.tsx),
// which owns the search/tree/path rendering. The trigger shows the selected
// list's ancestor path — the popup row's context shouldn't vanish once it
// closes. Query state resets on close because the popover unmounts its content.
//
// `allowCreate` adds ListCommand's Create row, wired to useListMutations'
// `createTopLevel` — the list counterpart of TagsField's mint (see
// tags-field.tsx). Two decisions worth keeping:
//
// - **The editors create INLINE rather than linking out to Settings → Lists.**
//   A "manage lists" link like the sidebar's FooterLink works there because the
//   sidebar holds no draft; every editor does, and navigating away destroys it —
//   the quick-add popover would drop the typed URL/note it otherwise guards with
//   `advancedDirty`, and the extension popup would be killed outright by
//   `tabs.create` (a popup dismisses on focus loss, uninterceptably). "Add a
//   list" is a sub-task of the save; an answer that ends the save isn't one.
//   The link "Move to" surfaces create inline for the same reason, with a
//   selection standing in for the draft (link-move-surface.tsx).
// - **The create is TOP-LEVEL ONLY (`parentId: null`, index 0)** — no parent
//   picker, matching where the Lists settings CreateRow puts a new list, so the
//   same action lands the same place wherever it's invoked. That's what keeps
//   this cheap despite lists being a tree while tags are flat: `useListMutations
//   .create` needs a position, but nesting is non-destructive to defer (`move` is
//   a one-field `{ parentId, rank }` write), and rebuilding the settings tree
//   editor — drag, depth projection — inside a 320px popover would be absurd.
//   Someone who wants it nested files the link now and reparents later, losing
//   nothing.

import { useState } from 'react';
import { ChevronsUpDownIcon } from 'lucide-react';

import { useListMutations } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@stxapps/web-ui/components/ui/popover';

import { ListCommand, ListPathLabel, useListRows } from './list-command';

export function ListSelect({
  id,
  value,
  onValueChange,
  excludeIds,
  allowCreate,
}: {
  // The labelled form-control id (htmlFor target), landing on the trigger.
  id?: string;
  value: string;
  onValueChange: (listId: string) => void;
  // List ids to leave out of the options — e.g. Trash in the editors, where
  // trashing is its own explicit action, never a "move". Trash is a leaf
  // (LIST_NO_CHILDREN_IDS), so excluding it never orphans indented children.
  excludeIds?: readonly string[];
  // Offer a Create row that mints a top-level list by the typed name and selects
  // it. The three link editors opt in (see the header); it's a prop rather than
  // a default so that a ListSelect which must only choose among existing lists
  // stays one line away.
  allowCreate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { createTopLevel } = useListMutations();
  const selected = useListRows(excludeIds).find((row) => row.item.id === value);

  // Select the new list right away; its row reaches the trigger a beat later,
  // when useLists catches up, so until then the trigger reads "Choose a list"
  // (the same catch-up gap TagsField's chips have). A blank name returns null —
  // nothing to select.
  const onCreate = async (name: string) => {
    const list = await createTopLevel(name);
    if (list) {
      onValueChange(list.id);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          // `text-base md:text-sm` — the control type step (input.tsx). A
          // `Button` carries a flat `text-sm`, which put this trigger 2px under
          // the Input and Textarea beside it in every editor on a phone.
          className="w-full justify-between text-base font-normal md:text-sm"
        >
          {selected ? (
            <ListPathLabel ancestors={selected.ancestors} name={selected.item.name} />
          ) : (
            <span className="text-muted-foreground">Choose a list</span>
          )}
          <ChevronsUpDownIcon data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      {/* Not portalled: this picker also opens inside the edit Dialog, whose
          modal scroll-lock would otherwise swallow wheel/trackpad scrolling
          over a body-portalled popover (see PopoverContent's `portal`). */}
      <PopoverContent
        align="start"
        portal={false}
        className="w-(--radix-popover-trigger-width) min-w-48 p-0"
      >
        <ListCommand
          value={value}
          excludeIds={excludeIds}
          onCreate={allowCreate ? onCreate : undefined}
          onSelect={(listId) => {
            onValueChange(listId);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
