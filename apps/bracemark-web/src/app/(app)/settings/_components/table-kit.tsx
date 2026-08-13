'use client';

// The editable-table kit: the parts the Lists and Tags sections share.
//
// WHY THIS EXISTS — the same argument settings-kit.tsx makes, one level down.
// settings-kit is the design system for a settings SECTION (the pane, the
// headings, the bordered row, the notice). Lists and Tags are not that shape:
// they are editable tables, and the two of them had a byte-identical create row,
// rename field, sort menu, drag grip and error runner typed out twice. That is
// not "self-contained by design", it is two copies drifting — and they did drift:
// a create-row focus bug had to be fixed twice in a row, in identical terms, in
// both files.
//
// What belongs here is what both tables have in common. What does NOT is
// everything the two tables genuinely disagree about: Lists nests (depth,
// projection, "Move to", locks), Tags is flat — those stay in their sections,
// where the disagreement is the point. The rule of thumb: if a change to one
// table should obviously happen to the other, it lives here.
//
// The expo port is `features/settings/table-kit.tsx`, component for component.
// Pure ordering (`sortedByName`, `SortDir`) is neither platform's business and
// lives in `@stxapps/shared` (sync/sort.ts), one copy for all four tables.

import { useRef, useState } from 'react';
import { ArrowDownAZ, ArrowDownZA, ArrowUpDown, Check, GripVertical, Plus, X } from 'lucide-react';

import type { SortDir } from '@stxapps/shared';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';
import { Input } from '@stxapps/web-ui/components/ui/input';

// One error slot plus the two ways these tables fire a mutation at it. Both
// clear the slot first, so the notice always describes the latest attempt.
//
// The asymmetry in what they take is deliberate: `run` takes the promise (the
// mutation is already in flight and the row shows its optimistic result), while
// `runAwait` takes a THUNK so that a synchronous throw out of the mutation call
// itself lands in the same catch — which is what the create path's hand-written
// try/catch did before it moved here.
export function useOpRunner() {
  const [error, setError] = useState<string | null>(null);
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // Fire-and-forget: surface a failure in the notice, that's all.
  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(message(e)));
  };

  // Awaited: CreateRow clears its field only on success, so this re-throws after
  // recording the message, which keeps the typed value for a retry.
  const runAwait = async <T,>(op: () => Promise<T>): Promise<T> => {
    setError(null);
    try {
      return await op();
    } catch (e) {
      setError(message(e));
      throw e;
    }
  };

  return { error, run, runAwait };
}

// The create-an-item row pinned at the top of the table. The plus focuses the
// field — which is what starts an item — and turns into a cancel once the field
// is active (focused or non-empty); a confirm (check) appears on the right.
// Confirming hands the name to onCreate (both sections prepend into the root
// group at rank 0).
//
// `noun` is the singular ("list", "tag") and drives every label, so the two
// tables cannot end up describing the same control differently.
export function CreateRow({
  noun,
  onCreate,
}: {
  noun: string;
  onCreate: (name: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const active = focused || value !== '';
  const inputRef = useRef<HTMLInputElement>(null);

  // Blur as well as clear: the cancel button preventDefaults, so nothing moves
  // focus off the field on its own, and Escape doesn't either. Leaving the caret
  // in a field that `focused` says is inactive desyncs state from the DOM — and
  // the next click on the (now) plus would focus() an already-focused field,
  // firing no focus event, so `active` would never come back and the button would
  // be dead again.
  const reset = () => {
    setValue('');
    setFocused(false);
    inputRef.current?.blur();
  };
  const confirm = async () => {
    if (value.trim() === '') return reset();
    try {
      await onCreate(value);
      // Keep focus for the next name — this is the one path that clears the field
      // without ending the edit, so it must not go through reset().
      setValue('');
    } catch {
      // Keep the typed value for a retry; onCreate already surfaced the error.
    }
  };

  return (
    <div className="flex items-center gap-1 border-b border-border px-1 py-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={active ? 'Cancel' : `New ${noun}`}
        onMouseDown={(e) => {
          // mousedown (not click) so the field's blur doesn't fire first and
          // clear `active` before we can cancel. preventDefault in both branches
          // keeps focus off the button itself: cancelling leaves the row inert,
          // and the plus hands focus straight to the field (which is what starts
          // an item — it flips `active`, so this button becomes the cancel).
          e.preventDefault();
          if (active) reset();
          else inputRef.current?.focus();
        }}
        onClick={(e) => {
          // Keyboard activation (Enter/Space) fires click without a preceding
          // mousedown, so the handler above never runs. detail === 0 marks those,
          // which keeps a real mouse click from doing the work twice.
          if (e.detail !== 0) return;
          if (active) reset();
          else inputRef.current?.focus();
        }}
      >
        {active ? <X className="size-4" /> : <Plus className="size-4" />}
      </Button>
      <Input
        ref={inputRef}
        value={value}
        placeholder={`New ${noun}`}
        aria-label={`New ${noun} name`}
        className="h-8 border-transparent bg-transparent px-2 focus-visible:bg-background"
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void confirm();
          else if (e.key === 'Escape') reset();
        }}
      />
      {active && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Create ${noun}`}
          onMouseDown={(e) => {
            // preventDefault keeps focus in the field, so a create can be
            // followed straight on by typing the next name.
            e.preventDefault();
            void confirm();
          }}
          onClick={(e) => {
            // The keyboard path, as on the cancel button: Enter/Space fires click
            // with no preceding mousedown.
            if (e.detail === 0) void confirm();
          }}
        >
          <Check className="size-4" />
        </Button>
      )}
    </div>
  );
}

// Inline rename. Uncontrolled so typing never round-trips through the store;
// commits on blur and Enter, reverts on Escape. `key` it by the stored name at
// the call site so an external rename (another device) refreshes the field.
export function RenameField({
  name,
  label,
  onRename,
  ref,
}: {
  name: string;
  // The accessible name of the field itself — "List name", "Tag name". The
  // visible text is the value, so without this the field announces as unlabelled.
  label: string;
  onRename: (name: string) => void;
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <Input
      ref={ref}
      defaultValue={name}
      aria-label={label}
      className="h-8 border-transparent bg-transparent px-2 hover:border-border focus-visible:bg-background"
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          e.currentTarget.value = name;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => onRename(e.currentTarget.value)}
    />
  );
}

// The inline name field's focus pair, for a row that offers Rename in its kebab.
// Select as well as focus: Rename on a row whose name is already there means
// "replace this", so a typed character should overwrite rather than append.
export function useRenameFocus() {
  const nameRef = useRef<HTMLInputElement>(null);
  const focusName = () => {
    nameRef.current?.focus();
    nameRef.current?.select();
  };
  return { nameRef, focusName };
}

// The menu half of that dance. Rename can't focus the field from onSelect: Radix
// closes the menu and returns focus to the trigger on close (onCloseAutoFocus),
// which fires after us and steals it back. So onSelect only records the intent,
// and the focus moves from within onCloseAutoFocus itself — preventing Radix's
// default trigger-refocus. Spread the two onto the Rename item and the content.
export function useRenameOnClose(onFocusName: () => void) {
  const requested = useRef(false);

  return {
    onRenameSelect: () => {
      requested.current = true;
    },
    onCloseAutoFocus: (e: Event) => {
      if (!requested.current) return;
      requested.current = false;
      e.preventDefault();
      onFocusName();
    },
  };
}

// The table's sort toolbar, right-aligned above it. Sorts whatever group the
// caller decides — the whole table, or one row's children.
export function SortMenu({
  disabled,
  onSort,
}: {
  disabled?: boolean;
  onSort: (dir: SortDir) => void;
}) {
  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Quiet by WEIGHT, not by size or colour — the same adjustment, for
              the same reason, as the "Advanced" disclosure in
              links/_components/link-add-surface.tsx (read its comment for the
              full argument). `font-normal` against the Button base's `text-sm
              font-medium`. This control is alone on its line above a table whose
              every row is normal-weight input text, so medium weight made the
              one word here the boldest ink in the block. Shrinking it instead
              (`size="xs"`) would take the label to 12px and the glyph to size-3,
              which is the legibility cost this rule exists to dodge, and muting
              the colour would put it next to the disabled state it already has
              (`disabled` on an empty table → opacity-50).

              `-mr-3` cancels the size's `px-3` EXACTLY, which puts the word on
              the table's right border rather than 12px inside it — the mirror of
              the `-ml-3` that lands "Advanced" on its form's text edge. A ghost
              button aligns by its label, not by its box, so the hover background
              is meant to overhang: 12px into the 16px both table sections narrow
              the pane to (`px-4` — see either section's pane for why), leaving
              4px to the edge. Tight, and the reason the inset and this margin
              have to be read together; expo's peer lands on the same 4px. Only
              the right is pulled — the left margin would move nothing in a
              `justify-end` row.
              The leading icon keeps `data-icon="inline-start"`, so the trim is
              still 10px before the glyph and 12px after the word. */}
          <Button variant="ghost" size="sm" disabled={disabled} className="-mr-3 font-normal">
            <ArrowUpDown data-icon="inline-start" className="size-4" /> Sort
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onSort('asc')}>
            <ArrowDownAZ className="size-4" /> A → Z
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSort('desc')}>
            <ArrowDownZA className="size-4" /> Z → A
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// The drag handle. Spread dnd-kit's `attributes` and `listeners` onto it — they
// land after the defaults, which is where they were before, and the listeners
// live only here so the rename input and the kebab stay clickable.
export function DragGrip(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Drag to reorder"
      className="cursor-grab touch-none text-muted-foreground"
      {...props}
    >
      <GripVertical className="size-4" />
    </Button>
  );
}
