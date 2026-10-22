// The full link editor — the expo port of bracemark-web's LinkEditDialog
// (`(app)/links/_components/link-edit-dialog.tsx`, the canonical doc for the
// semantics: exactly the user-authored `links/{id}.enc` fields — custom title,
// custom image, list, tags, note; one Save = one writeLink, one LWW unit, pins
// deliberately elsewhere; the override-wins title/image model where CLEARING
// falls back to the extracted value; the minimal-patch Save; the dirty close
// guard). TWO SHELLS on the docking width (lib/window-class.ts), over one draft
// (`useLinkEditDraft`) and one set of fields: below it, a modal router screen
// the row menu (link-row-menu.tsx) pushes — not a hoisted page-level dialog,
// because a pushed screen isn't anchored to a row and its draft is a snapshot,
// and for the router-screen-over-RN-Modal reasons link-add-panel.tsx records
// (keyboard-controller, portals, guardable close); at and above it,
// LinkEditDialog (below), which IS hoisted — LinkEditHost, for web's reason —
// because an iPad's page sheet left the sticky footer off the keys.
//
// Divergences from web:
//
//  - The link arrives as a `linkId` param and is read ONCE (the draft is a
//    snapshot — web's `editing.link` is equally frozen at request time;
//    `update` re-reads before merging either way). A missing id (stale deep
//    link) pops the screen. The EXTRACTION read stays live, like web, so the
//    placeholder title / fallback image update mid-edit.
//  - `focus` ('tags' | 'note') SCROLLS the field into view instead of focusing
//    it: web's focus() is inert chrome, but focusing a native input summons
//    the keyboard — over the very note "Edit note" is most often opened to read.
//  - The image draft holds a picked file's URI, not bytes + object URLs —
//    content stays out of the JS heap on this platform (file-store.ts), so
//    pick (expo-image-picker) → resize (resizeImage, uri→uri) → store
//    (saveCustomImage → writeFile, path-to-path copy). The preview renders
//    the local plaintext uri (readFileUri) with core RN Image; a blob this
//    device hasn't materialized shows the empty hint, exactly like web's
//    local-bytes-only rule. Core RN Image DELIBERATELY, though link-media.tsx
//    is expo-image now: neither reason that bought it there applies to a single
//    mounted preview — nothing recycles this view, and a stored image is raster
//    by construction (the store path's sniff rejects SVG — expo-react
//    lib/image.ts).

import { useEffect, useRef, useState } from 'react';
import { Image, type LayoutChangeEvent, Pressable, type ScrollView, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePreventRemove } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ImageOff, ImagePlus, X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import {
  linkIdOf,
  type LinkItem,
  type LinkPatch,
  readExtraction,
  readFileUri,
  readLinkById,
  resizeImage,
  useLinkMutations,
  useLiveRead,
  warnIfNotSwept,
} from '@stxapps/expo-react';
import { hostFromText, LINK_NOTE_MAX, LINK_TITLE_MAX, TRASH_ID } from '@stxapps/shared';

import { LabeledField } from '../../components/links/labeled-field';
import { ListSelect } from '../../components/links/list-select';
import { TagsField } from '../../components/links/tags-field';
import { StickyFooter } from '../../components/sticky-footer';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { APP_PORTAL_HOST } from '../../components/ui/portal-host';
import { Text } from '../../components/ui/text';
import { Textarea } from '../../components/ui/textarea';
import { type FieldFocusHandler, useFocusedFieldReveal } from '../../lib/use-focused-field-reveal';

const StyledSafeAreaView = withUniwind(SafeAreaView);
const StyledKeyboardAwareScrollView = withUniwind(KeyboardAwareScrollView);
const StyledAnimatedScrollView = withUniwind(Animated.ScrollView);

type EditFocus = 'tags' | 'note';

// What the user has decided about the custom image this session: leave it
// alone, replace it with a picked file, or clear the override back to the
// extracted one — web's ImageDraft with a uri+dims where web holds
// bytes+objectURL (the dims let saveCustomImage's backstop resize retry a
// pick-time fallback, or pass a capped result through — see image.ts).
type ImageDraft =
  | { kind: 'keep' }
  | { kind: 'pick'; uri: string; width: number; height: number }
  | { kind: 'clear' };

// Order-sensitive equality is fine here: the draft starts FROM link.tagIds, so
// any reordering means the user removed and re-added — a real edit either way.
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export function LinkEditScreen() {
  const router = useRouter();
  const { linkId, focus: rawFocus } = useLocalSearchParams<{ linkId?: string; focus?: string }>();
  const focus: EditFocus | undefined =
    rawFocus === 'tags' || rawFocus === 'note' ? rawFocus : undefined;

  // One-shot load (see the header): undefined = loading, null = missing.
  const [link, setLink] = useState<LinkItem | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    if (typeof linkId !== 'string' || linkId === '') {
      setLink(null);
      return;
    }
    void readLinkById(linkId).then((loaded) => {
      if (alive) setLink(loaded ?? null);
    });
    return () => {
      alive = false;
    };
  }, [linkId]);
  useEffect(() => {
    if (link === null) router.back();
  }, [link, router]);

  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      {link ? (
        <LinkEditForm key={link.path} link={link} focus={focus} />
      ) : (
        // The load is a single indexed read — this frame is rarely visible.
        // Keep the chrome so the modal doesn't flash empty-to-full.
        <View className="h-14 shrink-0 border-b border-border" />
      )}
    </StyledSafeAreaView>
  );
}

// The editor's draft and its one Save — everything both shells share (the route
// below the docking width, the Dialog at and above it; LinkEditDialog carries
// why there are two). Mounted per open, so the draft is a snapshot of `link`.
// `onDone` is how the shell closes once a Save lands.
function useLinkEditDraft(link: LinkItem, onDone: () => void) {
  const { update, saveCustomImage, deleteCustomImage } = useLinkMutations();

  // The extraction supplies the fallbacks the overrides sit above: the
  // placeholder title and the image shown after "Reset to extracted". Live, so
  // a backfill landing mid-edit updates them.
  const id = linkIdOf(link);
  const extraction = useLiveRead(() => readExtraction(id), [id], ['items']);
  const extractedTitle = extraction?.title;

  // Draft state, snapshotted from the link at mount (this component mounts per
  // open — see LinkEditScreen's key). Title/note hold the OVERRIDE/typed
  // value, not the resolved display value: blank title = "no override".
  const [title, setTitle] = useState(link.customTitle ?? '');
  const [listId, setListId] = useState(link.listId);
  const [tagIds, setTagIds] = useState<string[]>(link.tagIds);
  const [note, setNote] = useState(link.note ?? '');
  const [image, setImage] = useState<ImageDraft>({ kind: 'keep' });
  const [saving, setSaving] = useState(false);

  // The stored image the preview shows when no fresh pick is pending: the
  // override-wins resolution, except 'clear' previews the post-clear fallback
  // (the extracted image, or nothing). Local plaintext only (readFileUri) — a
  // blob this device hasn't materialized just shows the empty hint.
  const storedImageId =
    image.kind === 'clear' ? extraction?.imageId : (link.customImageId ?? extraction?.imageId);
  const storedUri = useLiveRead(
    () => (storedImageId ? readFileUri(storedImageId) : Promise.resolve(undefined)),
    [storedImageId],
    ['items'],
  );
  const previewUri = image.kind === 'pick' ? image.uri : storedUri;

  const onPickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
    if (result.canceled) return;
    const asset = result.assets[0];
    warnIfNotSwept(asset.uri, 'expo-image-picker');
    // Cap dimensions at pick time (the client-thumbnailing step — see
    // image.ts / docs/editors.md) so the preview shows exactly what will
    // be stored. resizeImage passes a within-cap image through and never
    // throws, so a pick can't be rejected. saveCustomImage resizes again on
    // Save — a no-op on this already-capped uri, kept as the backstop.
    const capped = await resizeImage({ uri: asset.uri, width: asset.width, height: asset.height });
    setImage({ kind: 'pick', ...capped });
  };

  // Does closing now lose anything? Mirrors the field-by-field comparison
  // onSubmit uses to build its patch, so "dirty" means exactly "Save would
  // write something". Image dirt tracks the patch rule too: a fresh pick always
  // counts, but clearing when there was no override is a no-op, not a change.
  const imageDirty =
    image.kind === 'pick' || (image.kind === 'clear' && Boolean(link.customImageId));
  const isDirty =
    title.trim() !== (link.customTitle ?? '') ||
    listId !== link.listId ||
    !sameIds(tagIds, link.tagIds) ||
    note.trim() !== (link.note ?? '') ||
    imageDirty;

  const onSubmit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Minimal patch: only what actually changed, so an untouched Save is a
      // no-op (no write, no updatedAt bump reordering the date-modified sort).
      // A cleared field is an EXPLICIT undefined — writeLink drops the key, the
      // display falls back (the trivial-revert property).
      const patch: LinkPatch = {};
      const trimmedTitle = title.trim();
      if (trimmedTitle !== (link.customTitle ?? '')) {
        patch.customTitle = trimmedTitle === '' ? undefined : trimmedTitle;
      }
      if (listId !== link.listId) patch.listId = listId;
      if (!sameIds(tagIds, link.tagIds)) patch.tagIds = tagIds;
      const trimmedNote = note.trim();
      if (trimmedNote !== (link.note ?? '')) {
        patch.note = trimmedNote === '' ? undefined : trimmedNote;
      }

      // Content-before-metadata: the new `files/` blob lands before the link
      // references it; the replaced blob is dropped only after the reference
      // moved off it.
      const replacedImageId = link.customImageId;
      if (image.kind === 'pick') {
        patch.customImageId = await saveCustomImage(image);
      } else if (image.kind === 'clear' && replacedImageId) {
        patch.customImageId = undefined;
      }

      if (Object.keys(patch).length > 0) {
        await update(link, patch);
        if (image.kind !== 'keep' && replacedImageId) {
          await deleteCustomImage(replacedImageId);
        }
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return {
    extractedTitle,
    title,
    setTitle,
    listId,
    setListId,
    tagIds,
    setTagIds,
    note,
    setNote,
    image,
    setImage,
    previewUri,
    onPickImage,
    isDirty,
    saving,
    onSubmit,
  };
}
type LinkEditDraft = ReturnType<typeof useLinkEditDraft>;

// The form's fields, in both shells. `onFocusFieldLayout` lands the `focus`
// param's field (the shell owns the scroller); `onFieldFocus` is the Dialog
// shell's reveal (lib/use-focused-field-reveal.ts) — the route's aware scroller
// tracks focus itself.
function LinkEditFields({
  link,
  draft,
  focus,
  onFocusFieldLayout,
  onFieldFocus,
}: {
  link: LinkItem;
  draft: LinkEditDraft;
  focus?: EditFocus;
  onFocusFieldLayout: (e: LayoutChangeEvent) => void;
  onFieldFocus?: FieldFocusHandler;
}) {
  const {
    extractedTitle,
    title,
    setTitle,
    listId,
    setListId,
    tagIds,
    setTagIds,
    note,
    setNote,
    image,
    setImage,
    previewUri,
    onPickImage,
  } = draft;
  return (
    <>
      <LabeledField label="Title">
        {/* The field ids here are the add panel's, for its reason: every
            control's accessible name repeats its LabeledField label
            (docs/e2e.md, _the testID contract_). */}
        <Input
          testID="edit-link-title"
          autoCapitalize="sentences"
          autoCorrect
          spellCheck
          smartInsertDelete
          value={title}
          onChangeText={setTitle}
          onFocus={onFieldFocus}
          maxLength={LINK_TITLE_MAX}
          placeholder={extractedTitle ?? hostFromText(link.url)}
          aria-label="Title"
        />
        {/* The placeholder isn't selectable, so someone who wants to tweak
            just part of the extracted title has no seed to edit. Offer one
            ONLY while the field is blank (no override yet) and a real
            extracted title exists — web's "Edit it instead", verbatim. */}
        <View className="flex-row items-baseline justify-between gap-2">
          <Text className="min-w-0 flex-1 text-xs text-muted-foreground">
            Leave blank to use the page’s own title.
          </Text>
          {title.trim() === '' && extractedTitle && (
            <Pressable role="button" onPress={() => setTitle(extractedTitle)} className="shrink-0">
              <Text className="text-xs text-primary">Edit it instead</Text>
            </Pressable>
          )}
        </View>
      </LabeledField>

      {/* No Trash target: trashing is the menu's Remove, never a "move".
          Locked/hidden lists stay pickable — hiding only declutters the
          drawer, it never blocks filing into a list you know exists. */}
      <LabeledField label="List">
        <ListSelect
          testID="edit-link-list"
          value={listId}
          onValueChange={setListId}
          excludeIds={[TRASH_ID]}
          allowCreate
        />
      </LabeledField>

      <LabeledField label="Tags" onLayout={focus === 'tags' ? onFocusFieldLayout : undefined}>
        <TagsField testID="edit-link-tags" value={tagIds} onChange={setTagIds} />
      </LabeledField>

      {/* The row menu's "Edit note" lands here (focus === 'note'): the note
          has no read-only surface — the layouts are fixed-height, so a row
          can only badge it — and at LINK_NOTE_MAX this input reads as well as
          any viewer would, with the edit already in hand. */}
      <LabeledField label="Note" onLayout={focus === 'note' ? onFocusFieldLayout : undefined}>
        <Textarea
          testID="edit-link-note"
          value={note}
          onChangeText={setNote}
          onFocus={onFieldFocus}
          maxLength={LINK_NOTE_MAX}
          placeholder="Optional note"
          aria-label="Note"
        />
      </LabeledField>

      <LabeledField label="Image">
        {/* The card banner's shape (`aspect-12/7` — link-card.tsx), web's
            slot verbatim; the dialog carries the argument for why the preview
            owes the user the CARD's crop, why the field is LAST and full width
            (title → list → tags → note → image, the create surfaces' three
            fields book-ended rather than split — docs/editors.md), why the
            buttons stay BELOW at the same left edge, and why the slot holds
            its size with no image (the buttons would otherwise move under the
            finger — up on "Reset to extracted", down when a live `storedUri`
            materializes mid-edit). `h-40 w-full` before it was a harder crop
            than either surface (358×160 ≈ 2.24:1 on a 390pt phone), so the
            preview cut off more than the card would. As a class, not
            link-card's computed dp height: that number exists so FlashList
            measures a cell right on its first frame, and nothing measures this
            screen.

            Being last also retired this screen's own reason for the fixed
            slot: `focus` scrolls to its field's `layout.y` ONCE, off that
            field's first layout, so while the image sat above Note an image
            resolving afterwards grew the field and left "Edit note" scrolled
            short. Nothing this field does can move Tags or Note now. */}
        {previewUri ? (
          <Image
            source={{ uri: previewUri }}
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            className="aspect-12/7 w-full rounded-md border border-border"
          />
        ) : (
          <View className="aspect-12/7 w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/40 px-3">
            <Text className="text-center text-xs text-muted-foreground">
              No image — cards show a colored panel.
            </Text>
          </View>
        )}
        {/* `flex-wrap`, web's fix for web's reason — neither button can give
            (Button is `shrink-0`) — but what triggers it here is the text
            size rather than the screen: the pair is 316pt at 1×, which fits
            the 328 a 360pt screen leaves inside `p-4`, and 377 at the 1.3
            ceiling (docs/accessibility.md, _font scaling_), which fits
            nothing narrower than 409. And native has no scrollbar to give the
            overflow away: the row just runs past the padding and "Reset to
            extracted" is cut off at the screen's edge. Wrapped, the two
            leading icons sit behind the same `pl-2.5` and share an edge. */}
        <View className="flex-row flex-wrap gap-1.5">
          <Button variant="outline" size="sm" onPress={() => void onPickImage()}>
            <Icon as={ImagePlus} className="size-4" />
            <Text>Choose image</Text>
          </Button>
          {(image.kind === 'pick' || (image.kind === 'keep' && link.customImageId)) && (
            <Button variant="ghost" size="sm" onPress={() => setImage({ kind: 'clear' })}>
              <Icon as={ImageOff} className="size-4" />
              <Text>Reset to extracted</Text>
            </Button>
          )}
        </View>
      </LabeledField>
    </>
  );
}

function LinkEditActions({ draft, onCancel }: { draft: LinkEditDraft; onCancel: () => void }) {
  return (
    <>
      <Button variant="ghost" size="sm" testID="edit-link-cancel" onPress={onCancel}>
        <Text>Cancel</Text>
      </Button>
      <Button
        size="sm"
        testID="edit-link-save"
        disabled={draft.saving}
        onPress={() => void draft.onSubmit()}
      >
        <Text>{draft.saving ? 'Saving…' : 'Save'}</Text>
      </Button>
    </>
  );
}

function LinkEditForm({ link, focus }: { link: LinkItem; focus?: EditFocus }) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const close = () => setClosing(true);
  const draft = useLinkEditDraft(link, close);
  const { isDirty } = draft;

  // Guard only the ACCIDENTAL close vectors (swipe-down, Android back) while
  // dirty — the add screen's guard, same wiring: `closing` is the deliberate
  // door (Cancel/X/save), dropping the guard before the effect pops.
  usePreventRemove(isDirty && !closing, () => {
    // Swallowed silently — web's guard eats the backdrop-click/Escape the same
    // way; the Cancel button is the deliberate discard door.
  });
  useEffect(() => {
    if (closing) router.back();
  }, [closing, router]);

  // `focus` scrolls its field into view once, off that field's first layout
  // (fields are direct children of the scroll content, so layout.y is
  // content-relative). No programmatic focus — see the header.
  const scrollRef = useRef<ScrollView>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  const scrolledToFocus = useRef(false);
  const onFocusFieldLayout = (e: LayoutChangeEvent) => {
    if (scrolledToFocus.current) return;
    scrolledToFocus.current = true;
    scrollRef.current?.scrollTo({ y: e.nativeEvent.layout.y, animated: false });
  };

  return (
    <>
      {/* The system owns this modal's outer shape: a rounded page sheet on iOS
          and a full-screen slide-up on Android. SafeAreaView clears hardware,
          but the iOS sheet reports almost no top inset and its arc still needs
          optical clearance, so only that presentation gets the roomier top.

          `ios:pt-4` rather than search-bar.tsx's `ios:pt-2.5` because the two
          headers are anchored on the TITLE'S CAPS and their rows are set by
          different things: this row IS the 44pt title/URL stack (a 28pt
          `text-lg` line box over a 16pt `text-xs` one), so the padding is the
          whole gap, while the Advanced Search row is its 40pt close button with
          the title floating 6pt clear inside it. Inter puts the caps 7.4pt below
          the line box's top (docs/theme.md, _extending_), so 16 + 7.4 lands this
          title 23.4pt under the sheet's edge — the same place `ios:pt-2.5` lands
          that one. The `ios:pt-5` both carried before had them 6pt apart.

          `pb-2.5` is NOT forked, and no bottom padding here should be: the only
          iOS-specific thing about these headers is the arc at the top. The 10pt
          answers this header's own content — a muted subtitle sits closer to the
          border than a floating single title does, which is why Advanced Search
          keeps `pb-2` — and it answers it on both platforms. These two headers
          are the app's only `ios:` variants; keep it that way.

          `pr-1.5` plus the button's own 10pt glyph margin puts the ✕ on the same
          16pt optical edge as the title's `pl-4`, matching both topbars
          (features/links/topbar.tsx). */}
      <View className="shrink-0 flex-row items-center justify-between gap-2 border-b border-border pt-2 pr-1.5 pb-2.5 pl-4 ios:pt-4">
        <View className="min-w-0 flex-1">
          <Text className="text-lg font-semibold">Edit link</Text>
          <Text numberOfLines={1} className="text-xs text-muted-foreground">
            {link.url}
          </Text>
        </View>
        {/* `text-foreground`, not the muted step this wore: a close on a
            bar-shaped header is nav chrome, and both topbars argue the case
            against dimming it (features/links/topbar.tsx — the inactive state
            ends up reading as disabled). The muted rung belongs to the floating
            tier, where ui/dialog.tsx and the add panel put theirs. Advanced
            Search already said `text-foreground` for the identical control, so
            the two sibling headers were giving two answers.

            54x48 effective: the box stays 40 and `hitSlop` makes up the
            difference (docs/accessibility.md, _a 36dp box is not a 44pt
            target_). `right: 6` runs out to the row's `pr-1.5` frame edge; the
            left 8 is free because the neighbour is a Text stack, which takes no
            touches. */}
        <Button
          variant="ghost"
          size="icon"
          onPress={close}
          aria-label="Close edit link"
          hitSlop={{ top: 4, bottom: 4, left: 8, right: 6 }}
          className="shrink-0"
        >
          <Icon as={X} className="size-5 text-foreground" />
        </Button>
      </View>
      {/* `bottomOffset` adds the pinned footer's height to the usual 16: once
          the footer lifts onto the keyboard it covers that band, so a focused
          field has to clear it too (components/sticky-footer.tsx).

          `w-full max-w-2xl self-center` caps the form at the settings pane's
          column for an Android tablet, where this modal is the whole window
          and the `aspect-12/7 w-full` preview would otherwise grow to most of
          the screen's height. Advanced Search carries the same cap. */}
      <StyledKeyboardAwareScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName="w-full max-w-2xl gap-4 self-center p-4"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        bottomOffset={16 + footerHeight}
      >
        <LinkEditFields
          link={link}
          draft={draft}
          focus={focus}
          onFocusFieldLayout={onFocusFieldLayout}
        />
      </StyledKeyboardAwareScrollView>
      <StickyFooter onHeight={setFooterHeight}>
        <LinkEditActions draft={draft} onCancel={close} />
      </StickyFooter>
    </>
  );
}

// The link to edit and the field to land on — what the row menu hands the wide
// editor, as the route's two params are for the narrow one.
export type LinkEditTarget = { linkId: string; focus?: EditFocus };

// The editor on a WIDE window: the kit's Dialog, a centred card at the add
// card's and Advanced Search's `max-w-lg`. It was the `/edit-link` route at
// every width, and a presented route is an iOS page sheet: on an iPad that is
// 820pt wide upright and 936 on its side, and it floats above the screen's
// bottom edge, so the sticky footer's lift (`keyboardHeight − insets.bottom`,
// right only for a bar resting on that edge) left Cancel/Save hanging over a
// gap above the keys. Nothing inside the sheet can measure where it floats
// (docs/soft-keyboard.md, _the sticky footer_, has the four dead ends), so the
// wide editor leaves the sheet rather than correcting it. In the Dialog every
// number is the window's: the kit's avoider centres the card in what the
// keyboard leaves, the footer is the card's last row, and the dim covers the
// docked rail. Below the docking width the route is unchanged
// (LinkEditScreen, above).
//
// It portals to APP_PORTAL_HOST, not the root host: the form needs the signed-in
// providers (`useLinkMutations` reads `useSync()`), and the root host is above
// them (components/ui/portal-host.tsx). It is opened through LinkEditHost
// (link-edit-host.tsx), hoisted for web's reason — the row that asked for it is
// virtualized and may repaint or recycle under an open editor.
//
// The close guard is the route's, mapped onto the Dialog: the ACCIDENTAL
// vectors — the backdrop, Android's back (both arrive as `onOpenChange(false)`)
// — are swallowed while dirty, and the ✕ (DialogContent's `onClose`) and
// Cancel stay the deliberate doors, as `usePreventRemove` and `closing` split
// them on the route.
export function LinkEditDialog({
  target,
  onClose,
}: {
  target: LinkEditTarget | null;
  onClose: () => void;
}) {
  // One-shot load per target, the route's rule: undefined = loading, null =
  // missing (a link deleted since its menu opened), which closes.
  const [link, setLink] = useState<LinkItem | null | undefined>(undefined);
  const linkId = target?.linkId;
  useEffect(() => {
    let alive = true;
    setLink(undefined);
    if (linkId === undefined) return;
    void readLinkById(linkId).then((loaded) => {
      if (alive) setLink(loaded ?? null);
    });
    return () => {
      alive = false;
    };
  }, [linkId]);
  useEffect(() => {
    if (link === null) onClose();
  }, [link, onClose]);

  if (!target || !link) return null;
  return <LinkEditDialogBody key={link.path} link={link} focus={target.focus} onClose={onClose} />;
}

function LinkEditDialogBody({
  link,
  focus,
  onClose,
}: {
  link: LinkItem;
  focus?: EditFocus;
  onClose: () => void;
}) {
  const draft = useLinkEditDraft(link, onClose);
  const reveal = useFocusedFieldReveal();
  // The route's `focus` landing, against this shell's scroller: the fields sit
  // in the reveal's content View, which starts at the top of the content, so a
  // field's `layout.y` is still content-relative.
  const scrolledToFocus = useRef(false);
  const onFocusFieldLayout = (e: LayoutChangeEvent) => {
    if (scrolledToFocus.current) return;
    scrolledToFocus.current = true;
    reveal.scrollRef.current?.scrollTo({ y: e.nativeEvent.layout.y, animated: false });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !draft.isDirty) onClose();
      }}
    >
      <DialogContent portalHost={APP_PORTAL_HOST} onClose={onClose} className="max-w-lg">
        {/* `pr-8` keeps the URL line clear of the corner ✕, which is absolute. */}
        <DialogHeader className="pr-8">
          <DialogTitle>Edit link</DialogTitle>
          <DialogDescription numberOfLines={1}>{link.url}</DialogDescription>
        </DialogHeader>
        {/* Advanced Search's wide body, for its reasons: `shrink grow-0` under
            the kit's `max-h-full` (docs/soft-keyboard.md, _the traps_), and
            `handled` + `interactive`, so a tap on a control lands and an upward
            drag scrolls a lower field clear without dropping the keyboard and
            re-centring the card. */}
        <StyledAnimatedScrollView
          ref={reveal.scrollRef}
          onScroll={reveal.onScroll}
          scrollEventThrottle={16}
          className="shrink grow-0"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <View ref={reveal.content} className="gap-4">
            <LinkEditFields
              link={link}
              draft={draft}
              focus={focus}
              onFocusFieldLayout={onFocusFieldLayout}
              onFieldFocus={reveal.onFieldFocus}
            />
          </View>
        </StyledAnimatedScrollView>
        <DialogFooter>
          <LinkEditActions draft={draft} onCancel={onClose} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
