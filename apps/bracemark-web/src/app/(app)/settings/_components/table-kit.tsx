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

import { useEffect, useRef, useState } from 'react';
import { ArrowDownAZ, ArrowDownZA, ArrowUpDown, Check, GripVertical, Plus, X } from 'lucide-react';

import type { SortDir } from '@stxapps/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@stxapps/web-ui/components/ui/alert-dialog';
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// How long a dropped order may stand in for a live read that never comes to
// agree with it. Only ever reached by a write that resolved and still left the
// store in some other order (a sync landing a sibling in the same instant); a
// drop's own read is back in tens of ms. The value is the expo drag layer's, for
// the backstop it shares.
const DROP_HOLD_TIMEOUT_MS = 1500;

// A DROP'S NEW ORDER, SHOWN FROM THE RENDER THE DROP LANDS IN — ahead of the
// write, and of the live read that will confirm it.
//
// dnd-kit clears every drag transform in the render `onDragEnd` runs in. Its
// rows are only still in that render if the list it is sorting has ALREADY been
// reordered, which is why its own examples `setItems` synchronously in the
// handler. These tables can't: their order comes back through a Dexie write and
// `useLiveQuery`, a render or two later. In that gap dnd-kit sees a drag that
// ended and moved nothing, so it starts easing every row home — and when the
// order then does change, it reads the change as a layout animation and replays
// each row from where it sat BEFORE the drag. Measured per frame in headless
// Chrome with no throttling: the rows that had made room jumped back a full row
// and slid into place again over ~150ms, on every drop.
//
// So the section hands over the order it is about to write (`hold`), and that
// is what renders until the live read's `orderKey` equals it — at which point
// the two are the same rows in the same places and the swap is invisible. Held
// by KEY, not until the first read that differs from the old order: a reorder
// can be more than one write, and each write is its own read.
//
// A rejected write lets go at once (the section's notice says why, the rows go
// back), and `DROP_HOLD_TIMEOUT_MS` is the backstop for a read that never
// agrees. The expo twin solves the same gap from the other side — its drag layer
// has a pose to hold, so it holds that (drag-sort.tsx) — and docs/editors.md
// carries both.
export function useDropHold<T>(live: T, orderKey: (value: T) => string) {
  const [held, setHeld] = useState<{ value: T; key: string } | null>(null);

  // Let go in the render that sees the read arrive, not an effect after it: an
  // effect would commit one more frame of the held copy, which is the stale one
  // from here on.
  const landed = held !== null && orderKey(live) === held.key;
  if (landed) setHeld(null);

  useEffect(() => {
    if (held === null) return;
    const timer = setTimeout(
      () => setHeld((current) => (current === held ? null : current)),
      DROP_HOLD_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [held]);

  const hold = (value: T, op: Promise<unknown>) => {
    const next = { value, key: orderKey(value) };
    setHeld(next);
    // The section reports the failure (useOpRunner); this only un-drops the row.
    // Compared by identity so a late rejection can't release a newer drop.
    void op.catch(() => setHeld((current) => (current === next ? null : current)));
  };

  return { shown: held !== null && !landed ? held.value : live, hold };
}

// DELETE DOES NOT GO THROUGH THE RUNNER ABOVE, and this pair is why. The runner's
// notice sits at the top of the section, and Delete is the one op that fails from
// deep in the table: on a long list the refusal ("still has links") landed a
// screen above the row that asked, and the click appeared to do nothing. So a
// row's Delete asks `blocker` first and only then raises DestroyConfirm, which is
// a modal — on screen wherever the table is scrolled, focused, and announced on
// open — carrying either the refusal or the confirm. That also puts a confirm in
// front of an irreversible op that had none (deleting a tag strips it from every
// link, on every device), as LinkDestroyConfirm already does for links.
//
// The request is held as an ID, as the Move-to picker's is: the section resolves
// it against the live data each render, so a list deleted on another device
// takes its dialog with it. The check settles BEFORE anything mounts, so the
// dialog never opens as a confirm and then turns into a refusal. `latest` drops a
// check that a newer request (or a close) has overtaken.
export function useDestroyRequest<T extends { id: string }>(
  blocker: (item: T) => Promise<string | null>,
) {
  const [destroyRequest, setDestroyRequest] = useState<{
    id: string;
    blocker: string | null;
  } | null>(null);
  const latest = useRef(0);

  const requestDestroy = (item: T) => {
    const token = ++latest.current;
    const settle = (reason: string | null) => {
      if (token === latest.current) setDestroyRequest({ id: item.id, blocker: reason });
    };
    blocker(item).then(settle, (e: unknown) => settle(message(e)));
  };
  const closeDestroy = () => {
    latest.current++;
    setDestroyRequest(null);
  };

  return { destroyRequest, requestDestroy, closeDestroy };
}

interface DestroyConfirmProps {
  noun: string;
  // useDestroyRequest's verdict: the refusal to show, or null to ask to confirm.
  blocker: string | null;
  // The confirm's body — what goes, and that it can't come back.
  description: string;
  onDestroy: () => Promise<void>;
  onClose: () => void;
}

// The two faces of a row's Delete — see useDestroyRequest above.
//
//   - BLOCKED: the refusal, which names the item and says what to do, and one
//     button to dismiss it. That button is a Cancel, not an Action: Radix's alert
//     dialog focuses its Cancel on open and has no fallback, so a dialog without
//     one opens with focus stranded outside it.
//   - CLEAR: a destructive confirm. The action keeps the dialog up until destroy
//     resolves (as LinkDestroyConfirm does), because destroy re-checks: another
//     device can add a link after the check and before the click, and that
//     refusal lands here, as a `role="alert"` line — it mounts as the result of
//     the click, unlike the description, which is read as the dialog opens.
//
// The shape is LinkDestroyConfirm's (links/_components/link-destroy-confirm.tsx),
// which carries the reasoning for both the scroller — an item NAME is interpolated
// and names are unbounded — and the left alignment.
export function DestroyConfirm({
  noun,
  blocker,
  description,
  onDestroy,
  onClose,
}: DestroyConfirmProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await onDestroy();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && !deleting && onClose()}>
      <AlertDialogContent className="flex flex-col">
        <div className="flex min-h-0 shrink flex-col gap-3 overflow-y-auto">
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle>
              {blocker ? `Can’t delete this ${noun}` : `Delete ${noun}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {blocker ?? description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          {blocker ? (
            <AlertDialogCancel>OK</AlertDialogCancel>
          ) : (
            <>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deleting}
                onClick={(e) => {
                  // Keep the dialog up until destroy resolves — the default
                  // Action click would close it immediately.
                  e.preventDefault();
                  void onConfirm();
                }}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface CreateRowProps {
  noun: string;
  onCreate: (name: string) => Promise<unknown>;
}

// The create-an-item row pinned at the top of the table. The plus focuses the
// field — which is what starts an item — and turns into a cancel once the field
// is active (focused or non-empty); a confirm (check) appears on the right.
// Confirming hands the name to onCreate (both sections prepend into the root
// group at rank 0).
//
// `noun` is the singular ("list", "tag") and drives every label, so the two
// tables cannot end up describing the same control differently.
export function CreateRow({ noun, onCreate }: CreateRowProps) {
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

interface RenameFieldProps {
  name: string;
  // The accessible name of the field itself — "List name", "Tag name". The
  // visible text is the value, so without this the field announces as unlabelled.
  label: string;
  // Resolves when the rename is stored, rejects when it isn't — the field reads
  // the rejection, never the message (the notice's job).
  onRename: (name: string) => Promise<unknown>;
  ref?: React.Ref<HTMLInputElement>;
}

// Inline rename. Uncontrolled so typing never round-trips through the store;
// commits on blur and Enter, reverts on Escape. `key` it by the stored name at
// the call site so an external rename (another device) refreshes the field.
//
// A COMMIT THAT DOESN'T LAND PUTS THE STORED NAME BACK — the same revert Escape
// already performs, for the two commits that silently don't happen. Uncontrolled
// means the field holds what was typed until something replaces it, and the call
// site's `key` is the STORED name, which a failed write never changes: nothing
// remounts this, so the row goes on showing a name no store holds until the
// section is left and re-entered. The notice above the table says so a screen
// away (`useOpRunner`), and that is the half a message cannot fix — the table
// itself has to stop asserting the rename happened. The two:
//
//   - a BLANK name — the mutations treat it as "no rename", not as an error, so
//     nothing throws and nothing would otherwise take the empty field back;
//   - a REJECTED write, which is the local store failing (every other throw in
//     `rename` is a state the UI prevents). Hence the promise: call sites pass
//     `runAwait`, which records the message for the notice AND re-throws,
//     exactly as CreateRow keeps its typed value on failure.
//
// `input` is captured out of the event synchronously — React nulls
// `currentTarget` once the handler returns, so reading it inside the `.catch`
// would revert nothing. The expo twin remounts instead (RN has no `.value`).
export function RenameField({ name, label, onRename, ref }: RenameFieldProps) {
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
      onBlur={(e) => {
        const input = e.currentTarget;
        const revert = () => {
          input.value = name;
        };
        if (input.value.trim() === '') return revert();
        void onRename(input.value).catch(revert);
      }}
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

// The menu half of that dance, and the row kebab's whole close-focus policy: it
// owns where focus lands when the menu closes, for BOTH ways it can close.
//
// Rename can't focus the field from onSelect: Radix closes the menu and returns
// focus to the trigger on close (onCloseAutoFocus), which fires after us and
// steals it back. So onSelect only records the intent, and the focus moves from
// within onCloseAutoFocus itself — preventing Radix's default trigger-refocus.
// Spread the three onto the Rename item, the content, and the trigger.
//
// THE OTHER CLOSE IS THE ONE THAT MOVES THE PAGE, and it is why the trigger is
// refocused here by hand rather than left to Radix. Radix's own restore is a bare
// `triggerRef.current?.focus()` (react-dropdown-menu's DropdownMenuContent), and
// a focus with no `preventScroll` SCROLLS THE TRIGGER BACK INTO VIEW — which for
// a kebab deep in the Lists table means scrolling away from the notice at the top
// of the pane that the op fired from this menu just posted. It also lands second:
// the restore runs from a `setTimeout(…, 0)` after the content unmounts, while
// SettingsNotice scrolls from the effect that rendered the message, so the yank
// both cancels the in-flight smooth scroll and wins. Driven in Chromium at this
// geometry — scroller at 1493, notice a screen above: with Radix's restore the
// scroller ends at 1493 and the notice sits 1384px off the top of the fold; with
// `preventScroll: true` it ends at 37 with the notice at y=72, exactly where the
// scroll alone puts it (settings/layout.tsx's `scroll-pt-18`).
//
// So EVERY close refocuses the trigger without scrolling. Nothing is lost by
// that: the trigger was on screen when it was clicked, so the scroll only ever
// had somewhere to go when something else had moved the page — and the only
// thing that moves it is the message the user needs to read. Rename hid this for
// as long as it was the only failure anyone saw: its write commits on BLUR, a
// beat after the menu closed, so its notice scrolls into a page nothing is about
// to pull back. A move fails while the menu is still closing.
//
// The toolbar SortMenu below deliberately doesn't take this: its trigger sits in
// the same block as the notice, so a restore can't scroll anywhere the notice
// isn't. A menu whose trigger can be a screen away from the notice owes it.
export function useRowMenuFocus(onFocusName: () => void) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const requested = useRef(false);

  return {
    triggerRef,
    onRenameSelect: () => {
      requested.current = true;
    },
    onCloseAutoFocus: (e: Event) => {
      // Ours or Radix's, never both: preventing the default is what stops the
      // scrolling restore, so this has to put focus somewhere itself.
      e.preventDefault();
      if (requested.current) {
        requested.current = false;
        onFocusName();
        return;
      }
      triggerRef.current?.focus({ preventScroll: true });
    },
  };
}

interface SortMenuProps {
  disabled?: boolean;
  onSort: (dir: SortDir) => void;
}

// The table's sort toolbar, right-aligned above it. Sorts whatever group the
// caller decides — the whole table, or one row's children.
export function SortMenu({ disabled, onSort }: SortMenuProps) {
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
              is meant to overhang, and what it overhangs into is the pane's
              gutter: 12px of the 16 below `md` (leaving 4px to the frame edge —
              tight, and the reason the inset and this margin have to be read
              together), 12px of the 24 above it. Which way the pull can grow is
              therefore a function of the narrow inset, not the wide one; expo's
              peer lands on the same 4px. Only the right is pulled — the left
              margin would move nothing in a `justify-end` row.
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
