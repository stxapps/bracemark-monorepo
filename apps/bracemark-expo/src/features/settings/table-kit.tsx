// The editable-table kit: the parts the Lists and Tags sections share — the RN
// port of bracemark-web's `(app)/settings/_components/table-kit.tsx`, component
// for component.
//
// WHY THIS EXISTS — the same argument settings-kit.tsx makes, one level down.
// settings-kit is the design system for a settings SECTION (the pane, the
// headings, the bordered row, the notice). Lists and Tags are not that shape:
// they are editable tables, and the two of them had a byte-identical create row,
// rename field, sort menu and error runner typed out twice. That is not
// "self-contained by design", it is two copies drifting.
//
// What belongs here is what both tables have in common. What does NOT is
// everything the two tables genuinely disagree about: Lists nests (depth,
// projection, "Move to", locks), Tags is flat — those stay in their sections,
// where the disagreement is the point. The rule of thumb: if a change to one
// table should obviously happen to the other, it lives here.
//
// This file grew out of `rows.tsx`, which held only CreateRow. What used to live
// beside it — `ActionRow` and `BackLink` — moved into settings-kit.tsx as
// `SettingsRow` (its drill-down shape) and `SettingsBackLink`; they were the same
// two shapes the kit had to declare anyway. The drag handle stays in
// drag-sort.tsx, with the layer it belongs to. Pure ordering (`sortedByName`,
// `SortDir`) is neither platform's business and lives in `@stxapps/shared`
// (sync/sort.ts), one copy for all four tables.

import { useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { ArrowDownAZ, ArrowDownZA, ArrowUpDown, Check, Plus, X } from 'lucide-react-native';

import type { SortDir } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';

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
// field — which is what starts an item, and raises the keyboard — and turns into
// a cancel once the field is active (focused or non-empty); a confirm (check)
// appears on the right. Confirming hands the name to onCreate (both sections
// prepend into the root group at rank 0).
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
  const inputRef = useRef<TextInput | null>(null);

  // Blur as well as clear, which also drops the keyboard: the settings ScrollView
  // is keyboardShouldPersistTaps="handled" (scroll-host.tsx), so a tap on the
  // cancel button reaches it with the field still focused and the keyboard still
  // up. Leaving it that way desyncs native focus from `focused` — and the next tap
  // on the (now) plus would focus() an already-focused field, firing no focus
  // event, so `active` would never come back and the button would be dead again.
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
    <View className="flex-row items-center gap-1 border-b border-border px-1 py-1.5">
      <Pressable
        aria-label={active ? 'Cancel' : `New ${noun}`}
        className="size-9 items-center justify-center rounded-md"
        // Whichever icon is showing, do what it says: cancel, or start an item by
        // focusing the field (which raises the keyboard and flips `active`, so
        // this button becomes the cancel). No mousedown/click split to worry
        // about as on web — a tap that blurs the field has already re-rendered
        // the icon to Plus by the time onPress lands, so the two agree.
        onPress={() => {
          if (active) reset();
          else inputRef.current?.focus();
        }}
      >
        <Icon as={active ? X : Plus} className="size-4 text-muted-foreground" />
      </Pressable>
      <Input
        ref={inputRef}
        value={value}
        placeholder={`New ${noun}`}
        aria-label={`New ${noun} name`}
        className="h-9 min-w-0 flex-1 border-transparent bg-transparent px-2 shadow-none"
        onChangeText={setValue}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={() => void confirm()}
      />
      {active && (
        <Pressable
          aria-label={`Create ${noun}`}
          className="size-9 items-center justify-center rounded-md"
          onPress={() => void confirm()}
        >
          <Icon as={Check} className="size-4 text-muted-foreground" />
        </Pressable>
      )}
    </View>
  );
}

// Inline rename. Uncontrolled so typing never round-trips through the store;
// commits when editing ends (blur or return). `key` it by the stored name at the
// call site so an external rename (another device) refreshes the field.
export function RenameField({
  name,
  label,
  onRename,
  inputRef,
}: {
  name: string;
  // The accessible name of the field itself — "List name", "Tag name". The
  // visible text is the value, so without this the field announces as unlabelled.
  label: string;
  onRename: (name: string) => void;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  return (
    <Input
      ref={inputRef}
      defaultValue={name}
      aria-label={label}
      className="h-9 border-transparent bg-transparent px-2 shadow-none"
      onEndEditing={(e) => onRename(e.nativeEvent.text)}
    />
  );
}

// The inline name field's focus pair, for a row that offers Rename in its kebab.
// Deferred by a beat: the menu closes on select, and focusing inside that
// teardown loses the focus to it. (Web's peer has the same problem and solves it
// with Radix's onCloseAutoFocus, which RN has no equivalent of.)
export function useRenameFocus() {
  const nameRef = useRef<TextInput | null>(null);
  const focusName = () => {
    setTimeout(() => nameRef.current?.focus(), 50);
  };
  return { nameRef, focusName };
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
    <View className="-mb-1 flex-row justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Quiet by WEIGHT, not by size or colour, and aligned by its label
              rather than its box — web's peer carries the full argument for both.
              `font-normal` sits on the LABEL here because the weight lives in
              buttonTextVariants' `text-sm font-medium`, not on the Pressable —
              the same split the "Advanced" disclosure makes in
              features/links/link-add-screen.tsx.

              `-mr-3` cancels the size variant's `px-3` exactly, as it does on
              web, so the word lands on the table's right border. The press
              background overhangs by those 12px into the 16px both table
              sections narrow the pane to (`px-4` — see lists-section.tsx's pane
              for why), leaving 4px to the screen edge: tight, and the reason the
              inset and this margin have to be read together. Web's peer lands on
              the same 4px, so the two platforms agree. The leading icon keeps the
              padding trim the Button derives from its children, so it stays 10px
              before the glyph and 12px after the word. */}
          <Button variant="ghost" size="sm" disabled={disabled} className="-mr-3">
            <Icon as={ArrowUpDown} className="size-4" />
            <Text className="font-normal">Sort</Text>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onPress={() => onSort('asc')}>
            <Icon as={ArrowDownAZ} className="size-4" />
            <Text>A → Z</Text>
          </DropdownMenuItem>
          <DropdownMenuItem onPress={() => onSort('desc')}>
            <Icon as={ArrowDownZA} className="size-4" />
            <Text>Z → A</Text>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}
