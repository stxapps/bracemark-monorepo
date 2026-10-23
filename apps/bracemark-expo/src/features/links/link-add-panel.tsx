// Quick-add for links — the expo port of bracemark-web's LinkAddSurface
// (`(app)/links/_components/link-add-surface.tsx`, the canonical doc for the
// behavior: the two-tier validation — a HARD empty-URL error vs the SOFT
// malformed/duplicate/trashed warnings that relabel Save → Confirm; why the
// trashed ground alone offers Restore; why the quota banner REPLACES the form;
// the optionalDirty close guard). Web anchors that form to a popover only at
// `md` and up, and fills a bottom sheet below it. This file draws the same
// split on the same width (lib/window-class.ts): the bottom sheet on a narrow
// window, and on a wide one a CENTRED CARD rather than an anchored popover —
// the summoning control is a FAB, which is no anchor, and a surface with the
// keyboard up has no room to hang a form off a corner. Why the wide window
// needs a different shape at all is in the panel's JSX, below.
//
// THE SHELL IS ui/sheet.tsx's, shared with the link editor and Advanced
// Search: the bottom sheet, the card, the backdrop, the avoider, Android's back
// and the focused-field reveal all live there, with the reasons. What is left
// here is the form. LinkAddHost (link-add-host.tsx) mounts this only while its
// `adding` state is true, so a fresh mount is a fresh draft (the
// ephemeral-action rule from web's header: the draft is component state, never
// the URL). It reads the viewing list itself (web's useDefaultListId), because
// the sheet renders inside LinksPageProvider.
//
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronDown, ChevronUp } from 'lucide-react-native';

import {
  type LinkItem,
  readLinkByUrlKey,
  useExtraction,
  useLinkMutations,
  useLinkQuota,
} from '@stxapps/expo-react';
import {
  DEFAULT_LIST_ID,
  LINK_NOTE_MAX,
  normalizeUrl,
  PLAN_LABELS,
  TRASH_ID,
} from '@stxapps/shared';

import { ErrorText } from '../../components/error-text';
import { LabeledField } from '../../components/links/labeled-field';
import { LinkQuotaBanner } from '../../components/links/link-quota-banner';
import { ListSelect } from '../../components/links/list-select';
import { TagsField } from '../../components/links/tags-field';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Sheet } from '../../components/ui/sheet';
import { Text } from '../../components/ui/text';
import { Textarea } from '../../components/ui/textarea';
import { noteReviewMoment } from '../../lib/review-prompt';
import { useFocusedFieldReveal } from '../../lib/use-focused-field-reveal';
import { useLinksPage } from './page-provider';

export function LinkAddPanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const reveal = useFocusedFieldReveal();
  const { selection } = useLinksPage();
  const { create, update } = useLinkMutations();
  const { extractNow } = useExtraction();
  const { count, max, atLimit } = useLinkQuota();

  // Web's useDefaultListId, computed here rather than by the FAB now that this
  // sits inside LinksPageProvider: the list the user is viewing, so "add" lands
  // where they are looking — falling back to My List, the inbox, for the All
  // view or a tag view (neither names a single destination list) and for Trash,
  // which is the deletion staging area and never a place to add.
  const defaultListId =
    selection.kind === 'list' && selection.id !== TRASH_ID ? selection.id : DEFAULT_LIST_ID;

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

  // Which of the three OPTIONAL fields hold something — URL is the required one
  // (web's optionalSet, verbatim — its
  // comment is canonical: COLLAPSING THE SECTION DOES NOT DISCARD THEM, Save uses
  // these values either way, and the dot on the trigger is what keeps the hidden
  // state visible).
  const optionalSet = [
    listId !== defaultListId ? 'list' : null,
    tagIds.length > 0 ? 'tags' : null,
    note.trim() !== '' ? 'note' : null,
  ].filter((field) => field !== null);

  // Does closing now lose real work? A bare typed URL doesn't count — it's
  // cheap to retype, and the swipe-down-to-dismiss idiom is worth more than
  // guarding it. Only the optional fields represent effort worth protecting
  // (web's optionalDirty, verbatim).
  const optionalDirty = optionalSet.length > 0;

  // The close guard: while the optional section holds work, the ACCIDENTAL
  // vectors — the backdrop and Android's back, which the sheet routes here — are
  // swallowed silently. Web's onOpenChange guard eats its outside-click the same
  // way, and ✕ / Cancel stay the deliberate discard doors.
  const dismiss = () => {
    if (!optionalDirty) onClose();
  };

  const close = onClose;

  const onSubmit = async () => {
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

      const created = await create({
        url: normalized ?? trimmed,
        listId,
        tagIds,
        note: note.trim() || undefined,
      });
      // The GESTURED extraction (docs/link-extraction.md — _the stance_): fetch
      // the page the user just handed us, right now, without waiting for the
      // drain and without needing the extraction mode to reach `all` — the save
      // IS the consent, exactly as the browser extension's active-tab capture
      // is. Mode `off` still stops it (extractNow checks); that position exists
      // precisely to decline this.
      // Fire-and-forget: the title/image land in `extractions/` and the row
      // repaints itself, so nothing here waits on the network.
      if (created) extractNow([created.path]);
      close();
      // A save that landed is the moment the app-store review prompt uses; it
      // decides for itself whether this one asks (lib/review-prompt.ts).
      if (created) noteReviewMoment();
    } finally {
      setSaving(false);
    }
  };

  // Restore the trashed match instead of minting a second copy — web's
  // onRestore, verbatim (that comment is canonical: the draft is the request
  // the user just made, so it wins over the old record's fields; tags UNION).
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
      close();
    } finally {
      setSaving(false);
    }
  };

  const quotaReached = atLimit && max !== null;

  return (
    <Sheet
      title="Add link"
      closeLabel="Close add link"
      onClose={close}
      onDismiss={dismiss}
      reveal={reveal}
      // The URL field autofocuses, so the sheet must not drop the keyboard on
      // the way in (ui/sheet.tsx).
      takesFocus
      // No footer while the quota banner replaces the form: its own action is
      // the only door, and the sheet gives the body its end padding back.
      footer={
        quotaReached ? undefined : (
          <>
            <Button variant="ghost" size="sm" testID="add-link-cancel" onPress={close}>
              <Text>Cancel</Text>
            </Button>
            {/* Only on the trashed ground — the one already-saved case where the
            match is unreachable, so a second door is worth the width. */}
            {urlWarning === 'trashed' && (
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onPress={() => void onRestore()}
              >
                <Text>Restore</Text>
              </Button>
            )}
            {/* `add-link-save` rides the button, not its label: the label flips
            Save → Confirm on a warning, so it is the one control on this
            screen a Maestro flow could not have bound to by text even if
            the rule allowed it (docs/e2e.md, _the testID contract_). */}
            <Button
              testID="add-link-save"
              size="sm"
              disabled={saving}
              onPress={() => void onSubmit()}
            >
              <Text>{urlWarning !== null ? 'Confirm' : 'Save'}</Text>
            </Button>
          </>
        )
      }
    >
      {atLimit && max !== null ? (
        <LinkQuotaBanner
          count={count}
          max={max}
          action={
            <Button
              size="sm"
              className="self-end"
              onPress={() => {
                // Close BEFORE routing — the Subscription screen must not be
                // pushed under an open panel (the LockedBanner precedent; as a
                // route this said `router.back()`, and it means the same thing
                // now that closing is a state flip rather than a pop).
                close();
                router.push('/settings/subscription');
              }}
            >
              <Text>Upgrade to {PLAN_LABELS.plus}</Text>
            </Button>
          }
        />
      ) : (
        <>
          <LabeledField label="URL">
            <Input
              testID="add-link-url"
              value={url}
              onChangeText={(v) => {
                setUrl(v);
                // Editing re-opens the question: clear the error and disarm the
                // warning so the button reverts to Save and re-validates.
                setUrlError(null);
                setUrlWarning(null);
                setTrashedMatch(null);
              }}
              onSubmitEditing={() => void onSubmit()}
              placeholder="https://example.com"
              aria-label="URL"
              aria-invalid={urlError !== null}
              autoFocus
              inputMode="url"
              onFocus={reveal.onFieldFocus}
              onBlur={reveal.onFieldBlur}
            />
            {urlError !== null ? (
              <ErrorText className="text-xs">{urlError}</ErrorText>
            ) : urlWarning !== null ? (
              <ErrorText tone="warning" className="text-xs">
                {urlWarning === 'malformed'
                  ? 'This doesn’t look like a valid URL. Tap Confirm to save it anyway.'
                  : urlWarning === 'trashed'
                    ? 'This link is in your Trash. Restore it, or tap Confirm to save a new copy.'
                    : 'You’ve already saved this link. Tap Confirm to save it again.'}
              </ErrorText>
            ) : null}
          </LabeledField>

          {/* Web's disclosure, ported (link-add-surface.tsx carries the full
        reasoning): quiet by WEIGHT rather than size or colour, so the
        label drops to normal weight at full contrast; the chevron sits
        WITH the label rather than pinned to the far edge of a mostly empty
        row; and `self-start` keeps the pressed background on the control
        instead of painting a bar the width of the form.

        A `Button variant="ghost" size="sm"` rather than the hand-rolled
        Pressable this used to be, so the numbers come from the same RULE
        as web's rather than being matched by hand: `px-3` (hence the same
        `-ml-3` to put the label on the LabeledField labels' text edge),
        the trailing-icon padding trim derived from the children, and the
        icon colour inherited through TextClassContext the way web's
        inherits from the button. `h-9` — the size variant is already the
        touch step above web's `h-8`, which is exactly the h-9-vs-web's-h-8
        this hand-rolled one was reproducing. The
        press background is unchanged: ghost uses `accent`, and this theme
        defines `--color-accent` and `--color-muted` to the same value.

        `font-normal` on the label because buttonTextVariants' base is
        `text-sm font-medium` — the native analogue of overriding the web
        Button's own `font-medium`. `text-foreground/80` is web's colour
        step (its comment carries the reasoning: between the Input's
        foreground and the LabeledField labels' `text-muted-foreground`,
        which the control must not wear). It is spelled TWICE, on the Text
        and on the Icon, because there is no currentColor here: the chevron
        takes its colour from TextClassContext, which the Button fixes at
        `text-foreground`, and a class on the Pressable cannot cascade into
        either child. Web sets it once on the button and both follow. Web additionally cancels both halves
        of its ghost variant's `aria-expanded:` lift (the fill AND the text
        jumping to full contrast); nothing to do here, since `active:` is
        press-only and RN has no attribute-driven styling, so the reduced
        colour above is simply what this button wears open or shut. The
        `aria-expanded` prop stays either way — it announces the state.

        The DOT is web's too, same `size-1.5 bg-foreground/70`, same place
        (after the chevron) and same job: a collapsed section that holds
        something still gets saved, so something on screen has to say so.
        `bg-foreground/70` rather than the advanced-search trigger's
        `bg-primary` because this one sits beside a label — web's comment
        carries that reasoning, and the token is what lets the two clients
        spell the dot identically. `aria-label` is how it reaches a screen
        reader — a NAME carrying the visible text first, never a live
        region, since it re-words as the note is typed
        (docs/accessibility.md).

        The label is web's too, and is NAMED FOR ITS CONTENTS rather than
        "Advanced": nothing behind it is advanced, and "More options" is
        already the links screen's overflow button. Web's header carries
        that reasoning; docs/brand-assets.md is the record for user-facing
        wording. */}
          <Button
            variant="ghost"
            size="sm"
            testID="add-link-optional"
            onPress={() => setOpenOptional((v) => !v)}
            aria-expanded={openOptional}
            aria-label={
              !openOptional && optionalDirty
                ? `List, tags & note, ${optionalSet.join(', ')} set`
                : 'List, tags & note'
            }
            className="-ml-3 self-start"
          >
            <Text className="font-normal text-foreground/80">List, tags & note</Text>
            <Icon
              as={openOptional ? ChevronUp : ChevronDown}
              className="size-4 text-foreground/80"
            />
            {!openOptional && optionalDirty && (
              <View aria-hidden className="size-1.5 rounded-full bg-foreground/70" />
            )}
          </Button>

          {openOptional && (
            <View className="gap-4">
              {/* No Trash target: it's the deletion staging area, never a place
            to add new links (same rule as the default-list fallback).
            Locked/hidden lists stay pickable — hiding only declutters the
            drawer, it never blocks filing into a list you know exists. */}
              {/* The three field ids exist because each control's
                accessible name is also its LabeledField label's text
                (docs/e2e.md, _the testID contract_). */}
              <LabeledField label="List">
                <ListSelect
                  testID="add-link-list"
                  value={listId}
                  onValueChange={setListId}
                  excludeIds={[TRASH_ID]}
                  allowCreate
                />
              </LabeledField>

              <LabeledField label="Tags">
                <TagsField testID="add-link-tags" value={tagIds} onChange={setTagIds} />
              </LabeledField>

              <LabeledField label="Note">
                <Textarea
                  testID="add-link-note"
                  value={note}
                  onChangeText={setNote}
                  onFocus={reveal.onFieldFocus}
                  onBlur={reveal.onFieldBlur}
                  maxLength={LINK_NOTE_MAX}
                  placeholder="Optional note"
                  aria-label="Note"
                />
              </LabeledField>
            </View>
          )}
        </>
      )}
    </Sheet>
  );
}
