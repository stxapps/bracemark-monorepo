// The CreateRow pinned atop the Lists and Tags tables — the one row primitive
// that is NOT part of the settings design system, because it is not a settings
// control at all: it is the head of an editable table, sitting on that table's
// hairline rather than on the pane's rhythm.
//
// What used to live beside it — `ActionRow` and `BackLink` — moved into
// settings-kit.tsx as `SettingsRow` (its drill-down shape) and
// `SettingsBackLink`. They were the same two shapes the kit had to declare
// anyway, and keeping a second copy here is exactly the drift the kit exists to
// stop.

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Check, Plus, X } from 'lucide-react-native';

import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';

// The create-an-item row pinned at the top of the Lists and Tags tables. The
// plus turns into a cancel once the field is active (focused or non-empty); a
// confirm (check) appears on the right. Confirming hands the name to onCreate
// (both sections prepend into the root group at rank 0).
export function CreateRow({
  placeholder,
  onCreate,
}: {
  placeholder: string;
  onCreate: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const active = focused || value !== '';

  const reset = () => {
    setValue('');
    setFocused(false);
  };
  const confirm = async () => {
    if (value.trim() === '') return reset();
    try {
      await onCreate(value);
      setValue('');
    } catch {
      // Keep the typed value for a retry; onCreate already surfaced the error.
    }
  };

  return (
    <View className="flex-row items-center gap-1 border-b border-border px-1 py-1.5">
      <Pressable
        aria-label={active ? 'Cancel' : placeholder}
        className="size-9 items-center justify-center rounded-md"
        onPress={() => {
          if (active) reset();
        }}
      >
        <Icon as={active ? X : Plus} className="size-4 text-muted-foreground" />
      </Pressable>
      <Input
        value={value}
        placeholder={placeholder}
        aria-label={`${placeholder} name`}
        className="h-9 min-w-0 flex-1 border-transparent bg-transparent px-2 shadow-none"
        onChangeText={setValue}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={() => void confirm()}
      />
      {active && (
        <Pressable
          aria-label="Create"
          className="size-9 items-center justify-center rounded-md"
          onPress={() => void confirm()}
        >
          <Icon as={Check} className="size-4 text-muted-foreground" />
        </Pressable>
      )}
    </View>
  );
}
