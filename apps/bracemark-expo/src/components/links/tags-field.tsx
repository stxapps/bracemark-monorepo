import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Plus } from 'lucide-react-native';

import { useTagMutations, useTags } from '@stxapps/expo-react';
import { flattenTree } from '@stxapps/shared';

import { cn } from '../../lib/utils';
import { Icon } from '../ui/icon';
import { Input } from '../ui/input';
import { Text } from '../ui/text';

// The tag editor shared by every link-tags surface — the add/edit screens and
// BulkTagsDialog (which, like web's, seeds one TagsField and saves the diff) —
// the native cousin of web-ui's TagsField + TagsCommand pair (those headers
// are canonical: controlled value, reuse-or-mint by name via findOrCreate).
// No popover shell here, so no shell/body split either (web's TagsCommand has
// no expo counterpart — the popover body IS this whole inline field): every
// tag renders as a chip, selected = in `value`, with the create affordance
// folded in:
//
//  - The input filters the chips as you type (the searchable-command stand-in)
//    and doubles as the new tag's name field.
//  - Submitting — or pressing the Create row — mints via
//    useTagMutations.findOrCreate: case-insensitive reuse, top-level index 0
//    (the immediate-create web rule; this editor runs in-process, so it does
//    NOT copy the share sheet's deferral — docs/editors.md). The Create row is
//    suppressed on an exact case-insensitive match, where submit just selects.
//  - A just-minted tag's chip surfaces a beat later, when the live useTags
//    query catches up — selected, since its id is already in `value` (the same
//    catch-up gap web's chips have).
//
// Controlled: the caller owns the chosen tag-id list; this owns only the
// filter/name query.

export function TagsField({
  value,
  onChange,
}: {
  // The chosen tag ids, in chosen order.
  value: string[];
  onChange: (tagIds: string[]) => void;
}) {
  const tags = useTags();
  const { findOrCreate } = useTagMutations();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const options = useMemo(
    () => flattenTree(tags).map((n) => ({ id: n.item.id, name: n.item.name })),
    [tags],
  );

  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const visible = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  // Suppress Create on an exact case-insensitive match — submit selects the
  // existing tag instead (findOrCreate's reuse), so a Create row above an
  // identical chip would only read as a fork that isn't.
  const canCreate = trimmed !== '' && !options.some((o) => o.name.toLowerCase() === q);

  const toggle = (tagId: string) => {
    onChange(value.includes(tagId) ? value.filter((t) => t !== tagId) : [...value, tagId]);
  };

  const submit = async () => {
    if (creating || trimmed === '') return;
    setCreating(true);
    try {
      const tag = await findOrCreate(trimmed);
      if (tag && !value.includes(tag.id)) onChange([...value, tag.id]);
      setQuery('');
    } finally {
      setCreating(false);
    }
  };

  return (
    <View className="gap-2">
      <Input
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => void submit()}
        submitBehavior="submit"
        placeholder="Search or create tags…"
        aria-label="Search or create tags"
        autoCapitalize="none"
        autoCorrect={false}
        className="h-9"
      />
      {(visible.length > 0 || canCreate) && (
        <View className="flex-row flex-wrap items-center gap-2">
          {visible.map((o) => {
            const selected = value.includes(o.id);
            return (
              <Pressable
                key={o.id}
                onPress={() => toggle(o.id)}
                accessibilityRole="checkbox"
                aria-label={`${o.name}: ${selected ? 'selected' : 'not selected'}`}
                className={cn('rounded-full px-3 py-1.5', selected ? 'bg-primary' : 'bg-muted')}
              >
                <Text
                  className={cn(
                    'text-sm',
                    selected ? 'text-primary-foreground' : 'text-muted-foreground',
                  )}
                >
                  {o.name}
                </Text>
              </Pressable>
            );
          })}
          {canCreate && (
            <Pressable
              disabled={creating}
              onPress={() => void submit()}
              aria-label={`Create tag ${trimmed}`}
              className={cn(
                'flex-row items-center gap-1 rounded-full border border-dashed border-input px-3 py-1.5',
                creating && 'opacity-50',
              )}
            >
              <Icon as={Plus} className="size-3.5 text-muted-foreground" />
              <Text className="text-sm text-muted-foreground">Create “{trimmed}”</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
