// "Add tags" — the share sheet's own screen for labelling the link, and the
// share-sized RN cousin of components/links/tags-field.tsx (whose header, and
// web-ui's TagsField/TagsCommand pair above it, are canonical). Presentational
// like the list picker: chips in, events out; the screen owns the reuse-or-mint
// (findOrCreate) rule.
//
// IT IS A SCREEN for the same reason the list picker is, and one more. Tags used
// to be a chip cloud wrapping under a cramped input on the compose screen, which
// bounded nothing: an account with forty tags pushed Save off the sheet. As a
// screen the cloud gets the room to be scrolled, and the compose row above it
// shows only what the user actually picked — which is bounded by them.
//
// IT DOES NOT CLOSE ON A TAP, where the list picker does: a list is one
// destination, tags are a set, and closing after the first one would be wrong
// three times out of four. Done is the way out, at the bottom where the thumb
// is.
//
// The chip vocabulary is tags-field.tsx's, exactly: `rounded-full px-3 py-1.5`,
// selected on `--primary`, unselected on `--muted`, and a dashed-outline
// `Create "…"` chip suppressed on an exact case-insensitive match (submitting
// selects the existing tag instead, which is what findOrCreate does). Someone
// who has tagged a link in the app should recognise this on sight.

import { useCallback, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Plus from 'lucide-react-native/icons/plus';
import X from 'lucide-react-native/icons/x';

import type { ShareNewEntity, ShareTaxonomyTag } from '@stxapps/expo-react/data/share-store';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { ShareHeader, ShareSheet } from './share-kit';

export function ShareTagsPicker({
  tags,
  selectedTagIds,
  newTags,
  onToggle,
  onRemoveNew,
  onSubmitName,
  onDone,
}: {
  tags: ShareTaxonomyTag[];
  selectedTagIds: string[];
  // Pending sheet-minted tags — always selected; tapping a chip removes it.
  newTags: ShareNewEntity[];
  onToggle: (tagId: string) => void;
  onRemoveNew: (tagId: string) => void;
  // The typed name to reuse-or-mint — the screen decides which.
  onSubmitName: (name: string) => void;
  // Back to the compose screen.
  onDone: () => void;
}) {
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const filtering = q.length > 0;
  const visibleTags = filtering ? tags.filter((tag) => tag.name.toLowerCase().includes(q)) : tags;
  const visibleNew = filtering
    ? newTags.filter((tag) => tag.name.toLowerCase().includes(q))
    : newTags;

  const canCreate =
    trimmed !== '' &&
    !tags.some((tag) => tag.name.toLowerCase() === q) &&
    !newTags.some((tag) => tag.name.toLowerCase() === q);

  // Submitting clears the field whether the name was minted or matched — the
  // chip below is the feedback either way, and leaving the text behind would
  // keep the list filtered to the thing just chosen.
  const submit = useCallback(() => {
    if (trimmed === '') return;
    onSubmitName(trimmed);
    setQuery('');
  }, [trimmed, onSubmitName]);

  return (
    <ShareSheet>
      <ShareHeader back={{ title: 'Add tags', onPress: onDone }} />

      <Input
        testID="share-tag-input"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={submit}
        submitBehavior="submit"
        placeholder="Search or create tags…"
        aria-label="Search or create tags"
        autoCapitalize="none"
        autoCorrect={false}
        className="h-9"
      />

      {/* Bounded, not `flex-1` — see the list picker's note. */}
      <ScrollView className="max-h-72" keyboardShouldPersistTaps="handled">
        {visibleTags.length === 0 && visibleNew.length === 0 && !canCreate && (
          <Text className="px-2 py-2.5 text-sm text-muted-foreground">
            {tags.length === 0 && newTags.length === 0
              ? 'No tags yet. Type a name to make one.'
              : 'No tags found.'}
          </Text>
        )}

        <View className="flex-row flex-wrap items-center gap-2">
          {visibleTags.map((tag) => {
            const selected = selectedTagIds.includes(tag.id);
            return (
              <Pressable
                key={tag.id}
                testID={`share-tag-${tag.id}`}
                onPress={() => onToggle(tag.id)}
                accessibilityRole="checkbox"
                aria-label={`${tag.name}: ${selected ? 'selected' : 'not selected'}`}
                className={cn('rounded-full px-3 py-1.5', selected ? 'bg-primary' : 'bg-muted')}
              >
                <Text
                  className={cn(
                    'text-sm',
                    selected ? 'text-primary-foreground' : 'text-muted-foreground',
                  )}
                >
                  {tag.name}
                </Text>
              </Pressable>
            );
          })}

          {/* A tag that does not exist yet, so it has no unselected state — the
              only thing to do with it is take it back off the draft. The × says
              that, where an identical chip beside the existing ones would not. */}
          {visibleNew.map((tag) => (
            <Pressable
              key={tag.id}
              testID={`share-new-tag-${tag.id}`}
              onPress={() => onRemoveNew(tag.id)}
              accessibilityRole="button"
              aria-label={`Remove ${tag.name}`}
              className="flex-row items-center gap-1 rounded-full bg-primary py-1.5 pr-2.5 pl-3"
            >
              <Text className="text-sm text-primary-foreground">{tag.name}</Text>
              <Icon as={X} className="size-3.5 text-primary-foreground" />
            </Pressable>
          ))}

          {canCreate && (
            <Pressable
              testID="share-tag-create"
              onPress={submit}
              accessibilityRole="button"
              aria-label={`Create tag ${trimmed}`}
              className="flex-row items-center gap-1 rounded-full border border-dashed border-input px-3 py-1.5"
            >
              <Icon as={Plus} className="size-3.5 text-muted-foreground" />
              <Text className="text-sm text-muted-foreground">Create “{trimmed}”</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>

      <Button variant="outline" size="lg" onPress={onDone}>
        <Text>Done</Text>
      </Button>
    </ShareSheet>
  );
}
