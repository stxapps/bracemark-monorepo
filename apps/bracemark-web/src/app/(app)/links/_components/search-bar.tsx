'use client';

// The topbar search: a persistent BASIC box (global word search over the combined
// url⊕title — the free rung) plus an ADVANCED popover (the all/any/none word trio
// over that same haystack, field-scoped url/title, and tri-state include/exclude
// lists/tags with any/all tag matching — the Plus `searchEditor` rung). Both commit
// through `setQuery` (page-provider): they write the URL, and `query`/`selection` re-derive
// from it, so the box always reflects the committed query and a `?text=…` deep link
// rehydrates it.
//
// It renders in two SLOTS without knowing which: inline in the topbar from `md`
// up, and in the row that bar summons below `md` (topbar.tsx owns both, and the
// measure — this component always fills what it's given). The row is where the
// `autoFocus` prop is used: a box you had to press a button to reveal should be
// ready to type in.
//
// Basic search is GLOBAL by design:
// submitting the box replaces the whole query with just its text, so a search spans
// the library rather than the list you happened to be on. The advanced popover, by
// contrast, edits the FULL current query in place (WYSIWYG on the URL) — it snapshots
// the committed query on open, so it can refine what's already active.

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Lock, Search, SlidersHorizontal, X } from 'lucide-react';
import Link from 'next/link';

import { flattenTree } from '@stxapps/shared';
import { emptyQuery, type LinkQuery, useEntitlements, useLists, useTags } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import { Field, FieldLabel } from '@stxapps/web-ui/components/ui/field';
import { Input } from '@stxapps/web-ui/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@stxapps/web-ui/components/ui/popover';

import { useLinksPage } from '../_contexts/page-provider';
import { useLinksViewState } from '../_contexts/view-state-provider';

import { usePaywall } from '@/contexts/paywall-provider';

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

// Whether the committed query narrows the view in a way the rest of the UI does NOT
// already show. Drives the trigger's active dot. The UI has exactly two ways to
// render a filter — the basic box (which shows `text.all`) and the sidebar highlight
// (`selection`) — so the dot lights precisely when those two don't account for the
// whole query. Plain navigation (a list or tag picked in the sidebar) does NOT light
// it; neither does a bare global text search.
function hasAdvancedFilters(q: LinkQuery): boolean {
  // Substring predicates the basic box cannot render (it shows `text.all` only —
  // the other forms live in the advanced editor, which is closed chrome).
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

  // Past this point the box shows `text.all` and the sidebar can highlight ONE list
  // or tag — but never both: a text clause makes `selection` resolve to `none`
  // (page-provider's `selectionFromQuery`, which drops the highlight rather than let
  // it go stale during a search). So any list/tag sitting alongside text is
  // unrepresented on screen, and the dot is the only thing left to surface it.
  const lists = q.lists.any.length;
  const tags = q.tags.any.length;
  if (lists > 1 || tags > 1) return true;
  if (lists >= 1 && tags >= 1) return true;
  return q.text.all.length > 0 && lists + tags > 0;
}

// The advanced popover's editable snapshot — raw strings for the word fields (so
// spaces survive mid-typing; split to words only on submit) and id lists for the
// tri-state checklists. Covers the whole grammar EXCEPT the field-scoped
// url/title/note any/none forms, which stay deep-link-only on purpose: `text`'s
// combined url⊕title haystack subsumes the first two in practice, `note` follows
// its siblings, and they'd cost six more inputs for the tail of the tail. So open → Search round-trips everything
// else. Tags carry ONE include set + a match mode (any|all) rather than both
// positive relations at once — a hand-built deep link with both `tag-any` and
// `tag-all` collapses to `all` mode over their union (WYSIWYG: the checkboxes
// show exactly the set that will run).
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

// A tri-state checklist: each row cycles off → include (check) → exclude (minus)
// → off, feeding the clause's positive (`any`/`all`) and `none` arrays. The
// Checkbox's `indeterminate` state doubles as the exclude visual (it renders the
// minus icon); since indeterminate ≠ excluded semantically, the aria-label spells
// the real state out. `action` renders on the label row (the tags match toggle);
// without one, a static ✓/− legend teaches the cycle.
// Above this many options, the checklist gets a filter box so a big list/tag
// tree stays navigable without scrolling. Filtering only hides rows from view;
// it never touches the include/exclude sets, so a selection made under one
// filter survives changing or clearing it.
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
  action?: ReactNode;
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
    <div className="flex flex-col gap-1">
      <div className="flex h-6 items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        {action ?? (
          <span aria-hidden className="text-[10px] text-muted-foreground">
            ✓ include · − exclude
          </span>
        )}
      </div>
      {showFilter && (
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${label.toLowerCase()}…`}
          aria-label={`Filter ${label.toLowerCase()}`}
          // `text-base md:text-sm` — the control type step (web-ui's input.tsx).
          // This box was the last control holding a flat `text-sm` against it,
          // and it is a real text input: on a phone, focusing it zoomed the page,
          // which is the whole thing the step exists to stop. The height steps
          // with it — `h-7` cannot hold a 16px line box, and `h-8` is what the
          // five Inputs further down this same panel already use on a phone (and
          // what bracemark-expo's twin of this field uses at every width). The
          // desktop tier is untouched: `md:` restores the 28px box at 14px, so
          // the dense panel reads exactly as it did.
          className="h-8 text-base md:h-7 md:text-sm"
        />
      )}
      {/* `scrollbar-gutter-stable` for the reason the links sidebar carries: the
          filter box directly above prunes these rows, and `max-h-32` is ~4 rows
          against a FILTER_THRESHOLD of 8, so the box only exists on a checklist
          that is already scrolling — typing one character reliably takes the
          scrollbar away. The row labels are `truncate` and indented by `depth`,
          so on a classic-scrollbar platform that 15px re-truncates list and tag
          names while you are reading them to decide what to tick. Bordered box,
          so the reserved strip also keeps the border's inset even. */}
      <div className="max-h-32 scrollbar-gutter-stable overflow-y-auto rounded-md border border-border p-1">
        {visible.length === 0 && (
          <p className="px-1.5 py-1 text-sm text-muted-foreground">
            No matching {label.toLowerCase()}
          </p>
        )}
        {visible.map((o) => {
          const state = include.includes(o.id)
            ? 'include'
            : exclude.includes(o.id)
              ? 'exclude'
              : 'off';
          return (
            <label
              key={o.id}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted"
              style={o.depth > 0 ? { paddingLeft: `${o.depth * 12 + 6}px` } : undefined}
            >
              <Checkbox
                checked={state === 'include' ? true : state === 'exclude' ? 'indeterminate' : false}
                onCheckedChange={() => cycle(o.id)}
                aria-label={`${o.name}: ${
                  state === 'include'
                    ? 'included'
                    : state === 'exclude'
                      ? 'excluded'
                      : 'not selected'
                }`}
              />
              <span
                className={
                  state === 'exclude' ? 'truncate text-muted-foreground line-through' : 'truncate'
                }
              >
                {o.name}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// The Plus gate: field-scoped + multi-list/tag search is the `searchEditor`
// entitlement. Free users get the FULL editor to try —
// visible and interactive (a banner names it as Plus) — and the gate fires only
// when they press Search, which routes to the paywall instead of committing. This
// "let them build, then upgrade at the payoff" beats hiding the fields: the wall
// lands at peak intent, and nothing sensitive is thrown away (unlike locks, which
// gate before their password dialog).
//
// The banner's own "See plans" link is the door for the user who wants the offer
// WITHOUT first building a query to trigger it — pressing Search still routes to
// the paywall, which stays the primary, peak-intent path. (Contrast the link cap,
// which replaces its form with LinkQuotaBanner and skips the paywall entirely:
// there the action is impossible, whereas this one is a click away.)
function LockedBanner() {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      <Lock className="mt-0.5 size-3.5 shrink-0" />
      <span>
        A <span className="font-medium text-foreground">Plus</span> feature. Build your query, then
        upgrade to run it.{' '}
        <Link
          href="/settings/subscription"
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          See plans
        </Link>
      </span>
    </div>
  );
}

function AdvancedSearch() {
  const { query, setQuery } = useLinksPage();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const lists = useLists();
  const tags = useTags();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => initDraft(query));
  // True while the paywall is layered over an OPEN popover (free user pressed
  // Search). We keep the popover open underneath so "Not now" returns the user to
  // their built query, untouched — hence we ignore Radix's close requests while
  // gated, and clear it from the paywall's onDismiss.
  const [gated, setGated] = useState(false);

  // Snapshot the committed query into the draft each time the popover opens, so it
  // edits the CURRENT query rather than a stale one. While gated, refuse close
  // requests (a focus-out to the modal paywall) so the popover — and the draft —
  // survive a "Not now".
  const onOpenChange = (next: boolean) => {
    if (gated && !next) return;
    if (next) setDraft(initDraft(query));
    setOpen(next);
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
    // The gate: a free user built a query to try the feature — pressing Search is
    // the payoff moment, so route to the paywall instead of committing. Keep the
    // popover open behind it (gated) so backing out with "Not now" leaves their
    // query exactly as they built it.
    if (!entitlements.searchEditor) {
      setGated(true);
      paywall.show('searchEditor', () => setGated(false));
      return;
    }
    // Sort isn't a search field — it's a global synced setting applied by
    // use-links, so a committed search carries only the default sort (harmless:
    // use-links overrides it). No sort to preserve here anymore.
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
    // same set for one tag) — `any` keeps the sidebar highlight and the clean
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
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {/* `icon` (36) rather than `icon-sm`: the trigger sits in one flex row with
            the h-9 box, so matching its height keeps the pair reading as a single
            search widget in both slots — inline and in the summoned row. */}
        <Button variant="ghost" size="icon" aria-label="Advanced search" className="relative">
          <SlidersHorizontal className="size-4" />
          {hasAdvancedFilters(query) && (
            /* `1.25` (5px), not the 1.5 a badge dot usually takes on a square
               button: this one is round (the ghost hover is a 36px circle), and
               the two constraints pull opposite ways along the diagonal. Inside
               the circle needs the dot's centre within 15px of the middle —
               true from 1.25 out, false at 1 (the dot's rim crosses the hover
               edge). Clear of the glyph pushes the other way: at 1.5 the dot
               lands ~1.5px off the end of SlidersHorizontal's top slider and
               reads as touching it. 1.25 is the one quarter-step that satisfies
               both, ~3px of air from the glyph with the dot still fully inside.
               The topbar's other dot — the sync one on MoreOptionsMenu's
               trigger — is pinned to the same offset so the pair lines up.

               `bg-foreground/70`, not `bg-primary`. Every glyph in this bar
               inherits `--foreground`, and `--primary` is a hair off it (0.205
               against 0.145 — this theme has no brand hue, so primary IS
               near-black), which leaves the dot at full ink: a FILLED 6px
               circle carries several times the ink of the 1.5px strokes it is
               annotating, so the loudest mark on the bar becomes the dot rather
               than the control it belongs to. A step down reads as plainly at a
               glance and stops it out-weighing its host. Same token as the add
               form's "this collapsed section holds something" dot
               (link-add-surface.tsx) — the same statement about a closed
               surface, and one rule behind both: the dot never out-weighs the
               thing it marks. */
            <span
              aria-hidden
              className="absolute top-1.25 right-1.25 size-1.5 rounded-full bg-foreground/70"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[70vh] w-80 overflow-y-auto"
        // Belt-and-suspenders with the onOpenChange guard: the modal paywall's
        // focus grab must not dismiss the popover underneath it.
        onInteractOutside={(e) => gated && e.preventDefault()}
        onFocusOutside={(e) => gated && e.preventDefault()}
      >
        {/* `gap-3.5` (14px), between the add form's `gap-4` and the 12px this
            panel used to run at. The dense tier is about TYPE — small labels over
            short controls — not about crowding the stack; at 12px each field's
            label sat nearly as close to the control above it as to its own, which
            is what dissolves the grouping when the labels are only 12px to begin
            with. 14px against `Field`'s internal `gap-1` gives a 1:3.5 ratio, and
            being a half-step down from the form still pays for itself in a panel
            that's `max-h-[70vh]` with ten children stacked in it. */}
        <div className="flex flex-col gap-3.5">
          {/* The app's ONE panel-title style, the same string SheetTitle and
              DialogTitle carry (sheet.tsx, dialog.tsx). This popover is a titled
              surface like they are, so it takes their title rather than inventing
              a third size for the role — at `text-sm` it was separated from the
              body only by weight, which is precisely how a title stops reading as
              one. Dense fields under a full-size title is also what the expo port
              of this panel does (its modal keeps the native screen-title rung over
              `text-xs` WordField labels). */}
          <p className="text-base leading-none font-medium">Advanced search</p>
          {!entitlements.searchEditor && <LockedBanner />}
          {/* The word trio (Google-advanced-search shape) over the combined
              url⊕title haystack — text.all / text.any / text.none. Because the
              haystack contains the url, "None of these words" also covers the
              practical exclude-a-domain case.

              `density="dense"` (label.tsx) over `h-8` controls, matching the
              checklist labels and hint block below. Don't promote these six to
              standard — they'd out-weigh the checklists they sit above. */}
          <Field className="gap-1">
            <FieldLabel htmlFor="adv-text-all" density="dense">
              All of these words (URL or title)
            </FieldLabel>
            <Input
              id="adv-text-all"
              value={draft.textAll}
              placeholder="every word must match"
              onChange={(e) => setDraft((d) => ({ ...d, textAll: e.target.value }))}
              className="h-8"
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="adv-text-any" density="dense">
              Any of these words
            </FieldLabel>
            <Input
              id="adv-text-any"
              value={draft.textAny}
              placeholder="at least one matches"
              onChange={(e) => setDraft((d) => ({ ...d, textAny: e.target.value }))}
              className="h-8"
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="adv-text-none" density="dense">
              None of these words
            </FieldLabel>
            <Input
              id="adv-text-none"
              value={draft.textNone}
              placeholder="exclude matches"
              onChange={(e) => setDraft((d) => ({ ...d, textNone: e.target.value }))}
              className="h-8"
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="adv-url" density="dense">
              URL contains
            </FieldLabel>
            <Input
              id="adv-url"
              value={draft.url}
              onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              className="h-8"
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="adv-title" density="dense">
              Title contains
            </FieldLabel>
            <Input
              id="adv-title"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              className="h-8"
            />
          </Field>
          {/* The note is the one searchable field with NO basic counterpart: the
              word trio above runs over url⊕title only, so this box is the only way
              to reach what you wrote about a link. Placed last of the field-scoped
              three, after the two the trio already covers. */}
          <Field className="gap-1">
            <FieldLabel htmlFor="adv-note" density="dense">
              Note contains
            </FieldLabel>
            <Input
              id="adv-note"
              value={draft.note}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              className="h-8"
            />
          </Field>
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
            // The match toggle only matters once ≥2 tags are included (any ≡ all
            // for one tag); below that the ✓/− legend takes the slot.
            action={
              draft.tagsInclude.length >= 2 ? (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-muted-foreground">Match</span>
                  {(['any', 'all'] as const).map((mode) => (
                    <Button
                      key={mode}
                      variant={draft.tagsMode === mode ? 'secondary' : 'ghost'}
                      size="xs"
                      onClick={() => setDraft((d) => ({ ...d, tagsMode: mode }))}
                    >
                      {mode}
                    </Button>
                  ))}
                </div>
              ) : undefined
            }
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDraft(initDraft(emptyQuery()))}>
              Clear
            </Button>
            <Button size="sm" onClick={apply}>
              Search
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SearchBar({ autoFocus = false }: { autoFocus?: boolean }) {
  const { query, setQuery } = useLinksPage();
  const { restorePreSearch } = useLinksViewState();

  // Basic box: a draft synced from the committed text. Navigation clears text → the
  // box empties; a basic/advanced search sets it → the box shows it.
  const committedText = useMemo(() => query.text.all.join(' '), [query.text.all]);
  const [text, setText] = useState(committedText);
  useEffect(() => setText(committedText), [committedText]);

  const submitBasic = () => {
    const w = words(text);
    // GLOBAL: replace the whole query with just the text, so a search spans the
    // library rather than the view it was typed from. Sort is a global synced
    // setting applied by use-links, not part of the query, so there's nothing to
    // carry over. SUBMITTING NOTHING IS NOT A COMMIT — it's the same "get me out
    // of this search" as the ✕ below, so it takes the same exit rather than
    // committing an empty query to the inbox.
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
  // view reset AND a dead end: the query is simple again, so the topbar's
  // dismiss no longer has a search to leave, and the list they were on is
  // reachable only by re-navigating the sidebar. Same body as every other exit
  // (view-state-provider's `restorePreSearch`), and a no-op when nothing is
  // committed — typing into the box over a list view and clearing it again
  // leaves that list alone.
  const clearBasic = () => {
    setText('');
    restorePreSearch();
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <form
        role="search"
        className="relative min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          submitBasic();
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search links…"
          aria-label="Search links"
          autoFocus={autoFocus}
          className="h-9 pr-8 pl-8"
        />
        {text.length > 0 && (
          <button
            type="button"
            onClick={clearBasic}
            aria-label="Clear search"
            className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </form>
      <AdvancedSearch />
    </div>
  );
}
