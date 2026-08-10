'use client';

// The tag editor shared by the link editors (web quick-add popover, extension
// save editor, edit dialog): a token combobox. Chosen tags render as removable
// chips in the trigger; opening it drops a searchable, multi-select TagsCommand
// (the tag sibling of ListSelect/ListCommand) whose list IS the "pick an
// existing tag" affordance — the old always-on hint section, now folded into the
// popover and searchable — and whose Create row mints a new tag. Controlled: the
// caller owns the chosen tag-id list; this owns only the popover open state.
// Reuse-or-mint is by name (useTagMutations.findOrCreate, case-insensitive), so
// retyping a known tag never forks a duplicate; the live useTags query renders
// the chip a beat later. Wired to web-react like ListSelect (and the auth
// forms) — see docs/architecture.md on the ui → react-logic layering.

import { type Ref, useId, useMemo, useState } from 'react';
import { ChevronsUpDownIcon, X } from 'lucide-react';

import { treeNameMap } from '@stxapps/shared';
import { useTagMutations, useTags } from '@stxapps/web-react';
import { Popover, PopoverContent, PopoverTrigger } from '@stxapps/web-ui/components/ui/popover';
import { cn } from '@stxapps/web-ui/lib/utils';

import { TagsCommand } from './tags-command';

export function TagsField({
  id,
  value,
  onChange,
  ref,
}: {
  // The labelled form-control id (htmlFor target), landing on the trigger.
  id?: string;
  // The chosen tag ids, in chosen order.
  value: string[];
  onChange: (tagIds: string[]) => void;
  // A ref onto the combobox trigger, so an editor opened straight onto tags can
  // move focus here. Focus rings the trigger and stops — it does NOT open the
  // popover (the token-combobox has no text field to seed; the ring is the
  // "you're on tags" cue, and the user opens the picker deliberately). Radix's
  // PopoverTrigger asChild composes this with its own ref onto the div.
  ref?: Ref<HTMLDivElement>;
}) {
  const tags = useTags();
  const { findOrCreate } = useTagMutations();
  const [open, setOpen] = useState(false);
  // The focus ring is state-driven, not `:focus-visible`: a programmatic
  // `.focus()` (the edit dialog landing on tags) doesn't reliably match
  // `:focus-visible` (the browser gates it on the last input modality), and
  // plain `:focus` blinks off the instant a click opens the popover and moves
  // focus into the search field. Tracking focus ourselves and OR-ing in `open`
  // keeps the ring steady from focus through open until the control is left.
  const [focused, setFocused] = useState(false);
  // aria-controls target: names the popover's list so the combobox trigger is
  // valid even while the content is unmounted (closed).
  const listId = useId();

  // Chosen chips: map ids → names off the live tree. An id with no row yet (a
  // just-minted tag useTags hasn't surfaced) is skipped until it catches up.
  const nameById = useMemo(() => treeNameMap(tags), [tags]);
  const chosen = value
    .map((tid) => ({ id: tid, name: nameById.get(tid) }))
    .filter((t): t is { id: string; name: string } => t.name !== undefined);

  const toggle = (tagId: string) => {
    onChange(value.includes(tagId) ? value.filter((t) => t !== tagId) : [...value, tagId]);
  };
  const create = async (name: string) => {
    const tag = await findOrCreate(name);
    if (tag && !value.includes(tag.id)) onChange([...value, tag.id]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* A div, not a Button: each chip carries its own ✕ button, and a button
            nested in a button is invalid HTML. role/tabIndex + the key handler
            give it the combobox affordances by hand (Radix wires the click). */}
        <div
          ref={ref}
          id={id}
          role="combobox"
          aria-controls={listId}
          aria-expanded={open}
          tabIndex={0}
          className={cn(
            'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-2xl border',
            'bg-input/30 px-3 py-1.5 text-sm outline-none',
            focused || open ? 'border-ring ring-[3px] ring-ring/50' : 'border-input',
          )}
          // onFocus/onBlur (React's bubbling focusin/focusout) also cover focus
          // moving to a chip's ✕ button inside the div — that stays "focused".
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          {chosen.length > 0 ? (
            chosen.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
              >
                {t.name}
                <button
                  type="button"
                  aria-label={`Remove ${t.name}`}
                  className="inline-flex"
                  // Don't let removing a chip open the popover.
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(value.filter((id) => id !== t.id));
                  }}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">Add tags</span>
          )}
          <ChevronsUpDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </div>
      </PopoverTrigger>
      {/* Not portalled — same reason as ListSelect: this also opens inside the
          edit Dialog, whose modal scroll-lock would swallow wheel/trackpad
          scrolling over a body-portalled popover. */}
      <PopoverContent
        id={listId}
        align="start"
        portal={false}
        className="w-(--radix-popover-trigger-width) min-w-56 p-0"
      >
        <TagsCommand value={value} onToggle={toggle} onCreate={create} />
      </PopoverContent>
    </Popover>
  );
}
