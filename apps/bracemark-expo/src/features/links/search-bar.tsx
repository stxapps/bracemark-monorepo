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
//  - The advanced editor is not a popover: five inputs plus two tri-state
//    checklists don't fit a 320px anchored panel on a phone, and the keyboard
//    would cover half of it. It is the in-app sheet (components/ui/sheet.tsx)
//    — a bottom sheet below the docking width and a centred card at and above
//    it, the same shell as the add panel and the link editor.
//  - The tri-state rows hand-roll their check/minus box: the reusables Checkbox
//    primitive is boolean-only (web leans on Radix's `indeterminate` for the
//    exclude visual).
//  - The Plus gate fires at Search like web, and like web the editor stays
//    open behind the paywall (see `apply`).

import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Check, Lock, Minus, Search, SlidersHorizontal, X } from 'lucide-react-native';

import { useEntitlements, useLists, useTags } from '@stxapps/expo-react';
import { emptyQuery, flattenTree, type LinkQuery, TREE_INDENT_MAX_LEVELS } from '@stxapps/shared';

import { FirstLineSlot } from '../../components/first-line-slot';
import { TreeLevelMarker } from '../../components/links/tree-level-marker';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Sheet } from '../../components/ui/sheet';
import { Text } from '../../components/ui/text';
import { usePaywall } from '../../contexts/paywall-provider';
import { useFocusedFieldReveal } from '../../lib/use-focused-field-reveal';
import { cn } from '../../lib/utils';
import { useLinksPage } from './page-provider';
import { useLinksViewState } from './view-state-provider';

type FocusHandler = NonNullable<ComponentProps<typeof Input>['onFocus']>;
type BlurHandler = NonNullable<ComponentProps<typeof Input>['onBlur']>;

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
    q.title.none.length +
    q.note.all.length +
    q.note.any.length +
    q.note.none.length;
  if (hidden > 0) return true;
  if (q.lists.none.length > 0 || q.tags.all.length > 0 || q.tags.none.length > 0) return true;

  const lists = q.lists.any.length;
  const tags = q.tags.any.length;
  if (lists > 1 || tags > 1) return true;
  if (lists >= 1 && tags >= 1) return true;
  return q.text.all.length > 0 && lists + tags > 0;
}

// The advanced editor's editable snapshot — web's Draft, verbatim (raw strings
// for the word fields so spaces survive mid-typing; the field-scoped
// url/title/note any/none forms stay deep-link-only; tags carry ONE include set +
// a match mode).
interface Draft {
  textAll: string;
  textAny: string;
  textNone: string;
  url: string;
  title: string;
  note: string;
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
    note: q.note.all.join(' '),
    listsAny: q.lists.any,
    listsNone: q.lists.none,
    tagsInclude: tagsMode === 'all' ? [...new Set([...q.tags.all, ...q.tags.any])] : q.tags.any,
    tagsMode,
    tagsNone: q.tags.none,
  };
}

// A labeled word field in the advanced editor (web's Field + FieldLabel pair).
// Search terms, not prose — which is `Input`'s exact-entry default, so no
// typing hints are restated here (docs/editors.md, _typing assistance_).
//
// The label is ALSO the input's `aria-label`: RN has no `<label for>`, so the
// visually adjacent Text named nothing, and VoiceOver announced six unnamed
// text fields where web's `htmlFor` gives each its label (docs/accessibility.md,
// _naming things that have no visible label_ — the sign-in fields' fix).
function WordField({
  label,
  value,
  placeholder,
  onChangeText,
  onFocus,
  onBlur,
  testID,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChangeText: (value: string) => void;
  onFocus?: FocusHandler;
  onBlur?: BlurHandler;
  testID?: string;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      <Input
        testID={testID}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
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
  onFilterFocus,
  onFilterBlur,
}: {
  label: string;
  options: { id: string; name: string; depth: number }[];
  include: string[];
  exclude: string[];
  onChange: (include: string[], exclude: string[]) => void;
  action?: React.ReactNode;
  onFilterFocus?: FocusHandler;
  onFilterBlur?: BlurHandler;
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
          onFocus={onFilterFocus}
          onBlur={onFilterBlur}
          placeholder={`Filter ${label.toLowerCase()}…`}
          aria-label={`Filter ${label.toLowerCase()}`}
          // `py-0`, for ui/button.tsx's reason: the height is pinned, so the
          // padding sizes nothing and only takes room from the line. 32 minus
          // Input's `py-1` and the border left 22 for a `text-sm` line that is
          // 26 at the 1.3 cap, and Android drew it with the cap tops sheared
          // off (docs/accessibility.md, _font scaling_); without it there is
          // 30. Invisible at 1× — Android centres the line box and iOS sets
          // none. Not `h-auto min-h-8`: that grows, but an empty Android field
          // measures its placeholder ~8dp taller than typed text, so the box
          // shrank on the first keystroke.
          className="h-8 py-0 text-sm"
        />
      )}
      <View className="max-h-40 rounded-md border border-border p-1">
        {/* Nested same-direction scrolling: fine on iOS, opt-in on Android.

            `keyboardShouldPersistTaps="handled"` matches the modal body that
            wraps this (below) — it was missed here, and the omission showed:
            the filter box sits directly above these rows, so with the default
            `"never"` the first tap on a filtered row only dismissed the
            keyboard and never reached the checkbox. */}
        <ScrollView
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {visible.length === 0 && (
            <Text className="px-1.5 py-1 text-sm text-muted-foreground">
              No matching {label.toLowerCase()}
            </Text>
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
                // 12 a level up to TREE_INDENT_MAX_LEVELS, then the level as a
                // number (@stxapps/shared sync/tree.ts) — web's checklist, same
                // numbers. Uncapped, a deep chain's box left the screen.
                style={
                  o.depth > 0
                    ? { paddingLeft: Math.min(o.depth, TREE_INDENT_MAX_LEVELS) * 12 + 6 }
                    : undefined
                }
              >
                <TreeLevelMarker
                  depth={o.depth}
                  maxLevels={TREE_INDENT_MAX_LEVELS}
                  className="-mr-2"
                />
                {/* Every value here is ui/checkbox.tsx's, restated because this
                    box is hand-rolled rather than that component (the header's
                    third divergence: the primitive is boolean-only, and this row
                    needs a third state). Hand-rolled control chrome does not
                    track the kit and nothing reports that it has stopped — this
                    sat at the registry's `rounded-[4px]` after the kit took
                    web-ui's 6, a valid box with valid classes two radii away
                    from every other checkbox in the app. If ui/checkbox.tsx
                    moves, move this with it. → docs/theme.md, _the two kits_. */}
                <View
                  className={cn(
                    'size-4 shrink-0 items-center justify-center rounded-[6px] border',
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
// without building a query first). One native change: "See plans" closes the
// sheet before routing, so coming back from the Subscription screen lands on
// the links screen rather than on a stale draft — the add panel's quota banner
// does the same.
function LockedBanner({ onSeePlans }: { onSeePlans: () => void }) {
  return (
    <View className="flex-row items-start gap-2 rounded-md bg-muted px-3 py-2">
      <FirstLineSlot textClassName="text-xs">
        <Icon as={Lock} className="size-3.5 text-muted-foreground" />
      </FirstLineSlot>
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

// Who owns whether the advanced editor is open, and where it draws: around the
// links Drawer in `(app)/links/_layout.tsx`, beside the add and edit hosts, so
// its sheet is a sibling of the whole links section rather than a layer inside
// the screen this trigger lives in (components/ui/sheet.tsx — reach, and why a
// sheet is not portaled). The trigger reaches it through `useAdvancedSearch()`.
// Mounted only while open, so each open snapshots the CURRENT query into a
// fresh draft (web's onOpenChange).
const AdvancedSearchContext = createContext<{ openAdvanced: () => void } | null>(null);

export function AdvancedSearchHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ openAdvanced: () => setOpen(true) }), []);
  return (
    <AdvancedSearchContext.Provider value={value}>
      {children}
      {open && <AdvancedSearchSheet onClose={close} />}
    </AdvancedSearchContext.Provider>
  );
}

function useAdvancedSearch() {
  const value = useContext(AdvancedSearchContext);
  if (!value) throw new Error('useAdvancedSearch must be used within AdvancedSearchHost');
  return value;
}

function AdvancedSearchTrigger() {
  const { query } = useLinksPage();
  const { openAdvanced } = useAdvancedSearch();

  return (
    <>
      {/* 50x48 effective: `left: 2` is half the `gap-1` to the Input, which
          takes touches of its own (the rule is in links/topbar.tsx), `right: 8`
          runs out to the row's `px-2` frame edge, and 4 above/below clears the
          floor on a box that is already 40. `active:bg-muted` is the press
          feedback every other chrome button has and this one was missing — it
          paints the 40px box, 2px proud of the h-9 Input beside it, which is
          why the box can't simply shrink to match: 20px of glyph in 36 would
          leave the corner dot ~1px off the top slider. 40/20 here against web's
          36/16 is the same 10px margin by a different route — links/topbar.tsx
          carries that rule, docs/accessibility.md the hitSlop one. */}
      <Button
        variant="ghost"
        size="icon"
        onPress={openAdvanced}
        testID="links-search-advanced"
        aria-label="Advanced search"
        hitSlop={{ top: 4, bottom: 4, left: 2, right: 8 }}
        className="relative"
      >
        <Icon as={SlidersHorizontal} className="size-5 text-foreground" />
        {hasAdvancedFilters(query) && (
          <View
            aria-hidden
            // `bg-foreground/70` at `1.25`, both matching web (search-bar.tsx
            // carries the arguments): a filled 6px dot at full ink out-weighs the
            // stroked glyph it annotates, so it steps below the glyph's
            // `--foreground`, and it is the quietest rung of the topbar's dot
            // ladder because filters are a state the USER CHOSE where the sync
            // dots beside it mean something wants attention. 5px in rather than
            // 6 buys ~1.4px more air off the end of SlidersHorizontal's top
            // slider. Web is pinned there by its round trigger, and this box is
            // now the same circle (the kit took web's radii — docs/theme.md,
            // _the radius scale_), so the two are pinned alike.
            className="absolute top-1.25 right-1.25 size-1.5 rounded-full bg-foreground/70"
          />
        )}
      </Button>
    </>
  );
}

function AdvancedSearchSheet({ onClose }: { onClose: () => void }) {
  const { query, setQuery } = useLinksPage();
  const lists = useLists();
  const tags = useTags();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const router = useRouter();
  const reveal = useFocusedFieldReveal();

  const [draft, setDraft] = useState<Draft>(() => initDraft(query));

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
    // is the payoff moment, so route to the paywall instead of committing. The
    // sheet stays open BEHIND it, as web's popover does: the paywall is a kit
    // Dialog on the root PortalHost, which draws above the links section's
    // SheetHost on both platforms, so "Not now" lands back on the draft as it
    // was. (It used to close and reopen around the paywall, because a `Modal`
    // is a native window Android draws over the root host.) Upgrading pushes
    // the Subscription screen over the whole links section, sheet included.
    if (!entitlements.searchEditor) {
      paywall.show('searchEditor');
      return;
    }
    const q = emptyQuery();
    q.text.all = words(draft.textAll);
    q.text.any = words(draft.textAny);
    q.text.none = words(draft.textNone);
    q.url.all = words(draft.url);
    q.title.all = words(draft.title);
    q.note.all = words(draft.note);
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
    onClose();
  };

  return (
    <Sheet
      title="Advanced search"
      closeLabel="Close advanced search"
      closeTestID="advanced-search-close"
      onClose={onClose}
      // Nothing here is guarded: the draft is a query, rebuilt in seconds and
      // seeded from the committed one on every open, so the backdrop and
      // Android's back close it like the ✕.
      onDismiss={onClose}
      reveal={reveal}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            testID="advanced-search-clear"
            onPress={() => setDraft(initDraft(emptyQuery()))}
          >
            <Text>Clear</Text>
          </Button>
          <Button size="sm" testID="advanced-search-submit" onPress={apply}>
            <Text>Search</Text>
          </Button>
        </>
      }
    >
      {!entitlements.searchEditor && (
        <LockedBanner
          onSeePlans={() => {
            onClose();
            router.push('/settings/subscription');
          }}
        />
      )}
      {/* The word trio (Google-advanced-search shape) over the combined
          url⊕title haystack — text.all / text.any / text.none. Because
          the haystack contains the url, "None of these words" also
          covers the practical exclude-a-domain case. */}
      <WordField
        testID="advanced-search-text-all"
        label="All of these words (URL or title)"
        value={draft.textAll}
        placeholder="every word must match"
        onChangeText={(v) => setDraft((d) => ({ ...d, textAll: v }))}
        onFocus={reveal.onFieldFocus}
        onBlur={reveal.onFieldBlur}
      />
      <WordField
        testID="advanced-search-text-any"
        label="Any of these words"
        value={draft.textAny}
        placeholder="at least one matches"
        onChangeText={(v) => setDraft((d) => ({ ...d, textAny: v }))}
        onFocus={reveal.onFieldFocus}
        onBlur={reveal.onFieldBlur}
      />
      <WordField
        testID="advanced-search-text-none"
        label="None of these words"
        value={draft.textNone}
        placeholder="exclude matches"
        onChangeText={(v) => setDraft((d) => ({ ...d, textNone: v }))}
        onFocus={reveal.onFieldFocus}
        onBlur={reveal.onFieldBlur}
      />
      <WordField
        testID="advanced-search-url"
        label="URL contains"
        value={draft.url}
        onChangeText={(v) => setDraft((d) => ({ ...d, url: v }))}
        onFocus={reveal.onFieldFocus}
        onBlur={reveal.onFieldBlur}
      />
      <WordField
        testID="advanced-search-title"
        label="Title contains"
        value={draft.title}
        onChangeText={(v) => setDraft((d) => ({ ...d, title: v }))}
        onFocus={reveal.onFieldFocus}
        onBlur={reveal.onFieldBlur}
      />
      {/* The one searchable field with no basic counterpart — the word
          trio above runs over url⊕title only, so this is the only way to
          reach what you wrote about a link. */}
      <WordField
        testID="advanced-search-note"
        label="Note contains"
        value={draft.note}
        onChangeText={(v) => setDraft((d) => ({ ...d, note: v }))}
        onFocus={reveal.onFieldFocus}
        onBlur={reveal.onFieldBlur}
      />
      <TriCheckList
        label="Lists"
        options={listOptions}
        include={draft.listsAny}
        exclude={draft.listsNone}
        onChange={(include, exclude) =>
          setDraft((d) => ({ ...d, listsAny: include, listsNone: exclude }))
        }
        onFilterFocus={reveal.onFieldFocus}
        onFilterBlur={reveal.onFieldBlur}
      />
      <TriCheckList
        label="Tags"
        options={tagOptions}
        include={draft.tagsInclude}
        exclude={draft.tagsNone}
        onChange={(include, exclude) =>
          setDraft((d) => ({ ...d, tagsInclude: include, tagsNone: exclude }))
        }
        onFilterFocus={reveal.onFieldFocus}
        onFilterBlur={reveal.onFieldBlur}
        // The match toggle only matters once ≥2 tags are included (any ≡
        // all for one tag); below that the ✓/− legend takes the slot.
        action={
          draft.tagsInclude.length >= 2 ? (
            <View className="flex-row items-center gap-1">
              <Text className="text-[10px] text-muted-foreground">Match</Text>
              {(['any', 'all'] as const).map((mode) => (
                <Pressable
                  // A two-option exclusive picker, so `radio` rather than
                  // `button` — and `aria-checked`, which is the state
                  // `radio` carries (`aria-selected` belongs to tabs and
                  // options; jsx-a11y rejects it here).
                  role="radio"
                  key={mode}
                  onPress={() => setDraft((d) => ({ ...d, tagsMode: mode }))}
                  aria-checked={draft.tagsMode === mode}
                  // The visible word is just "any"/"all"; the "Match"
                  // label beside it is a sibling node, so each option
                  // has to carry the whole phrase itself.
                  aria-label={`Match ${mode}`}
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
    </Sheet>
  );
}

export function SearchBar() {
  const { searchVisible, bulkEditing, restorePreSearch } = useLinksViewState();
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
    // GLOBAL: replace the whole query with just the text, so a search spans the
    // library rather than the view it was typed from. Sort is a global synced
    // setting applied by use-links, not part of the query. SUBMITTING NOTHING IS
    // NOT A COMMIT — it's the same "get me out of this search" as the ✕ below,
    // so it takes the same exit rather than committing an empty query to the
    // inbox.
    if (w.length === 0) {
      restorePreSearch();
      return;
    }
    const q = emptyQuery();
    q.text.all = w;
    setQuery(q);
  };

  // Emptying the box ABORTS the search; it does not commit a new one. So it
  // restores the view the search was run from rather than navigating home —
  // `setQuery(emptyQuery())` here put the user in My List, which is a silent
  // view reset AND a dead end: the query is simple again, so the topbar's ✕ no
  // longer has a search to leave, and the list they were on is reachable only by
  // re-navigating the drawer. Same body as every other exit
  // (view-state-provider's `restorePreSearch`), and a no-op when nothing is
  // committed — typing into the box over a list view and clearing it again
  // leaves that list alone.
  const clearBasic = () => {
    setText('');
    restorePreSearch();
  };

  return (
    // `py-2`, not `pb-2`: the row is summoned BELOW the topbar's own border, so
    // without the top half the box sits flush against that line while floating
    // clear of this row's — matching web's `py-2` on the same summoned row
    // (`(app)/links/_panes/topbar.tsx`).
    <View className="flex-row items-center gap-1 border-b border-border px-2 py-2">
      <View className="relative min-w-0 flex-1">
        <View pointerEvents="none" className="absolute inset-y-0 left-2.5 z-10 justify-center">
          <Icon as={Search} className="size-4 text-muted-foreground" />
        </View>
        <Input
          testID="links-search-input"
          value={text}
          onChangeText={setText}
          onSubmitEditing={submitBasic}
          returnKeyType="search"
          autoFocus
          placeholder="Search links…"
          aria-label="Search links"
          className="h-9 pr-8 pl-8"
        />
        {text.length > 0 && (
          <View className="absolute inset-y-0 right-1 justify-center">
            <Pressable
              role="button"
              testID="links-search-clear"
              onPress={clearBasic}
              aria-label="Clear search"
              className="size-7 items-center justify-center rounded"
            >
              <Icon as={X} className="size-4 text-muted-foreground" />
            </Pressable>
          </View>
        )}
      </View>
      <AdvancedSearchTrigger />
    </View>
  );
}
