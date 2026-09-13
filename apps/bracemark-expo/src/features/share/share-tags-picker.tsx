// "Add tags" — the share sheet's own screen for labelling the link, and the
// share-sized RN cousin of components/links/tags-command.tsx (whose header, and
// web-ui's TagsField/TagsCommand pair above it, are canonical). Presentational
// like the list picker: rows in, events out; the screen owns the reuse-or-mint
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
// The row vocabulary is tags-command.tsx's exactly: one full-width checkbox row
// per tag, a trailing check for the selected state, and a Create row suppressed
// on an exact case-insensitive match. Someone who has tagged a link in the app
// should recognise this on sight.

import { useCallback, useState } from 'react';
import { ScrollView } from 'react-native';

import type { ShareNewEntity, ShareTaxonomyTag } from '@stxapps/expo-react/data/share-store';

import { TagPickerRows } from '../../components/links/tag-picker-rows';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
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

      {/* Bounded, not `flex-1`, and `min-h-0 shrink` so this is what gives up
          height to the keyboard — see the list picker's note. */}
      <ScrollView
        className="max-h-72 min-h-0 shrink"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <TagPickerRows
          rows={[
            ...visibleTags.map((tag) => ({
              ...tag,
              selected: selectedTagIds.includes(tag.id),
            })),
            ...visibleNew.map((tag) => ({ ...tag, selected: true })),
          ]}
          onToggle={(id) => (newTags.some((tag) => tag.id === id) ? onRemoveNew(id) : onToggle(id))}
          emptyText={
            visibleTags.length === 0 && visibleNew.length === 0 && !canCreate
              ? tags.length === 0 && newTags.length === 0
                ? 'No tags yet. Type a name to make one.'
                : 'No tags found.'
              : undefined
          }
          createName={canCreate ? trimmed : undefined}
          onCreate={canCreate ? submit : undefined}
          testIDForRow={(row) =>
            newTags.some((tag) => tag.id === row.id)
              ? `share-new-tag-${row.id}`
              : `share-tag-${row.id}`
          }
          createTestID="share-tag-create"
        />
      </ScrollView>

      <Button variant="outline" size="lg" onPress={onDone}>
        <Text>Done</Text>
      </Button>
    </ShareSheet>
  );
}
