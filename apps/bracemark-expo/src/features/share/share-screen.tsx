// The share sheet's screen — url + title specimen, the destination, the tags,
// Save. Platform-blind: everything it exchanges with the world goes through
// @stxapps/expo-react's share-store (loadShareTaxonomy / saveSharedDraft) and
// the closeShareSheet host seam, so the same component renders inside the iOS
// extension and Android's ShareActivity (docs/share-sheet.md).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF THIS SURFACE, and why it changed.
//
// This sheet floats over Safari for about three seconds. The 90% path is
// share → Save; the list and the tags are the 10%. The previous layout had that
// backwards — two always-open text inputs and a 160px scrolling tree took most
// of a 520pt panel, the page being saved was two lines of unstyled text at the
// top, and the confirmation was a separate screen reading "✓ Saved to
// Bracemark". So:
//
//   1. THE PAGE IS THE SUBJECT (share-specimen.tsx). It is drawn the way the
//      library draws it, it is on screen from the first frame to the last, and
//      the save happens TO it — its corner comes off, which is the brand's own
//      "saved" gesture and the same one the browser-extension popup already
//      performs on the same object (docs/brand-assets.md, _the mark_). The compose
//      screen and the saved screen are no longer two screens with nothing in
//      common; they are one screen whose controls change.
//   2. THE CHOICES ARE DISCLOSED, NOT SPREAD OUT. A destination is one value
//      and a tag set is bounded by what the user picked, so both fit on a row
//      that shows the current answer and opens a screen with room to change it
//      (share-list-picker / share-tags-picker). One glance and one tap for the
//      90%; one extra tap, and a picker that is no longer a peephole, for the
//      10%.
//   3. THE VERB IS "SAVE" the whole way through — the button, the progress, the
//      confirmation — matching the extension popup and the app's own add
//      screen. "Add to Bracemark" → "✓ Saved to Bracemark" was two verbs and a
//      glyph for one action.
//
// The screen still upholds every editor invariant it did before, at smaller
// scope: the draft is local component state (copy-to-draft), a typed list/tag
// name is matched case-insensitively against the taxonomy before minting a new
// one (findOrCreate / exact-match suppression, applied at input time since the
// sheet already holds the taxonomy), the list create is TOP-LEVEL ONLY
// (parentId pinned null at apply), and ids AND ranks for everything new are
// minted HERE so the draft is idempotent downstream and the extension's upload
// can push complete entities (share-store's header: a stale-snapshot rank can
// only tie, broken by id). Creating a list selects it; selecting another list
// discards the pending create — a new list exists only as the share's
// destination.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import Folder from 'lucide-react-native/icons/folder';
import Link2Off from 'lucide-react-native/icons/link-2-off';
import LogIn from 'lucide-react-native/icons/log-in';
import Tag from 'lucide-react-native/icons/tag';

// Both workspace imports name a FILE, not the package barrel — the same rule as
// the lucide deep imports below, one level out. `@stxapps/expo-react`'s index is
// 60 `export *`s (every provider, every hook, the sync engine, import/export)
// and `@stxapps/expo-crypto`'s pulls Argon2 + the AES stack: Metro does not
// tree-shake, so a barrel import executes ALL of it on every cold share. The
// subpaths are declared package exports; features/share/** may not name the
// barrels at all (eslint no-restricted-imports enforces it).
import { newId } from '@stxapps/expo-crypto/lib/ids';
import {
  loadShareTaxonomy,
  saveSharedDraft,
  type ShareDraft,
  type ShareNewEntity,
  type ShareTaxonomy,
} from '@stxapps/expo-react/data/share-store';
import {
  cleanName,
  DEFAULT_LIST_ID,
  LIST_NAME_MAX,
  rankBetween,
  TAG_NAME_MAX,
} from '@stxapps/shared';

import { ErrorText } from '../../components/error-text';
import { LinkQuotaBanner } from '../../components/links/link-quota-banner';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { apiClient } from '../../lib/api-client';
import { closeShareSheet } from './share-host';
import { ShareHeader, ShareNotice, ShareRow, ShareRowGroup, ShareSheet } from './share-kit';
import { ShareListPicker } from './share-list-picker';
import { ShareSpecimen } from './share-specimen';
import { ShareTagsPicker } from './share-tags-picker';
import type { SharePayload } from './share-url';

type Phase = 'loading' | 'ready' | 'saving' | 'saved';

// Which of the sheet's screens is up. Not a router — three screens in one
// component, because the iOS extension bundle has no business carrying one
// (docs/share-sheet.md, _keep index.share.js lean_).
type View3 = 'compose' | 'lists' | 'tags';

// How long the saved state lingers before the sheet dismisses itself. Longer
// than the 900ms it replaces, because there is now something to READ — the
// destination — and something to SEE, the corner coming off the tile. Still
// under the "dismiss fast, never hold the sheet on a spinner" rule: the durable
// commit already happened, and no sync is being waited on.
const SAVED_DISMISS_MS = 1200;

// How many tag chips the compose row draws before it summarises the rest as
// "+N", and it is a LAYOUT BOUND, not a taste one. The chips wrap
// (`flex-wrap`), which made this row the only thing on the compose screen whose
// height has no ceiling: everything else here is fixed (the h-9 header, the
// specimen's 44pt tile and its two clamped lines, the min-h-12 rows, the h-11
// button), and a panel that outgrows the frame does not clip — it OVERFLOWS,
// painting its header outside its own background (share-kit.tsx's squeeze
// chain, which has nothing shrinkable on this screen to give). Six holds the
// row to about two lines at ordinary name lengths and bounds the worst case —
// six chips each wrapping to their own line — to something the compose screen's
// slack absorbs at the 1.3 font cap on the shortest phone we target.
//
// It also happens to be what the row is FOR (the header's point 2): a row
// showing twenty chips has stopped being a summary, and the picker behind it is
// where the full set is seen and changed.
const MAX_TAG_CHIPS = 6;

export function ShareScreen({ url, title }: SharePayload) {
  // The link's id, minted ONCE for this sheet rather than per Save attempt.
  // "Idempotent by construction" (share-store's header) rests on the id being
  // stable across every path that can retry a draft — and a failed Save is one
  // of them: Android's applyShareDraft writes the lists, the tags, the link and
  // the extraction title in sequence, so a throw after the link row lands would,
  // with a freshly minted id on the retry, file the page TWICE. Held here, the
  // retry re-writes the same entity and converges under last-write-wins, the
  // same way the drain's own retry does. (The new lists/tags below are already
  // session-stable, which is why only the link needed fixing.)
  const [linkId] = useState(newId);
  const [phase, setPhase] = useState<Phase>('loading');
  const [view, setView] = useState<View3>('compose');
  const [taxonomy, setTaxonomy] = useState<ShareTaxonomy | null>(null);
  const [listId, setListId] = useState<string>(DEFAULT_LIST_ID);
  const [newList, setNewList] = useState<ShareNewEntity | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [newTags, setNewTags] = useState<ShareNewEntity[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadShareTaxonomy().then(
      (loaded) => {
        if (!alive) return;
        setTaxonomy(loaded);
        setPhase('ready');
      },
      () => {
        if (!alive) return;
        // `maxLinks: null` is the fail-open default the cap gate uses whenever
        // the answer is unknowable (share-store isAtLinkCap) — though the sheet
        // never offers the form on an ownerless taxonomy anyway.
        setTaxonomy({ owner: null, lists: [], tags: [], linkCount: 0, maxLinks: null });
        setPhase('ready');
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // Let the saved state linger, then dismiss — as an effect (not a bare
  // setTimeout in the save handler) so unmounting cancels it.
  useEffect(() => {
    if (phase !== 'saved') return;
    const timer = setTimeout(closeShareSheet, SAVED_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Pick a list. Selecting away from the pending new list discards it —
  // created-means-selected, so an unselected new list must not be created.
  const selectList = useCallback(
    (id: string) => {
      setListId(id);
      if (newList && id !== newList.id) setNewList(null);
    },
    [newList],
  );

  // Commit a typed list name: reuse an existing list on an exact
  // case-insensitive name match (the ListCommand suppression rule — the
  // deliberate-duplicate case still has the app's Settings → Lists), else mint
  // and select. The rank prepends before the first root list — web ListSelect's
  // create-at-index-0, so the same action lands the same place everywhere.
  const submitListName = useCallback(
    (typed: string) => {
      if (!taxonomy) return;
      // Cut to the writers' cap, as the app's mutation hooks cut it
      // (docs/data-limits.md) — this sheet mints without them.
      const name = cleanName(typed, LIST_NAME_MAX);
      if (name === '') return;
      const lower = name.toLowerCase();
      const existing = taxonomy.lists.find((list) => list.name.toLowerCase() === lower);
      if (existing) {
        setNewList(null);
        setListId(existing.id);
        return;
      }
      // rankBetween(null, null) — the first key — when there are no lists yet.
      const minted: ShareNewEntity = {
        id: newId(),
        name,
        rank: rankBetween(null, taxonomy.lists[0]?.rank ?? null),
      };
      setNewList(minted);
      setListId(minted.id);
    },
    [taxonomy],
  );

  // Commit a typed tag name onto the draft: reuse an existing tag on a
  // case-insensitive name match (findOrCreate), else mint a new one prepended
  // before the first tag — web findOrCreate's create-at-index-0, the same rule
  // submitListName follows, so the same action lands the same place everywhere.
  const submitTagName = useCallback(
    (typed: string) => {
      if (!taxonomy) return;
      const name = cleanName(typed, TAG_NAME_MAX);
      if (name === '') return;
      const lower = name.toLowerCase();
      const existing = taxonomy.tags.find((tag) => tag.name.toLowerCase() === lower);
      if (existing) {
        setSelectedTagIds((ids) => (ids.includes(existing.id) ? ids : [...ids, existing.id]));
        return;
      }
      setNewTags((tags) => {
        if (tags.some((tag) => tag.name.toLowerCase() === lower)) return tags;
        // The group's current head: the previous mint if this session made one
        // (each prepends, so the latest IS the head), else the first existing
        // tag, else null (no tags yet — rankBetween(null, null) is the first
        // key). Chaining off it stacks several new tags newest-first, matching
        // what web's re-read-per-call gives — the array order below is just the
        // draft's set; rank is what orders them.
        const head =
          tags.length > 0 ? tags[tags.length - 1].rank : (taxonomy.tags[0]?.rank ?? null);
        return [...tags, { id: newId(), name, rank: rankBetween(null, head) }];
      });
    },
    [taxonomy],
  );

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));
  }, []);

  const removeNewTag = useCallback((id: string) => {
    setNewTags((tags) => tags.filter((tag) => tag.id !== id));
  }, []);

  const backToCompose = useCallback(() => setView('compose'), []);

  // The destination's own name — the pending mint when that is what is selected,
  // else the taxonomy row. Undefined only against a taxonomy that doesn't carry
  // the selected id, which a corrupt snapshot can produce; the row says so
  // rather than rendering a blank.
  const listName = useMemo(() => {
    if (newList && newList.id === listId) return newList.name;
    return taxonomy?.lists.find((list) => list.id === listId)?.name;
  }, [taxonomy, listId, newList]);

  // What the tags row echoes back: the picked existing tags in pick order, then
  // this session's mints. Names, not ids — the row is a summary, and the picker
  // behind it is where anything gets changed.
  const tagNames = useMemo(() => {
    const existing = selectedTagIds
      .map((id) => taxonomy?.tags.find((tag) => tag.id === id)?.name)
      .filter((name): name is string => name !== undefined);
    return [...existing, ...newTags.map((tag) => tag.name)];
  }, [taxonomy, selectedTagIds, newTags]);

  const onSave = useCallback(async () => {
    // The owner guard is for the type: the form is never offered without one.
    if (!url || !taxonomy?.owner) return;
    setPhase('saving');
    setError(null);
    const draft: ShareDraft = {
      id: linkId,
      // The account whose lists and tags this sheet rendered — share-store's
      // header, _a draft belongs to an account_.
      owner: taxonomy.owner,
      url,
      ...(title !== undefined ? { title } : {}),
      listId,
      tagIds: [...selectedTagIds, ...newTags.map((tag) => tag.id)],
      newTags,
      // selectList discards a deselected pending list, so newList non-null
      // means it IS the destination — the guard is belt-and-bracemarks.
      newLists: newList && newList.id === listId ? [newList] : [],
      sharedAt: Date.now(),
    };
    try {
      // The api client powers saveSharedDraft's un-awaited post-write kick
      // (Android inline sync / iOS upload); Save itself only waits on the
      // durable local write.
      const result = await saveSharedDraft(draft, apiClient);
      // At the plan's link cap. The gate below normally catches this before the
      // form is ever offered, so reaching it means the count moved under us —
      // Android re-counts sqlite live inside saveSharedDraft, and on iOS the
      // snapshot can be a run of shares old. Nothing was written, so this is a
      // refusal, not a failure: say so rather than invite a retry that would
      // refuse again.
      if (result === 'quota') {
        setPhase('ready');
        setError('Your plan’s link limit is full. Open Bracemark to upgrade or free up room.');
        return;
      }
      // The app signed out, or into another account, while the sheet was open.
      // Nothing was written, and a retry would refuse again: the lists and tags
      // on screen are the old account's. Reopening the sheet reads the new one.
      if (result === 'account-changed') {
        setPhase('ready');
        setError(
          'You signed out of Bracemark, or into another account, after this opened. Close this and share the link again.',
        );
        return;
      }
      setPhase('saved');
    } catch {
      setPhase('ready');
      setError('Couldn’t save. Try again.');
    }
  }, [linkId, taxonomy, url, title, listId, newList, selectedTagIds, newTags]);

  // ── the screens ───────────────────────────────────────────────────────────

  // Nothing is known yet except the page itself — so show the page. The read is
  // a file (iOS) or an indexed sqlite query (Android) and usually resolves in a
  // frame or two; opening on the specimen means the sheet arrives with its
  // subject already in place and only the controls fade in under it, rather than
  // flashing a spinner in an empty panel and then jumping.
  if (phase === 'loading' || !taxonomy) {
    return (
      <ShareSheet screen="loading">
        <ShareHeader />
        {url !== null && <ShareSpecimen url={url} title={title} />}
        <View className="items-center py-6">
          <ActivityIndicator />
        </View>
      </ShareSheet>
    );
  }

  if (taxonomy.owner === null) {
    return (
      <ShareNotice testID="share-signed-out" icon={LogIn} title="Sign in to save links">
        Open Bracemark on this device and sign in. Each link is encrypted with a key your password
        unlocks, so the sheet can’t save until you have.
      </ShareNotice>
    );
  }

  if (url === null) {
    return (
      <ShareNotice testID="share-no-url" icon={Link2Off} title="No link in this share">
        Bracemark saves web links, and there isn’t one here. Try sharing from your browser, or share
        text that contains a link.
      </ShareNotice>
    );
  }

  // At the cap, refuse BEFORE the form — the rule every create surface follows
  // (docs/editors.md), and the one place it matters most: the cap is
  // client-enforced (docs/iap.md, _enforcement_), so this gate IS the wall, and
  // refusing here is refusing before the user has filed a link that was never
  // going to be saved. Both platforms read the same two numbers off the
  // taxonomy — live sqlite on Android, the snapshot on iOS — and both fail OPEN
  // when `maxLinks` is null, because guessing `free` would tell a paying
  // customer their library is full.
  if (taxonomy.maxLinks !== null && taxonomy.linkCount >= taxonomy.maxLinks) {
    return (
      <ShareSheet screen="link-cap">
        <ShareHeader dismissible={false} />
        <ShareSpecimen url={url} title={title} />
        <View testID="share-quota">
          <LinkQuotaBanner
            count={taxonomy.linkCount}
            max={taxonomy.maxLinks}
            // No upgrade CTA: neither host can route into the app's
            // /settings/subscription screen (Android's BracemarkShare module
            // exposes close() and nothing else), and a button that opens the
            // app somewhere else would be worse than the banner's own sentence.
            action={
              <Button variant="outline" size="lg" onPress={closeShareSheet}>
                <Text>Close</Text>
              </Button>
            }
          />
        </View>
      </ShareSheet>
    );
  }

  if (view === 'lists') {
    return (
      <ShareListPicker
        lists={taxonomy.lists}
        newList={newList}
        selectedId={listId}
        onSelect={selectList}
        onCreateName={submitListName}
        onDone={backToCompose}
      />
    );
  }

  if (view === 'tags') {
    return (
      <ShareTagsPicker
        tags={taxonomy.tags}
        selectedTagIds={selectedTagIds}
        newTags={newTags}
        onToggle={toggleTag}
        onRemoveNew={removeNewTag}
        onSubmitName={submitTagName}
        onDone={backToCompose}
      />
    );
  }

  // Saved. The specimen has not moved and has not been replaced — only its
  // corner is gone, and the controls under it are down to the one fact worth
  // confirming: WHERE it landed. "Saved" alone is half an answer in an app whose
  // organising idea is lists, and the destination is the thing the user set
  // seconds ago (bracemark-extension's Complete screen makes the same argument).
  if (phase === 'saved') {
    return (
      <ShareSheet screen="saved">
        <ShareHeader />
        <ShareSpecimen url={url} title={title} saved />
        <View className="flex-row items-center gap-2 py-1">
          <Icon as={Folder} className="size-3.5 shrink-0 text-muted-foreground" />
          <Text
            testID="share-saved"
            numberOfLines={1}
            className="min-w-0 flex-1 text-sm text-muted-foreground"
          >
            {listName === undefined ? (
              'Saved'
            ) : (
              <>
                Saved to <Text className="text-sm font-medium text-foreground">{listName}</Text>
              </>
            )}
          </Text>
        </View>
      </ShareSheet>
    );
  }

  return (
    <ShareSheet screen="compose">
      <ShareHeader />
      <ShareSpecimen url={url} title={title} />

      <ShareRowGroup>
        <ShareRow
          icon={Folder}
          label="List"
          value={listName ?? 'Choose a list'}
          testID="share-list-row"
          onPress={() => setView('lists')}
        >
          <Text numberOfLines={1} className="font-medium">
            {listName ?? 'Choose a list'}
          </Text>
        </ShareRow>
        <ShareRow
          icon={Tag}
          label="Tags"
          // The same summary the row shows, flattened: a screen reader gets the
          // picked names in one phrase instead of a run of chip fragments.
          // NOT capped at MAX_TAG_CHIPS: the cap is a space constraint on a
          // 375pt row, and a screen reader has no such constraint. Announcing
          // "and 14 more" would leave someone who cannot see the row with no
          // way to hear what is on it short of entering the picker.
          value={tagNames.length === 0 ? 'none' : tagNames.join(', ')}
          testID="share-tags-row"
          bordered
          onPress={() => setView('tags')}
        >
          {tagNames.length === 0 ? (
            <Text className="text-muted-foreground">Add tags</Text>
          ) : (
            // The library's own read-only chip (features/links/link-tag-chips.tsx
            // — `bg-muted rounded-full px-2 py-0.5`, `text-xs`), so the tags read
            // here exactly as they will on the row this share becomes.
            <View className="flex-row flex-wrap items-center gap-1">
              {tagNames.slice(0, MAX_TAG_CHIPS).map((name) => (
                <Text
                  key={name}
                  numberOfLines={1}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {name}
                </Text>
              ))}
              {/* Bare, not a chip: "+14" is a count of tags, not a tag, and in
                  the chip's own `bg-muted` pill it would read as one more of
                  them. The row announces the full list regardless (the
                  `value` above), so this carries no semantics of its own. */}
              {tagNames.length > MAX_TAG_CHIPS && (
                <Text className="px-1 text-xs text-muted-foreground">
                  +{tagNames.length - MAX_TAG_CHIPS}
                </Text>
              )}
            </View>
          )}
        </ShareRow>
      </ShareRowGroup>

      {error !== null && (
        <View className="rounded-lg bg-destructive/10 px-3 py-2.5">
          <ErrorText testID="share-error">{error}</ErrorText>
        </View>
      )}

      {/* The sheet's one primary action — everything else on every screen is an
          outline or a bare row. The label carries the progress rather than a
          spinner: an ActivityIndicator inside this button needs a colour, and
          the only honest one is `--primary-foreground`, which the RN prop can't
          take as a class — the previous hardcoded white vanished into the light
          grey this button is in dark mode. "Saving…" is also what the browser
          extension's Save button says. */}
      <Button testID="share-add" size="lg" disabled={phase === 'saving'} onPress={onSave}>
        <Text>{phase === 'saving' ? 'Saving…' : 'Save'}</Text>
      </Button>
    </ShareSheet>
  );
}
