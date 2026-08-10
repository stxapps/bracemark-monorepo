'use client';

// The searchable, multi-select tag picker shared by every "add tags" surface:
// TagsField wraps it in a popover for the link editors (web quick-add popover,
// extension save editor, edit dialog). The tag sibling of ListCommand — one cmdk
// implementation of the search + list rendering instead of per-surface drift —
// but with the two things tags need that lists don't: it's MULTI-select (a click
// toggles membership and the popover stays open) and it can MINT a tag that
// doesn't exist yet (the "Create" row runs the caller's onCreate, i.e.
// useTagMutations.findOrCreate — reuse-or-mint, so no duplicate is ever forked).
// This list doubles as the old always-on hints: existing tags are the rows, now
// searchable and scrollable. Query state lives here, so a host that unmounts its
// content on close (the popover) resets the search for free.

import { useMemo, useState } from 'react';
import { PlusIcon } from 'lucide-react';

import { flattenTree } from '@stxapps/shared';
import { useTags } from '@stxapps/web-react';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@stxapps/web-ui/components/ui/command';
import { cn } from '@stxapps/web-ui/lib/utils';

export function TagsCommand({
  value,
  onToggle,
  onCreate,
  className,
}: {
  // Chosen tag ids — their rows get the check mark.
  value: string[];
  // Toggle a tag's membership. Multi-select: the caller keeps the popover open.
  onToggle: (tagId: string) => void;
  // Mint a new tag by the typed name and add it. findOrCreate reuses an existing
  // case-insensitive match, so this never forks a duplicate.
  onCreate: (name: string) => void | Promise<void>;
  className?: string;
}) {
  const tags = useTags();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  // Flat rows (the entities are a tree); tag association ignores depth, so we
  // show plain names — matching what the old hint buttons rendered.
  const rows = useMemo(() => flattenTree(tags), [tags]);
  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const filtered = rows.filter((n) => n.item.name.toLowerCase().includes(q));
  // Offer the Create row unless the typed name is empty or already an exact tag
  // (case-insensitive) — an exact match is chosen from the list, not re-minted.
  const canCreate = trimmed !== '' && !rows.some((n) => n.item.name.toLowerCase() === q);

  const create = async () => {
    if (creating || trimmed === '') return;
    setCreating(true);
    try {
      await onCreate(trimmed);
      setQuery('');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Command shouldFilter={false} className={cn('rounded-2xl outline-none', className)}>
      <CommandInput placeholder="Search or create tags…" value={query} onValueChange={setQuery} />
      <CommandList>
        {/* Only shown when there's nothing to pick AND nothing to create (blank
            query, no tags) — otherwise the Create row is the next step. */}
        {!canCreate && <CommandEmpty>No tags found.</CommandEmpty>}
        {filtered.map(({ item }) => (
          <CommandItem
            key={item.id}
            value={item.id}
            data-checked={value.includes(item.id)}
            // cmdk may normalize `value`, so pass the id via closure.
            onSelect={() => onToggle(item.id)}
          >
            <span className="truncate">{item.name}</span>
          </CommandItem>
        ))}
        {canCreate && (
          <CommandItem
            // A fixed, non-id value so cmdk never conflates it with a tag row.
            value="__create__"
            disabled={creating}
            onSelect={() => void create()}
          >
            <PlusIcon />
            <span className="truncate">Create “{trimmed}”</span>
          </CommandItem>
        )}
      </CommandList>
    </Command>
  );
}
