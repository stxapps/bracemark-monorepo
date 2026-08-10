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
// `allowCreate` adds ListCommand's Create row, wired to useListMutations —
// the list counterpart of TagsField's mint (see tags-field.tsx). Two decisions
// worth keeping:
//
// - **The editors create INLINE rather than linking out to Settings → Lists.**
//   A "manage lists" link like the sidebar's FooterLink works there because the
//   sidebar holds no draft; every editor does, and navigating away destroys it —
//   the quick-add popover would drop the typed URL/note it otherwise guards with
//   `advancedDirty`, and the extension popup would be killed outright by
//   `tabs.create` (a popup dismisses on focus loss, uninterceptably). "Add a
//   list" is a sub-task of the save; an answer that ends the save isn't one.
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

import { useListMutations, useLists } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@stxapps/web-ui/components/ui/popover';

import { ListCommand, useListRows } from './list-command';

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
  // it. The three link editors opt in (see the header); a picker that only
  // reassigns an existing link — a future bulk "Move to" — should not.
  allowCreate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lists = useLists();
  const { create } = useListMutations();
  const selected = useListRows(excludeIds).find((row) => row.item.id === value);

  // Prepend to the root group — `lists` IS that group (useLists returns the top
  // level), and index 0 matches the settings CreateRow. Select the new list right
  // away; its row reaches the trigger a beat later, when useLists catches up, so
  // until then the trigger reads "Choose a list" (the same catch-up gap TagsField's
  // chips have). A blank name returns null — nothing to select.
  const onCreate = async (name: string) => {
    const list = await create(
      name,
      null,
      lists.map((node) => node.item),
      0,
    );
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
          className="w-full justify-between font-normal"
        >
          {selected ? (
            <span className="truncate">
              {selected.ancestors.length > 0 && (
                <span className="text-muted-foreground">
                  {selected.ancestors.join(' / ')}
                  {' / '}
                </span>
              )}
              {selected.item.name}
            </span>
          ) : (
            <span className="text-muted-foreground">Choose a list</span>
          )}
          <ChevronsUpDownIcon className="text-muted-foreground" />
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
