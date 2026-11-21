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

import { useCallback, useMemo, useState } from 'react';

import type { ShareNewEntity, ShareTaxonomyTag } from '@stxapps/expo-react/data/share-store';

import {
  TagPickerCreateRow,
  TagPickerItem,
  type TagPickerRow,
} from '../../components/links/tag-picker-rows';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { ShareHeader, ShareSheet } from './share-kit';
import { SharePickerScroller } from './share-picker-scroller';

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
  // Pending sheet-minted tags, in typed order — always selected, rendered as
  // the top rows; tapping one removes it.
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
  // Newest first, and rendered ABOVE the existing tags below: that is where
  // their ranks put them (share-screen's submitTagName prepends each mint), so
  // the picker shows the order the app will after Save — and the row lands
  // beside the field that minted it, as tags-command.tsx's does
  // (docs/editors.md, _every create lands in the same place_).
  const visibleNew = newTags
    .filter((tag) => !filtering || tag.name.toLowerCase().includes(q))
    .reverse();

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

  const selectedIds = new Set(selectedTagIds);
  const rows: TagPickerRow[] = [
    ...visibleNew.map((tag) => ({ ...tag, selected: true })),
    ...visibleTags.map((tag) => ({ ...tag, selected: selectedIds.has(tag.id) })),
  ];

  const newIds = useMemo(() => new Set(newTags.map((tag) => tag.id)), [newTags]);
  const toggle = useCallback(
    (id: string) => (newIds.has(id) ? onRemoveNew(id) : onToggle(id)),
    [newIds, onRemoveNew, onToggle],
  );
  const renderRow = useCallback(
    ({ item }: { item: TagPickerRow }) => (
      <TagPickerItem
        row={item}
        testID={newIds.has(item.id) ? `share-new-tag-${item.id}` : `share-tag-${item.id}`}
        onToggle={toggle}
      />
    ),
    [newIds, toggle],
  );

  return (
    <ShareSheet memoryLabel="tags-picker" holdSwipe>
      <ShareHeader back={{ title: 'Add tags', onPress: onDone }} />

      <Input
        testID="share-tag-input"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={submit}
        submitBehavior="submit"
        placeholder="Search or create tags…"
        aria-label="Search or create tags"
        className="h-9"
      />

      {/* VIRTUALIZED, for the list picker's reason — see SharePickerScroller. */}
      <SharePickerScroller
        scrollResetKey={q}
        data={rows}
        keyExtractor={(row) => row.id}
        extraData={renderRow}
        renderItem={renderRow}
        emptyText={
          visibleTags.length === 0 && visibleNew.length === 0 && !canCreate
            ? tags.length === 0 && newTags.length === 0
              ? 'No tags yet. Type a name to make one.'
              : 'No tags found.'
            : undefined
        }
        footer={
          canCreate ? (
            <TagPickerCreateRow name={trimmed} onCreate={submit} testID="share-tag-create" />
          ) : null
        }
      />

      <Button variant="outline" size="lg" onPress={onDone}>
        <Text>Done</Text>
      </Button>
    </ShareSheet>
  );
}
