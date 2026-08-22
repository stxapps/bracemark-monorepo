'use client';

// Quick-add for links: the surface behind the topbar's "Add" button. It's an
// EPHEMERAL action, not a view — so it lives in local state, never the URL (the
// page-provider header explains the split: shareable state goes in the URL,
// transient/private state does not). A heavier full editor (page copy, page
// content) is the future dialog/route, not this.
//
// ONE FORM, TWO CONTAINERS, SPLIT AT `md`. Above the breakpoint it's a popover
// anchored to its trigger, because it's launched from one specific button and
// should stay in that context. Below it, the same form fills a bottom sheet.
// The reason is the SOFT KEYBOARD, not the width:
//
//   The URL field is `autoFocus`, so the keyboard is up the moment the surface
//   opens. `PopoverContent` caps itself at Radix's collision-computed available
//   height — but Floating UI measures the LAYOUT viewport, which the keyboard
//   does not shrink (docs/safe-area.md, _what's provided_ — on most mobile
//   browsers the keyboard fires only `visualViewport.resize`). So an anchored
//   popover hanging off a top-right trigger believes it has the whole screen,
//   and with the optional fields open its footer — Save, the one control that completes
//   the task — sits under the keyboard, in a scroll container that doesn't know
//   it's clipped and so won't scroll to it.
//
//   A bottom sheet does NOT fix that by itself: `position: fixed` anchors to the
//   same layout viewport, so `bottom-0` is under the keyboard too. What fixes it
//   is measuring the VISUAL viewport and lifting the sheet by the occluded
//   height — safe-area.md, _popups & dialogs_ (2), the hand-rolled-geometry case.
//   That's `keyboardInset` below.
//
// The split also lands narrow web on the shape bracemark-expo already uses: the
// add form takes over the bottom of the screen rather than hanging from a corner
// (its `/add-link` modal screen — link-add-screen.tsx). The TRIGGER doesn't move,
// though: it stays the topbar's Add button at every width, where web's desktop
// layout also keeps it. expo's FAB is a different affordance for a different
// frame, and the two clients agree on the form, not on where it's summoned from.
//
// Shape: a URL field always visible, a "List, tags & note" disclosure that
// reveals the list picker + tag editor + note, and Save/Cancel. The disclosure is
// NAMED FOR ITS CONTENTS, not "Advanced": there is nothing advanced about filing
// a link into a list, and the novice/expert axis that earns the word on advanced
// SEARCH (a plain box vs. the full grammar) has no counterpart here — URL is the
// one required field and these three are the optional ones. "More options" was
// unavailable in any case: it is the topbar overflow's name, one row up
// (docs/brand-assets.md is the record for user-facing wording). Collapsing the
// disclosure HIDES those fields, it never discards them — `optionalSet` below
// carries the reasoning and the dot that keeps the hidden state visible. Saving
// writes one
// `links/{id}.enc` via useLinkMutations and kicks a sync; the title is
// back-filled later by a metadata fetch, so the form only collects a URL
// (+ optional list/tags/note — the same create fields the extension editor sets).
//
// Validation is two-tier: an EMPTY URL is a hard, blocking error; a non-empty
// but MALFORMED URL, or one that's ALREADY SAVED, only warns and relabels
// Save → Confirm, so the user can save it as typed on a second click (we never
// block on a debatable-but-deliberate URL — re-saving can be intentional, and
// the local-first store can't guarantee URL uniqueness across devices anyway).
// Bare domains are fine — they're normalized to https:// on save. The list
// picker and tag editor are the shared ListSelect/TagsField (web-ui), the same
// pieces the extension editor and the edit dialog render.
//
// The already-saved warning has a TRASHED variant, and it's the one case that
// offers an action instead of just a sentence. A plain duplicate is visible —
// "you've already saved this" points at something the user can go find — but a
// trashed match is invisible everywhere they browse or search (use-links
// suppresses Trash outside the Trash view), so naming it as a duplicate without
// a way to reach it is a dead end. Worse, Confirm would then mint a live copy
// shadowing the trashed one, and `readLinkByUrlKey` (a `.first()` on the index)
// would start returning an arbitrary one of the two. So Restore is offered
// alongside Confirm: it reuses the existing record — keeping its history — while
// Confirm stays the deliberate "no, a fresh copy" door.
//
// One state precedes all of that: a free library at its link cap can't save at
// all, so the surface renders the shared LinkQuotaBanner INSTEAD of the form
// (useLinkQuota — which also explains why this gate is load-bearing rather than
// cosmetic: it IS the cap, since the server no longer counts links).

import { useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import Link from 'next/link';

import {
  DEFAULT_LIST_ID,
  LINK_NOTE_MAX,
  normalizeUrl,
  PLAN_LABELS,
  TRASH_ID,
} from '@stxapps/shared';
import {
  type LinkItem,
  readLinkByUrlKey,
  useLinkMutations,
  useLinkQuota,
} from '@stxapps/web-react';
import { LinkQuotaBanner } from '@stxapps/web-ui/components/links/link-quota-banner';
import { ListSelect } from '@stxapps/web-ui/components/links/list-select';
import { TagsField } from '@stxapps/web-ui/components/links/tags-field';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Input } from '@stxapps/web-ui/components/ui/input';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@stxapps/web-ui/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@stxapps/web-ui/components/ui/sheet';
import { Textarea } from '@stxapps/web-ui/components/ui/textarea';
import { MD_QUERY, useMediaQuery } from '@stxapps/web-ui/hooks/use-media-query';
import { useVisualViewport, useWindowSize } from '@stxapps/web-ui/hooks/use-window-metrics';
import { cn } from '@stxapps/web-ui/lib/utils';

import { useLinksPage } from '../_contexts/page-provider';

// Breathing room between the sheet's top edge and the top of the visible band,
// so it reads as a sheet rather than a full-screen takeover even when the form
// is at its tallest.
const SHEET_TOP_GUTTER = 24;

// The list to pre-select: the one the user is currently viewing (so "add" lands
// where they're looking), falling back to My List — the inbox — for the All view
// or a tag view, neither of which names a single destination list. Trash falls
// back too: it's the deletion staging area, never a place to add new links.
function useDefaultListId(): string {
  const { selection } = useLinksPage();
  return selection.kind === 'list' && selection.id !== TRASH_ID ? selection.id : DEFAULT_LIST_ID;
}

/**
 * Geometry for the narrow-width sheet, in layout-viewport pixels: how far to
 * lift it off the bottom so the keyboard doesn't cover it, and how tall it may
 * get before it must scroll inside.
 *
 * `keyboardInset` is the band the keyboard occludes — the layout viewport's
 * height minus the visible region, minus how far that region has been pushed
 * down. Setting it as `bottom` puts the sheet's bottom edge exactly on the
 * bottom of the visible band, so `maxHeight` is then just that band's height.
 *
 * Pinch-zoom shrinks the visual viewport the same way a keyboard does, and the
 * subtraction can't tell them apart — so while zoomed (`scale > 1`) we leave the
 * sheet where CSS put it rather than lifting it by an amount that isn't a
 * keyboard. Zero height means SSR or no `visualViewport` API, where we hand back
 * `null` and let the fallback class own the sizing.
 */
function useSheetGeometry(): { bottom: number; maxHeight: number } | null {
  const visual = useVisualViewport();
  const layout = useWindowSize();

  if (visual.height === 0) return null;
  if (visual.scale > 1) return { bottom: 0, maxHeight: visual.height - SHEET_TOP_GUTTER };

  const bottom = Math.max(0, layout.height - visual.height - visual.offsetTop);
  return { bottom, maxHeight: visual.height - SHEET_TOP_GUTTER };
}

export function LinkAddSurface({
  // The empty pane renders a second instance of this as its call to action,
  // where the trigger is the only control on screen rather than one of four in a
  // bar — so it gets full size, keeps the word Add (which the topbar's trigger no
  // longer carries at any width), and hangs its content centred under itself.
  // That's the whole difference: the trigger's size and where the panel hangs
  // from it, never the form behind it, which is one add form wherever it is
  // summoned from. (Below `md` there's nothing to
  // hang from — the sheet is edge-to-edge either way — so `prominent` there
  // varies only the trigger.)
  prominent = false,
}: {
  prominent?: boolean;
}) {
  const { create, update } = useLinkMutations();
  const defaultListId = useDefaultListId();
  const { count, max, atLimit } = useLinkQuota();
  // `md` is where the topbar already changes regime — the rail becomes a drawer
  // and the search box becomes a summoned row (topbar.tsx) — so add joins that
  // fork rather than inventing a second one. The query string itself is shared
  // (use-media-query), since the Move-to pickers fork at the same width.
  const wide = useMediaQuery(MD_QUERY);
  const sheetGeometry = useSheetGeometry();

  const [open, setOpen] = useState(false);
  const [openOptional, setOpenOptional] = useState(false);
  const [url, setUrl] = useState('');
  const [listId, setListId] = useState(defaultListId);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  // urlError is a HARD, blocking error (empty URL); urlWarning is the SOFT
  // state that relabels Save → Confirm and lets the next submit through. Three
  // grounds, checked in order on submit — 'malformed' (can't normalize), then
  // the already-saved pair 'trashed' / 'duplicate' — so a URL that's both warns
  // on each ground in turn. Editing the field disarms whichever is showing.
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlWarning, setUrlWarning] = useState<'malformed' | 'duplicate' | 'trashed' | null>(null);
  // The trashed link behind a 'trashed' warning — what Restore acts on. Held
  // from the submit that found it, so Restore doesn't re-query.
  const [trashedMatch, setTrashedMatch] = useState<LinkItem | null>(null);

  // Reset to a clean draft whenever the surface opens; clear on close too so a
  // half-filled form never lingers. defaultListId is read at open time so the
  // pre-selection tracks the view the user opened it from.
  //
  // Every state above lives HERE rather than in a form subcomponent, which is
  // what lets the container swap mid-edit: crossing `md` (a rotation, a resized
  // window) unmounts one Radix root and mounts the other, and a draft held below
  // that boundary would go with it.
  const onOpenChange = (next: boolean) => {
    if (next) {
      setOpenOptional(false);
      setUrl('');
      setListId(defaultListId);
      setTagIds([]);
      setNote('');
      setUrlError(null);
      setUrlWarning(null);
      setTrashedMatch(null);
    }
    setOpen(next);
  };

  const onSubmit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    if (saving) return;

    const trimmed = url.trim();
    // Required: an empty URL is a hard error and blocks the save.
    if (trimmed === '') {
      setUrlError('Please enter a URL.');
      setUrlWarning(null);
      return;
    }
    setUrlError(null);

    // Soft: a URL we can't normalize only warns. The first submit arms the
    // warning and relabels Save → Confirm; submitting again (Confirm) saves the
    // raw text as typed. A normalizable value (incl. a bare domain) saves the
    // normalized https:// form.
    const normalized = normalizeUrl(trimmed);
    if (normalized === null && urlWarning === null) {
      setUrlWarning('malformed');
      return;
    }

    setSaving(true);
    try {
      // Soft, second ground: the URL is already saved. Matched by canonical
      // dedup identity (readLinkByUrlKey — folds scheme/www/trailing slash/query
      // order), so trivial variants of a saved link warn too. A match in Trash
      // warns as 'trashed' instead, which adds Restore to the footer. Only checked
      // while neither is armed — an armed warning means the user has seen it, so
      // Confirm saves the duplicate deliberately.
      if (urlWarning !== 'duplicate' && urlWarning !== 'trashed') {
        const existing = await readLinkByUrlKey(normalized ?? trimmed);
        if (existing) {
          const inTrash = existing.listId === TRASH_ID;
          setUrlWarning(inTrash ? 'trashed' : 'duplicate');
          setTrashedMatch(inTrash ? existing : null);
          return;
        }
      }

      await create({ url: normalized ?? trimmed, listId, tagIds, note: note.trim() || undefined });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  // Restore the trashed match instead of minting a second copy. It lands in the
  // list the form names (the view they opened this from, or My List — never Trash,
  // which ListSelect excludes), so Restore reads as "add it here", the same promise
  // Save makes. Anything else they typed rides along: the draft is the request the
  // user just made, so it wins over the old record's fields — and a quick-add draft
  // starts empty, so the untouched case leaves the link's own tags/note alone rather
  // than wiping them. Tags UNION for the same reason: both sets were wanted.
  const onRestore = async () => {
    if (!trashedMatch || saving) return;
    setSaving(true);
    try {
      const trimmedNote = note.trim();
      await update(trashedMatch, {
        listId,
        ...(tagIds.length > 0 ? { tagIds: [...new Set([...trashedMatch.tagIds, ...tagIds])] } : {}),
        ...(trimmedNote ? { note: trimmedNote } : {}),
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  // Which of the three OPTIONAL fields hold something (URL is the required one).
  // Two things read it, so it's one list.
  //
  // COLLAPSING THE SECTION DOES NOT DISCARD THEM — Save uses these values whether
  // the disclosure is open or shut. A disclosure discloses; it doesn't arm. People
  // collapse it to reach Save without scrolling, or to get the sheet clear of the
  // keyboard (the whole pressure this surface is under below `md`), and answering
  // that with a silent revert is the worse of the two failures: Save writes a
  // record, so there'd be no undo. It couldn't even be a clean rule — `listId` is
  // never empty (it starts at defaultListId and is always written), so "collapsed
  // means ignored" would have to mean "collapsed means back to My List", a stranger
  // promise than the one it replaces. What the hidden state does need is to stay
  // VISIBLE: hence the dot on the trigger, which is the answer the advanced-search
  // trigger already gives to the same problem (search-bar.tsx, docs/search.md).
  //
  // Fields, not values: naming the list would need its record, and the point is only
  // to say that something is set down there.
  const optionalSet = [
    listId !== defaultListId ? 'list' : null,
    tagIds.length > 0 ? 'tags' : null,
    note.trim() !== '' ? 'note' : null,
  ].filter((field) => field !== null);

  // Does closing now lose real work? A bare typed URL doesn't count — it's
  // cheap to retype and the click-away-to-dismiss idiom is worth more than
  // guarding it. Only the optional fields (note, tags, a non-default list)
  // represent effort worth protecting from a stray outside-click or Escape.
  const optionalDirty = optionalSet.length > 0;

  // Guard only the ACCIDENTAL close vectors (outside-click / overlay tap,
  // Escape, and the sheet's swipe-adjacent dismissals), and only when the
  // optional section holds work — swallow those so a stray click can't drop a
  // typed note or picked tags. The DELIBERATE doors (Cancel, the sheet's X)
  // call `onOpenChange(false)` directly, bypassing this, so discarding stays one
  // click. Same division bracemark-expo's add screen draws with usePreventRemove
  // plus its own `closing` flag (link-add-screen.tsx).
  const onGuardedOpenChange = (next: boolean) => {
    if (!next && optionalDirty) return;
    onOpenChange(next);
  };

  // THE TOPBAR TRIGGER IS WORDLESS AT EVERY WIDTH; only the prominent one keeps
  // the word. It used to appear at `sm` and up, on the reasoning that a phone bar
  // holding a title and four actions needs the width more than the primary action
  // needs its name — but that argument doesn't stop at 640px. A filled ＋ is the
  // one control on this page that reads without a label (nothing else here
  // creates, and no other ＋ exists on the page), and what marks Add as the odd
  // one in that group is its PAINT and the gap holding it off the other three
  // (topbar.tsx) — not its word. So labelling it wide bought nothing and cost two
  // things: ~35px of a bar whose job is to name where you are, and a SHAPE FORK,
  // a 32px disc below `sm` becoming a ~70px pill above it, in a row of four 36px
  // boxes that is supposed to read as one band. The breakpoint was an orphan
  // besides — everything else in that bar forks at `md` (rail → drawer, search
  // box → summoned row), so between 640 and 767 the widest Add stood in the
  // tightest bar.
  //
  // `aria-label` is now the ONLY carrier of the name: this is an icon-only control
  // with no tooltip, the same bargain the three ghost buttons beside it already
  // make, and ＋ is the most legible glyph of the four. What keeps that honest is
  // the other trigger — the empty pane's CTA is a full `Add` pill, and an empty
  // library is exactly when someone is looking for this verb for the first time.
  // The word teaches there, once; the topbar keeps the glyph.
  //
  // TWO TRIGGERS, BECAUSE THE TWO INSTANCES WANT OPPOSITE THINGS. The empty
  // pane's CTA is the only control on screen and should be as loud as it can be,
  // so it stays a plain `default` Button: a filled 36-tall pill, `font-medium`,
  // the size variant's own padding. The topbar's stands in a row of three 36px
  // ghost squares, where a fill that occupies its whole box reads HEAVIER than
  // them at the same measure — filled shapes always do — and drags the eye off
  // the title. So there the paint shrinks while the BOX does not.
  //
  //   THE BOX IS 36, THE PAINT IS 32. `h-9` (from `size="default"`) squared by an
  //   explicit `w-9`, with the variant's own background neutralized —
  //   `bg-transparent hover:bg-transparent`, which tailwind-merge resolves by
  //   DROPPING `bg-primary`/`hover:bg-primary/80` from the output rather than
  //   layering over them — and every painted pixel moved to the inner span, a
  //   `size-8` disc. The hit area, the focus ring and the band alignment all stay on
  //   the 36 box, so the row still measures as one 36px band and the ring still
  //   matches the ghosts beside it; only the fill is inset. `group-hover/button:`
  //   is how the hover fade reaches the span — the Button base names itself
  //   `group/button` for exactly this.
  //
  //   Sizing the disc as a BOX (`size-8`) and not by padding is what keeps it
  //   round. The base reserves 1px of transparent border on each edge, so a
  //   padded `size-9` box measures 34 inside, and `p-px`-style arithmetic to land
  //   32 breaks the moment that border changes. A fixed `size-8` centred in the
  //   36 box is the same 2px inset on every edge and depends on nothing.
  //
  // `data-icon="inline-start"` is what arms the size variant's
  // `has-data-[icon=inline-start]:pl-2.5` (button.tsx) — the rule is
  // `:has([data-icon=inline-start])`, so without the attribute on the icon it
  // never matches and the leading padding stays the symmetric px-3. It belongs to
  // the PROMINENT trigger alone, whose padding really does live on the button.
  // On the topbar trigger the padding lives on the inner span, and the attribute
  // was actively wrong: `:has()` is depth-agnostic, so it matched from inside the
  // span, and the rule's specificity (0,2,0) beat the `p-0` sitting beside it —
  // 10px of leading padding inside a 36px box the ＋ was supposed to be centred
  // in, pushing it visibly right of centre. Nothing catches that: no overflow and
  // no type error, and on the prominent trigger the identical attribute is right.
  const trigger = prominent ? (
    <Button variant="default" size="default" aria-label="Add link">
      <Plus data-icon="inline-start" className="size-4" />
      <span>Add</span>
    </Button>
  ) : (
    <Button
      variant="default"
      size="default"
      aria-label="Add link"
      className="w-9 bg-transparent p-0 hover:bg-transparent"
    >
      <span className="flex size-8 items-center justify-center rounded-4xl bg-primary transition-colors group-hover/button:bg-primary/80">
        <Plus className="size-4" />
      </span>
    </Button>
  );

  const body =
    atLimit && max !== null ? (
      <LinkQuotaBanner
        count={count}
        max={max}
        action={
          <Button asChild size="sm" className="self-end">
            <Link href="/settings/subscription">Upgrade to {PLAN_LABELS.plus}</Link>
          </Button>
        }
      />
    ) : (
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="link-url" density="dense">
            URL
          </Label>
          <Input
            id="link-url"
            type="url"
            inputMode="url"
            placeholder="https://example.com"
            autoFocus
            aria-invalid={urlError !== null}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              // Editing re-opens the question: clear the error and disarm the
              // warning so the button reverts to Save and re-validates.
              setUrlError(null);
              setUrlWarning(null);
              setTrashedMatch(null);
            }}
          />
          {urlError !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {urlError}
            </p>
          ) : urlWarning !== null ? (
            <p role="alert" className="text-xs text-amber-600 dark:text-amber-500">
              {urlWarning === 'malformed'
                ? 'This doesn’t look like a valid URL. Click Confirm to save it anyway.'
                : urlWarning === 'trashed'
                  ? 'This link is in your Trash. Restore it, or click Confirm to save a new copy.'
                  : 'You’ve already saved this link. Click Confirm to save it again.'}
            </p>
          ) : null}
        </div>

        {/* A quiet disclosure, made quiet by WEIGHT and one measured step of
            COLOUR, never by size: `font-normal` against the Button base's
            `text-sm font-medium`, plus `text-foreground/70`. Shrinking the type
            costs legibility on the one control in the form that isn't
            self-evident, so the type stays at 14.

            `text-foreground/70` and NOT `text-muted-foreground`, which is the
            colour of the field Labels this button sits above (Label's `dense`
            density is `text-xs text-muted-foreground`) — wearing it would tie the
            control with the captions it introduces and read as one of them. The
            /70 lands between: `#545454` on white against muted's `#6e6e6e`,
            `#b2b2b2` on the dark ground against muted's `#a1a1a1` — 7.6:1 where
            muted is 5.1:1, which is a step back from the Input's full foreground
            without arriving at caption grey. Same idiom, same value, as the tag
            chips on both clients (link-tag-chips.tsx). Weight alone WAS the whole
            adjustment while the label was the single word "Advanced"; three words
            and a chevron carry more, so the same quiet now costs colour too.

            The ghost variant's `hover:text-foreground` lifts it to full contrast
            on hover — which is the documented ghost-trigger behaviour, and the
            reason ghost triggers are exempt from the wash-contrast rule
            (docs/theme.md, _contrast_): they leave the reduced colour exactly when
            they land on a wash. A pseudo-class outranks a plain utility, so the
            lift wins over /70 without any ordering care.

            `self-start` so the button sizes to its content: as a flex-column child
            it would otherwise stretch, and the ghost background is the button, so a
            stretched one paints a full-width bar on hover. Hit area and hover
            background are the same rectangle, so this does trade the full-width
            target for one that ends at the chevron.

            `-ml-3` cancels the size's `px-3` EXACTLY, which is what puts the label
            on the form's text edge — level with the labels above it and with the
            Input's border box. A ghost button aligns by its label, not by its box,
            so the background is meant to overhang: 12px into a container that gives
            16px either side (the sheet body's `px-4`, PopoverContent's `p-4`), so
            it stays inside both. Only the left is pulled — the right margin would
            move nothing on a `self-start`, content-sized box.

            The four `aria-expanded:` overrides cancel the ghost variant's
            `aria-expanded:bg-muted aria-expanded:text-foreground` (button.tsx) —
            BOTH halves of it, which is easy to half-do: cancelling only the fill
            leaves the label jumping to full contrast the moment the section opens,
            for the same reason the fill would have. That rule is for POPUP triggers —
            list-select and tags-field, where the trigger should stay lit while its
            popover is open, because the popup is a separate layer that needs tying
            back to what summoned it. This is an IN-PLACE disclosure: the revealed
            fields are their own feedback, so a persistent highlight just competes
            with the inputs it just uncovered. The `aria-expanded` ATTRIBUTE stays —
            it's the only thing announcing collapsed/expanded to a screen reader,
            and the repo's other in-place disclosures (sidebar.tsx's two) keep it
            while dodging this styling by not being a `Button` at all. The second
            override in each pair is not redundant: with the variant's rule merged
            away, a bare `hover:bg-muted` and `aria-expanded:bg-transparent` tie on
            specificity — one class plus one pseudo-class against one class plus one
            attribute selector, (0,2,0) either way — so which one won while expanded
            AND hovered would come down to Tailwind's variant emission order.
            Stacking the two variants is (0,3,0) and outranks both. The text pair
            has the identical tie and takes the identical fix, so hover lifts the
            label to full contrast whether the section is open or shut.

            The chevron sits WITH the label for the same reason it rotates with it.
            It keeps `data-icon="inline-end"` — which arms
            `has-data-[icon=inline-end]:pr-2` (button.tsx) — because `self-start`
            sizes the button to its content, so the glyph IS against the trailing
            padding edge and should get that edge's smaller padding: 12px before
            the label, 8px after the glyph. (The marker is only wrong for a
            STRETCHED button whose icon floats mid-row, which is what this was
            between dropping `justify-between` and adding `self-start`.)
            bracemark-expo derives the same trim from its children instead — see
            the port in link-add-screen.tsx.

            The DOT marks a collapsed section that holds something (optionalSet —
            which is also where the never-discard rule is written down). Without
            it, a picked list or a typed note would be applied by Save while
            nothing on screen said so; the advanced-search trigger answers the
            identical problem with the identical 6px dot (search-bar.tsx). It
            rides AFTER the chevron rather than between the chevron and the label,
            which stay adjacent for the reason above — so the dot is what sits
            against the trailing padding edge, and 8px suits a 6px dot better than
            the untrimmed 12px would.

            `bg-foreground/70` — the colour of the label it belongs to. Here the
            dot is a mark of punctuation on a labelled control, and an accent-
            coloured one outweighs the label it is modifying — the loudest thing
            in the form would be a 6px dot rather than Save. Matching the text
            keeps it a detail of the label. The advanced-search trigger carries
            the same token for the neighbouring reason: there the dot annotates a
            glyph rather than a label, and at full ink a filled 6px circle
            out-weighs a 1.5px stroke just as surely. One value, one rule — the
            dot never out-weighs its host. It tracks the ghost variant's
            `hover:text-foreground` for free, since that resolves to this token;
            `bg-current` would track it more literally, but there is no
            currentColor in React Native, and this dot ports verbatim to
            link-add-screen.tsx.

            `aria-label` is how the dot reaches a screen reader, since the dot
            itself is `aria-hidden` decoration. It carries the visible text first,
            so the accessible name and the label agree (the trigger above does the
            same), and `aria-expanded` appends the collapsed/expanded half. The
            suffix echoes field names the label has already said — "List, tags &
            note, list, tags set" — which is deliberate: the words in the label
            enumerate what is BEHIND the disclosure, and the suffix names which of
            them are FILLED, and there is no shorter way to say the second thing.
            It is a NAME, not a live region: it re-words as the user types in the
            note field, and text that re-words must never announce
            (docs/accessibility.md) — a changing name on an unfocused control is
            silent, and is read when the user next reaches it. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={openOptional}
          aria-label={
            !openOptional && optionalDirty
              ? `List, tags & note, ${optionalSet.join(', ')} set`
              : undefined
          }
          className={cn(
            '-ml-3 self-start font-normal text-foreground/70',
            'aria-expanded:bg-transparent aria-expanded:hover:bg-muted',
            'aria-expanded:text-foreground/70 aria-expanded:hover:text-foreground',
          )}
          onClick={() => setOpenOptional((v) => !v)}
        >
          List, tags & note
          <ChevronDown
            data-icon="inline-end"
            className={cn('size-4 transition-transform', openOptional && 'rotate-180')}
          />
          {!openOptional && optionalDirty && (
            <span aria-hidden className="size-1.5 rounded-full bg-foreground/70" />
          )}
        </Button>

        {openOptional && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="link-list" density="dense">
                List
              </Label>
              {/* No Trash target: it's the deletion staging area, never a place
                  to add new links (same rule as the default-list fallback).
                  Locked/hidden lists stay pickable — hiding only declutters the
                  sidebar, it never blocks filing into a list you know exists. */}
              <ListSelect
                id="link-list"
                value={listId}
                onValueChange={setListId}
                excludeIds={[TRASH_ID]}
                allowCreate
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="link-tag" density="dense">
                Tags
              </Label>
              <TagsField id="link-tag" value={tagIds} onChange={setTagIds} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="link-note" density="dense">
                Note
              </Label>
              <Textarea
                id="link-note"
                maxLength={LINK_NOTE_MAX}
                placeholder="Optional note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* Only on the trashed ground — the one already-saved case where the
              match is unreachable, so a second door is worth the width. Kept
              type="button" so it can't be the form's implicit submit: Enter in
              the URL field must stay Save/Confirm. */}
          {urlWarning === 'trashed' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => void onRestore()}
            >
              Restore
            </Button>
          )}
          <Button type="submit" variant="default" size="sm" disabled={saving}>
            {urlWarning !== null ? 'Confirm' : 'Save'}
          </Button>
        </div>
      </form>
    );

  if (!wide) {
    return (
      <Sheet open={open} onOpenChange={onGuardedOpenChange}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        {/* `rounded-t-2xl` to match the popover's corners — the same surface at
            a different width. `showCloseButton={false}` because the built-in one
            is a `SheetClose`, which routes through the guard above and would
            silently no-op on a dirty draft; ours calls the unguarded close, the
            way Cancel does. It's rendered AFTER the scroll container so the
            first tabbable element stays the URL field, which is also what
            `autoFocus` wants (sheet.tsx puts its own close last for the same
            reason). `aria-describedby={undefined}`: the form is the description,
            there's no paragraph to point at.

            The inline geometry is the keyboard lift (useSheetGeometry). The
            fallback `max-h` is for SSR and browsers without `visualViewport` —
            `dvh` at least accounts for browser chrome, which is the rest of the
            problem. */}
        <SheetContent
          side="bottom"
          showCloseButton={false}
          aria-describedby={undefined}
          className="max-h-[85dvh] rounded-t-2xl"
          style={sheetGeometry ?? undefined}
        >
          {/* Both paddings here are derived, not eyeballed.

              `pt-5` is what levels the title with the close button below. That
              button is `top-3` at `icon-sm` (size-8), so its centre sits at
              12 + 16 = 28px; the title is `text-base leading-none` (sheet.tsx), a
              16px box, so it needs to start at 20px to centre on the same line.
              The title moves rather than the button because `top-3 right-3` is
              where sheet.tsx puts its own close — ours stands in for it (see
              above), so it should sit where every other sheet's does.

              `pb-6` is the whole gap between the title and the form's first
              label: SheetContent sets no gap between its children and the
              scroll container below has no top padding. 6 because that's the
              `gap-6` DialogContent puts between its header and body — the edit
              dialog renders the same Label/Input stack, so the two forms open
              with the same air. */}
          <SheetHeader className="px-4 pt-5 pb-6">
            <SheetTitle>Add link</SheetTitle>
          </SheetHeader>
          {/* `min-h-0` so this can actually shrink inside the flex column —
              without it the form's intrinsic height wins and the sheet overflows
              its own max-height instead of scrolling. */}
          <div className="min-h-0 overflow-y-auto px-4 pb-4">{body}</div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            className="absolute top-3 right-3"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={onGuardedOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      {/* Never wider than the viewport it's anchored in — `w-80` is 20rem, which
          is a 320px phone edge to edge.

          Alignment follows the trigger's own position, since the two instances
          sit in opposite places: the topbar's button is in the bar's right
          corner, so `end` keeps the form inside the frame instead of jutting
          past it, while the empty pane's CTA is horizontally centred, where
          `end` would hang the whole form off to its left. */}
      <PopoverContent
        align={prominent ? 'center' : 'end'}
        className="w-[min(20rem,calc(100vw-2rem))]"
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}
