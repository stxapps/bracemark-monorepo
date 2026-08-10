// The links-screen search — the expo port of bracemark-web's
// `(app)/links/_components/search-bar.tsx` (canonical doc: why basic search is
// GLOBAL — submitting replaces the whole query with just its text — while the
// advanced editor edits the FULL current query in place; both commit through
// `setQuery`, the URL stays the single source of truth, so the box always
// reflects the committed query and a `?text=…` deep link rehydrates it).
// Divergences here:
//
//  - Web's box is persistent topbar chrome; on this narrow screen the bar is a
//    full-width row summoned below the topbar by its search toggle (rendered on
//    view-state-provider's derived `searchVisible` — the search toggle OR-ed
//    with a committed-search check, shared with the topbar so the two can't
//    disagree) — same slot the bulk-edit toolbar will share. Mounting
//    auto-focuses the input.
//  - The advanced editor is a full-height page-sheet Modal, not a popover: five
//    inputs plus two tri-state checklists don't fit a 320px anchored panel on a
//    phone, and the keyboard would cover half of it.
//  - The tri-state rows hand-roll their check/minus box: the reusables Checkbox
//    primitive is boolean-only (web leans on Radix's `indeterminate` for the
//    exclude visual).
//  - The Plus gate fires at Search like web, but the paywall dialog portals to
//    the root PortalHost, which Android draws BEHIND this Modal's native
//    window — so instead of keeping the sheet open under the paywall, the
//    sheet closes while it shows and "Not now" reopens it, draft intact (see
//    `apply`).

import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Check, Lock, Minus, Search, SlidersHorizontal, X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import { useEntitlements, useLists, useTags } from '@stxapps/expo-react';
import { emptyQuery, flattenTree, type LinkQuery } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { usePaywall } from '../../contexts/paywall-provider';
import { cn } from '../../lib/utils';
import { useLinksPage } from './page-provider';
import { useLinksViewState } from './view-state-provider';

const StyledSafeAreaView = withUniwind(SafeAreaView);

// Split a raw field value into lowercased, trimmed words — the same normalization
// parseLinkQuery applies on read-back, done here so a multi-word field becomes the
// repeated-key form the grammar ANDs (`?text=foo&text=bar`).
function words(raw: string): string[] {
  return raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

// Whether the committed query narrows the view in a way the rest of the UI does
// NOT already show — web's hasAdvancedFilters, verbatim (see there for the
// case-by-case rationale). Drives the advanced trigger's active dot; here the
// two rendering surfaces are the basic box (`text.all`) and the drawer
// highlight (`selection`), same as web's box + sidebar.
function hasAdvancedFilters(q: LinkQuery): boolean {
  const hidden =
    q.text.any.length +
    q.text.none.length +
    q.url.all.length +
    q.url.any.length +
    q.url.none.length +
    q.title.all.length +
    q.title.any.length +
    q.title.none.length;
  if (hidden > 0) return true;
  if (q.lists.none.length > 0 || q.tags.all.length > 0 || q.tags.none.length > 0) return true;

  const lists = q.lists.any.length;
  const tags = q.tags.any.length;
  if (lists > 1 || tags > 1) return true;
  if (lists >= 1 && tags >= 1) return true;
  return q.text.all.length > 0 && lists + tags > 0;
}

// The advanced editor's editable snapshot — web's Draft, verbatim (raw strings
// for the word fields so spaces survive mid-typing; the field-scoped url/title
// any/none forms stay deep-link-only; tags carry ONE include set + a match
// mode).
interface Draft {
  textAll: string;
  textAny: string;
  textNone: string;
  url: string;
  title: string;
  listsAny: string[];
  listsNone: string[];
  tagsInclude: string[];
  tagsMode: 'any' | 'all';
  tagsNone: string[];
}

function initDraft(q: LinkQuery): Draft {
  const tagsMode: Draft['tagsMode'] = q.tags.all.length > 0 ? 'all' : 'any';
  return {
    textAll: q.text.all.join(' '),
    textAny: q.text.any.join(' '),
    textNone: q.text.none.join(' '),
    url: q.url.all.join(' '),
    title: q.title.all.join(' '),
    listsAny: q.lists.any,
    listsNone: q.lists.none,
    tagsInclude: tagsMode === 'all' ? [...new Set([...q.tags.all, ...q.tags.any])] : q.tags.any,
    tagsMode,
    tagsNone: q.tags.none,
  };
}

// A labeled word field in the advanced editor (web's Field + FieldLabel pair).
// Search terms, not prose — autocapitalize/autocorrect off.
function WordField({
  label,
  value,
  placeholder,
  onChangeText,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      <Input
        value={value}
        placeholder={placeholder}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        className="h-9"
      />
    </View>
  );
}

// A tri-state checklist — web's TriCheckList: each row cycles off → include
// (check) → exclude (minus) → off, feeding the clause's positive (`any`/`all`)
// and `none` arrays. The box is hand-rolled (see the header); the minus icon is
// the exclude visual, and the accessibility label spells the real state out.
// `action` renders on the label row (the tags match toggle); without one, a
// static ✓/− legend teaches the cycle.
// Above this many options, the checklist gets a filter box so a big list/tag
// tree stays navigable without scrolling. Filtering only hides rows from view;
// it never touches the include/exclude sets.
const FILTER_THRESHOLD = 8;

function TriCheckList({
  label,
  options,
  include,
  exclude,
  onChange,
  action,
}: {
  label: string;
  options: { id: string; name: string; depth: number }[];
  include: string[];
  exclude: string[];
  onChange: (include: string[], exclude: string[]) => void;
  action?: React.ReactNode;
}) {
  const [filter, setFilter] = useState('');
  if (options.length === 0) return null;
  const cycle = (id: string) => {
    if (include.includes(id)) {
      onChange(
        include.filter((v) => v !== id),
        [...exclude, id],
      );
    } else if (exclude.includes(id)) {
      onChange(
        include,
        exclude.filter((v) => v !== id),
      );
    } else {
      onChange([...include, id], exclude);
    }
  };
  const showFilter = options.length > FILTER_THRESHOLD;
  const needle = filter.trim().toLowerCase();
  const visible = needle ? options.filter((o) => o.name.toLowerCase().includes(needle)) : options;
  return (
    <View className="gap-1">
      <View className="h-6 flex-row items-center justify-between">
        <Text className="text-xs text-muted-foreground">{label}</Text>
        {action ?? (
          <Text aria-hidden className="text-[10px] text-muted-foreground">
            ✓ include · − exclude
          </Text>
        )}
      </View>
      {showFilter && (
        <Input
          value={filter}
          onChangeText={setFilter}
          placeholder={`Filter ${label.toLowerCase()}…`}
          aria-label={`Filter ${label.toLowerCase()}`}
          autoCapitalize="none"
          autoCorrect={false}
          className="h-8 text-sm"
        />
      )}
      <View className="max-h-40 rounded-md border border-border p-1">
        {/* Nested same-direction scrolling: fine on iOS, opt-in on Android. */}
        <ScrollView nestedScrollEnabled>
          {visible.length === 0 && (
            <Text className="px-1.5 py-1 text-sm text-muted-foreground">No matches</Text>
          )}
          {visible.map((o) => {
            const state = include.includes(o.id)
              ? 'include'
              : exclude.includes(o.id)
                ? 'exclude'
                : 'off';
            return (
              <Pressable
                key={o.id}
                onPress={() => cycle(o.id)}
                accessibilityRole="checkbox"
                aria-label={`${o.name}: ${
                  state === 'include'
                    ? 'included'
                    : state === 'exclude'
                      ? 'excluded'
                      : 'not selected'
                }`}
                className="flex-row items-center gap-2 rounded px-1.5 py-2 active:bg-muted"
                style={o.depth > 0 ? { paddingLeft: o.depth * 12 + 6 } : undefined}
              >
                <View
                  className={cn(
                    'size-4 shrink-0 items-center justify-center rounded-[4px] border',
                    state === 'off' ? 'border-input' : 'border-primary bg-primary',
                  )}
                >
                  {state === 'include' && (
                    <Icon
                      as={Check}
                      size={12}
                      strokeWidth={3.5}
                      className="text-primary-foreground"
                    />
                  )}
                  {state === 'exclude' && (
                    <Icon
                      as={Minus}
                      size={12}
                      strokeWidth={3.5}
                      className="text-primary-foreground"
                    />
                  )}
                </View>
                <Text
                  numberOfLines={1}
                  className={cn(
                    'min-w-0 flex-1 text-sm',
                    state === 'exclude' && 'text-muted-foreground line-through',
                  )}
                >
                  {o.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

// The Plus gate's banner — web's LockedBanner (canonical doc: why free users
// get the FULL editor to try and the wall fires only at Search, the peak-intent
// moment; the banner's "See plans" is the door for the user who wants the offer
// without building a query first). One native change: "See plans" must close
// the sheet before routing — the Modal is a native window that would cover the
// pushed Subscription screen.
function LockedBanner({ onSeePlans }: { onSeePlans: () => void }) {
  return (
    <View className="flex-row items-start gap-2 rounded-md bg-muted px-3 py-2">
      <Icon as={Lock} className="mt-0.5 size-3.5 text-muted-foreground" />
      <Text className="min-w-0 flex-1 text-xs text-muted-foreground">
        A <Text className="text-xs font-medium text-foreground">Plus</Text> feature. Build your
        query, then upgrade to run it.{' '}
        <Text onPress={onSeePlans} className="text-xs font-medium text-primary">
          See plans
        </Text>
      </Text>
    </View>
  );
}

function AdvancedSearch() {
  const { query, setQuery } = useLinksPage();
  const lists = useLists();
  const tags = useTags();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => initDraft(query));

  // Snapshot the committed query into the draft each time the sheet opens, so
  // it edits the CURRENT query rather than a stale one (web's onOpenChange).
  const openSheet = () => {
    setDraft(initDraft(query));
    setOpen(true);
  };

  const listOptions = useMemo(
    () => flattenTree(lists).map((n) => ({ id: n.item.id, name: n.item.name, depth: n.depth })),
    [lists],
  );
  const tagOptions = useMemo(
    () => flattenTree(tags).map((n) => ({ id: n.item.id, name: n.item.name, depth: n.depth })),
    [tags],
  );

  const apply = () => {
    // The gate: a free user built a query to try the feature — pressing Search
    // is the payoff moment, so route to the paywall instead of committing.
    // Web keeps its popover open BEHIND the paywall; here the paywall dialog
    // portals to the root PortalHost, which Android draws behind this Modal's
    // native window (iOS's FullWindowOverlay would layer fine, but behavior
    // stays uniform) — so close the sheet and reopen it on "Not now". The
    // draft is this component's state, not the Modal's, so what the user built
    // survives the round trip. Upgrading skips onDismiss (see
    // paywall-provider), leaving the sheet closed under the Subscription
    // screen.
    if (!entitlements.searchEditor) {
      setOpen(false);
      paywall.show('searchEditor', () => setOpen(true));
      return;
    }
    const q = emptyQuery();
    q.text.all = words(draft.textAll);
    q.text.any = words(draft.textAny);
    q.text.none = words(draft.textNone);
    q.url.all = words(draft.url);
    q.title.all = words(draft.title);
    q.lists.any = draft.listsAny;
    q.lists.none = draft.listsNone;
    // A single included tag commits as `any` regardless of mode (the two are the
    // same set for one tag) — `any` keeps the drawer highlight and the clean
    // `?tag=` URL, where `all` would resolve `selection` to `none`.
    if (draft.tagsMode === 'all' && draft.tagsInclude.length > 1) {
      q.tags.all = draft.tagsInclude;
    } else {
      q.tags.any = draft.tagsInclude;
    }
    q.tags.none = draft.tagsNone;
    setQuery(q);
    setOpen(false);
  };

  return (
    <>
      <Pressable
        onPress={openSheet}
        aria-label="Advanced search"
        className="relative size-10 items-center justify-center rounded-md"
      >
        <Icon as={SlidersHorizontal} className="size-5 text-muted-foreground" />
        {hasAdvancedFilters(query) && (
          <View
            aria-hidden
            className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary"
          />
        )}
      </Pressable>
      {/* pageSheet on iOS (swipe-down fires onRequestClose too); Android gets a
          plain full-screen modal, where the SafeAreaView supplies the status-bar
          inset the sheet shape makes unnecessary on iOS. */}
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <StyledSafeAreaView className="flex-1 bg-background">
          {/* Plain KeyboardAvoidingView, not keyboard-controller: the Modal is
              its own native window, outside the root KeyboardProvider's view
              tree (the same reason the share screen avoids it). */}
          <KeyboardAvoidingView behavior="padding" className="flex-1">
            <View className="h-14 flex-row items-center justify-between border-b border-border pr-2 pl-4">
              <Text className="text-lg font-semibold">Advanced search</Text>
              <Pressable
                onPress={() => setOpen(false)}
                aria-label="Close advanced search"
                className="size-10 items-center justify-center rounded-md"
              >
                <Icon as={X} className="size-5 text-muted-foreground" />
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 p-4">
              {!entitlements.searchEditor && (
                <LockedBanner
                  onSeePlans={() => {
                    setOpen(false);
                    router.push('/settings/subscription');
                  }}
                />
              )}
              {/* The word trio (Google-advanced-search shape) over the combined
                  url⊕title haystack — text.all / text.any / text.none. Because
                  the haystack contains the url, "None of these words" also
                  covers the practical exclude-a-domain case. */}
              <WordField
                label="All of these words (URL or title)"
                value={draft.textAll}
                placeholder="every word must match"
                onChangeText={(v) => setDraft((d) => ({ ...d, textAll: v }))}
              />
              <WordField
                label="Any of these words"
                value={draft.textAny}
                placeholder="at least one matches"
                onChangeText={(v) => setDraft((d) => ({ ...d, textAny: v }))}
              />
              <WordField
                label="None of these words"
                value={draft.textNone}
                placeholder="exclude matches"
                onChangeText={(v) => setDraft((d) => ({ ...d, textNone: v }))}
              />
              <WordField
                label="URL contains"
                value={draft.url}
                onChangeText={(v) => setDraft((d) => ({ ...d, url: v }))}
              />
              <WordField
                label="Title contains"
                value={draft.title}
                onChangeText={(v) => setDraft((d) => ({ ...d, title: v }))}
              />
              <TriCheckList
                label="Lists"
                options={listOptions}
                include={draft.listsAny}
                exclude={draft.listsNone}
                onChange={(include, exclude) =>
                  setDraft((d) => ({ ...d, listsAny: include, listsNone: exclude }))
                }
              />
              <TriCheckList
                label="Tags"
                options={tagOptions}
                include={draft.tagsInclude}
                exclude={draft.tagsNone}
                onChange={(include, exclude) =>
                  setDraft((d) => ({ ...d, tagsInclude: include, tagsNone: exclude }))
                }
                // The match toggle only matters once ≥2 tags are included (any ≡
                // all for one tag); below that the ✓/− legend takes the slot.
                action={
                  draft.tagsInclude.length >= 2 ? (
                    <View className="flex-row items-center gap-1">
                      <Text className="text-[10px] text-muted-foreground">Match</Text>
                      {(['any', 'all'] as const).map((mode) => (
                        <Pressable
                          key={mode}
                          onPress={() => setDraft((d) => ({ ...d, tagsMode: mode }))}
                          aria-selected={draft.tagsMode === mode}
                          className={cn(
                            'h-6 items-center justify-center rounded-md px-2',
                            draft.tagsMode === mode ? 'bg-secondary' : 'active:bg-muted',
                          )}
                        >
                          <Text
                            className={cn(
                              'text-xs',
                              draft.tagsMode === mode
                                ? 'font-medium text-secondary-foreground'
                                : 'text-muted-foreground',
                            )}
                          >
                            {mode}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : undefined
                }
              />
              <View className="flex-row justify-end gap-2">
                <Button variant="ghost" size="sm" onPress={() => setDraft(initDraft(emptyQuery()))}>
                  <Text>Clear</Text>
                </Button>
                <Button size="sm" onPress={apply}>
                  <Text>Search</Text>
                </Button>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </StyledSafeAreaView>
      </Modal>
    </>
  );
}

export function SearchBar() {
  const { searchVisible, bulkEditing } = useLinksViewState();
  const { query, setQuery } = useLinksPage();

  // Basic box: a draft synced from the committed text. Navigation clears text →
  // the box empties; a basic/advanced search sets it → the box shows it.
  const committedText = useMemo(() => query.text.all.join(' '), [query.text.all]);
  const [text, setText] = useState(committedText);
  useEffect(() => setText(committedText), [committedText]);

  // Rendered visibility — the derived `searchVisible` from view-state-provider
  // (rationale lives there): the explicit toggle OR a committed search with no
  // other surface ('none' selection), so e.g. a back gesture into a `?text=`
  // URL re-shows the bar without a toggle press. Bulk-edit mode suspends the
  // bar (its chrome is the mode's — exiting restores it); the committed query
  // keeps filtering the list underneath either way.
  if (bulkEditing) return null;
  if (!searchVisible) return null;

  const submitBasic = () => {
    const w = words(text);
    // GLOBAL: replace the whole query with just the text. An empty box returns
    // home (the default inbox, via an empty query). Sort is a global synced
    // setting applied by use-links, not part of the query.
    if (w.length === 0) {
      setQuery(emptyQuery());
      return;
    }
    const q = emptyQuery();
    q.text.all = w;
    setQuery(q);
  };

  const clearBasic = () => {
    setText('');
    setQuery(emptyQuery());
  };

  return (
    <View className="flex-row items-center gap-1 border-b border-border px-2 pb-2">
      <View className="relative min-w-0 flex-1">
        <View pointerEvents="none" className="absolute inset-y-0 left-2.5 z-10 justify-center">
          <Icon as={Search} className="size-4 text-muted-foreground" />
        </View>
        <Input
          value={text}
          onChangeText={setText}
          onSubmitEditing={submitBasic}
          returnKeyType="search"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Search links…"
          aria-label="Search links"
          className="h-9 pr-8 pl-8"
        />
        {text.length > 0 && (
          <View className="absolute inset-y-0 right-1 justify-center">
            <Pressable
              onPress={clearBasic}
              aria-label="Clear search"
              className="size-7 items-center justify-center rounded"
            >
              <Icon as={X} className="size-4 text-muted-foreground" />
            </Pressable>
          </View>
        )}
      </View>
      <AdvancedSearch />
    </View>
  );
}
