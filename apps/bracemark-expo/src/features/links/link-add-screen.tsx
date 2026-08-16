// Quick-add for links — the expo port of bracemark-web's LinkAddSurface
// (`(app)/links/_components/link-add-surface.tsx`, the canonical doc for the
// behavior: the two-tier validation — a HARD empty-URL error vs the SOFT
// malformed/duplicate/trashed warnings that relabel Save → Confirm; why the
// trashed ground alone offers Restore; why the quota banner REPLACES the form;
// the advancedDirty close guard). Web anchors that form to a popover only at
// `md` and up; below it the form fills a bottom sheet, for the same reason this
// screen exists — a phone-height surface with the keyboard up has no room to
// hang a form off a topbar corner. Here the surface is a modal-presented router
// screen summoned by the links screen's FAB (add-link-fab.tsx) — deliberately a
// ROUTER screen, not an RN `Modal` like AdvancedSearch:
//
//  - It stays in the root view tree, so keyboard-controller's
//    KeyboardAwareScrollView works (docs/safe-area.md — "decide the
//    presentation first; the keyboard answer follows"), and the ListSelect
//    Dialog portals layer normally on Android (no close-and-reopen dance).
//  - The close is guardable: usePreventRemove swallows the accidental close
//    vectors (iOS swipe-down, Android back) while the Advanced section holds
//    work — web's onOpenChange guard. Cancel/X/save set `closing`, which drops
//    the guard and pops in an effect, so a deliberate discard stays one tap.
//
// The draft is local component state (never the URL — the ephemeral-action
// rule from web's header): the screen unmounts on close, so every open starts
// fresh. The pre-selected list rides in as a route param (`listId`) because
// this screen sits outside links/_layout's LinksPageProvider — the FAB
// computes it from the selection at press time (web's useDefaultListId).

import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePreventRemove } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, ChevronUp, X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

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
import { LinkQuotaBanner } from '../../components/links/link-quota-banner';
import { ListSelect } from '../../components/links/list-select';
import { TagsField } from '../../components/links/tags-field';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';

const StyledSafeAreaView = withUniwind(SafeAreaView);
const StyledKeyboardAwareScrollView = withUniwind(KeyboardAwareScrollView);

// A labeled field row (web's Label + control pairs; the SearchBar WordField
// idiom).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}

export function LinkAddScreen() {
  const router = useRouter();
  const { listId: paramListId } = useLocalSearchParams<{ listId?: string }>();
  const { create, update } = useLinkMutations();
  const { extractNow } = useExtraction();
  const { count, max, atLimit } = useLinkQuota();

  // The FAB passes the viewing list; anything else (missing on a cold deep
  // link, or Trash — never a place to add) falls back to My List, the inbox.
  const defaultListId =
    typeof paramListId === 'string' && paramListId !== '' && paramListId !== TRASH_ID
      ? paramListId
      : DEFAULT_LIST_ID;

  const [openAdvanced, setOpenAdvanced] = useState(false);
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

  // Does closing now lose real work? A bare typed URL doesn't count — it's
  // cheap to retype, and the swipe-down-to-dismiss idiom is worth more than
  // guarding it. Only the Advanced fields represent effort worth protecting
  // (web's advancedDirty, verbatim).
  const advancedDirty = note.trim() !== '' || tagIds.length > 0 || listId !== defaultListId;

  // Guard only the ACCIDENTAL close vectors (swipe-down, Android back) while
  // the Advanced section holds work — swallowed silently, like web's
  // onOpenChange guard. `closing` is the deliberate door: setting it drops the
  // guard on this same commit (this hook's effect re-runs before the one
  // below) and the effect pops the screen.
  const [closing, setClosing] = useState(false);
  usePreventRemove(advancedDirty && !closing, () => {
    // Swallowed silently — web's guard eats the outside-click/Escape the same
    // way; the Cancel button is the deliberate discard door.
  });
  useEffect(() => {
    if (closing) router.back();
  }, [closing, router]);
  const close = () => setClosing(true);

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

  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      <View className="h-14 shrink-0 flex-row items-center justify-between border-b border-border pr-2 pl-4">
        <Text className="text-lg font-semibold">Add a link</Text>
        <Pressable
          role="button"
          onPress={close}
          aria-label="Close add link"
          className="size-10 items-center justify-center rounded-md"
        >
          <Icon as={X} className="size-5 text-muted-foreground" />
        </Pressable>
      </View>
      <StyledKeyboardAwareScrollView
        className="flex-1"
        contentContainerClassName="gap-4 p-4"
        keyboardShouldPersistTaps="handled"
        bottomOffset={16}
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
                  // Pop this modal BEFORE routing — the Subscription screen
                  // can't be pushed under it (the LockedBanner precedent).
                  router.back();
                  router.push('/settings/subscription');
                }}
              >
                <Text>Upgrade to {PLAN_LABELS.plus}</Text>
              </Button>
            }
          />
        ) : (
          <>
            <Field label="URL">
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
                autoCapitalize="none"
                autoCorrect={false}
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
            </Field>

            {/* Web's disclosure, ported (link-add-surface.tsx carries the full
                reasoning): quiet by WEIGHT rather than size or colour, so the
                label drops to normal weight at full contrast; the chevron sits
                WITH the word rather than pinned to the far edge of a mostly empty
                row; and `self-start` keeps the pressed background on the control
                instead of painting a bar the width of the form.

                A `Button variant="ghost" size="sm"` rather than the hand-rolled
                Pressable this used to be, so the numbers come from the same RULE
                as web's rather than being matched by hand: `px-3` (hence the same
                `-ml-3` to put "Advanced" on the Field labels' text edge), the
                trailing-icon padding trim derived from the children, and the icon
                colour inherited through TextClassContext the way web's inherits
                from the button. `h-9` on a phone, `h-8` from `sm:` — the size
                variant already draws that touch/pointer split, which is exactly
                the h-9-vs-web's-h-8 this hand-rolled one was reproducing. The
                press background is unchanged: ghost uses `accent`, and this theme
                defines `--color-accent` and `--color-muted` to the same value.

                `font-normal` on the label because buttonTextVariants' base is
                `text-sm font-medium` — the native analogue of overriding the web
                Button's own `font-medium`. Web additionally cancels an
                `aria-expanded:bg-muted`; nothing to do here, since `active:` is
                press-only and RN has no attribute-driven styling. The
                `aria-expanded` prop stays either way — it announces the state. */}
            <Button
              variant="ghost"
              size="sm"
              onPress={() => setOpenAdvanced((v) => !v)}
              aria-expanded={openAdvanced}
              aria-label="Advanced"
              className="-ml-3 self-start"
            >
              <Text className="font-normal">Advanced</Text>
              <Icon as={openAdvanced ? ChevronUp : ChevronDown} className="size-4" />
            </Button>

            {openAdvanced && (
              <View className="gap-4">
                {/* No Trash target: it's the deletion staging area, never a place
                    to add new links (same rule as the default-list fallback).
                    Locked/hidden lists stay pickable — hiding only declutters the
                    drawer, it never blocks filing into a list you know exists. */}
                <Field label="List">
                  <ListSelect
                    value={listId}
                    onValueChange={setListId}
                    excludeIds={[TRASH_ID]}
                    allowCreate
                  />
                </Field>

                <Field label="Tags">
                  <TagsField value={tagIds} onChange={setTagIds} />
                </Field>

                <Field label="Note">
                  <Input
                    value={note}
                    onChangeText={setNote}
                    maxLength={LINK_NOTE_MAX}
                    placeholder="Optional note"
                    aria-label="Note"
                    multiline
                    className="h-20 py-2"
                    // Android centers multiline text vertically by default.
                    style={{ textAlignVertical: 'top' }}
                  />
                </Field>
              </View>
            )}

            <View className="flex-row justify-end gap-2">
              <Button variant="ghost" size="sm" onPress={close}>
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
            </View>
          </>
        )}
      </StyledKeyboardAwareScrollView>
    </StyledSafeAreaView>
  );
}
