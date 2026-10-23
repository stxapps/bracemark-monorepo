// The full link editor — the expo port of bracemark-web's LinkEditDialog
// (`(app)/links/_components/link-edit-dialog.tsx`, the canonical doc for the
// semantics: exactly the user-authored `links/{id}.enc` fields — custom title,
// custom image, list, tags, note; one Save = one writeLink, one LWW unit, pins
// deliberately elsewhere; the override-wins title/image model where CLEARING
// falls back to the extracted value; the minimal-patch Save; the dirty close
// guard). It is the in-app sheet (components/ui/sheet.tsx) — a bottom
// sheet on a phone, a centred card from 768 — the same shell as the add panel
// and Advanced Search, opened from a row menu through LinkEditHost
// (link-edit-host.tsx), hoisted for web's reason: the row that asked for it is
// virtualized and can repaint or recycle under an open editor. It used to be an
// expo-router modal route below 768 and the kit's Dialog above it; the sheet's
// header carries why one shell replaced both.
//
// Divergences from web:
//
//  - The link arrives as an id and is read ONCE (the draft is a snapshot —
//    web's `editing.link` is equally frozen at request time; `update` re-reads
//    before merging either way). A link deleted since its menu opened closes
//    the editor. The EXTRACTION read stays live, like web, so the placeholder
//    title / fallback image update mid-edit.
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
import { Image, type LayoutChangeEvent, Pressable, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageOff, ImagePlus } from 'lucide-react-native';

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
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Sheet } from '../../components/ui/sheet';
import { Text } from '../../components/ui/text';
import { Textarea } from '../../components/ui/textarea';
import { type FocusedFieldReveal, useFocusedFieldReveal } from '../../lib/use-focused-field-reveal';

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

// The editor's draft and its one Save. Mounted per open, so the draft is a
// snapshot of `link`. `onDone` is how the editor closes once a Save lands.
function useLinkEditDraft(link: LinkItem, onDone: () => void) {
  const { update, saveCustomImage, deleteCustomImage } = useLinkMutations();

  // The extraction supplies the fallbacks the overrides sit above: the
  // placeholder title and the image shown after "Reset to extracted". Live, so
  // a backfill landing mid-edit updates them.
  const id = linkIdOf(link);
  const extraction = useLiveRead(() => readExtraction(id), [id], ['items']);
  const extractedTitle = extraction?.title;

  // Draft state, snapshotted from the link at mount (this component mounts per
  // open — see LinkEditPanel's key). Title/note hold the OVERRIDE/typed
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

// The form's fields. `onFocusFieldLayout` lands the `focus` field (the sheet
// owns the scroller); `reveal` keeps a focused field above the keyboard
// (lib/use-focused-field-reveal.ts).
function LinkEditFields({
  link,
  draft,
  focus,
  onFocusFieldLayout,
  reveal,
}: {
  link: LinkItem;
  draft: LinkEditDraft;
  focus?: EditFocus;
  onFocusFieldLayout: (e: LayoutChangeEvent) => void;
  reveal: FocusedFieldReveal;
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
          onFocus={reveal.onFieldFocus}
          onBlur={reveal.onFieldBlur}
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
          onFocus={reveal.onFieldFocus}
          onBlur={reveal.onFieldBlur}
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
            form.

            Being last also retired this form's own reason for the fixed
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
            the 328 a 360pt screen leaves inside `px-4`, and 377 at the 1.3
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

// The link to edit and the field to land on — what the row menu hands
// LinkEditHost.
export type LinkEditTarget = { linkId: string; focus?: EditFocus };

// The close guard, mapped onto the sheet: the ACCIDENTAL vectors — the
// backdrop and Android's back, which the sheet routes to `onDismiss` — are
// swallowed while dirty, and the ✕ and Cancel stay the deliberate doors
// (docs/editors.md, invariant 3).
export function LinkEditPanel({
  target,
  onClose,
}: {
  target: LinkEditTarget | null;
  onClose: () => void;
}) {
  // One-shot load per target: undefined = loading, null = missing (a link
  // deleted since its menu opened), which closes.
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
  return <LinkEditSheet key={link.path} link={link} focus={target.focus} onClose={onClose} />;
}

function LinkEditSheet({
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
  // `focus` SCROLLS its field into view once, off that field's first layout —
  // no programmatic focus (the header). The fields sit in the reveal's content
  // View, which starts at the top of the content, so a field's `layout.y` is
  // content-relative.
  const scrolledToFocus = useRef(false);
  const onFocusFieldLayout = (e: LayoutChangeEvent) => {
    if (scrolledToFocus.current) return;
    scrolledToFocus.current = true;
    reveal.scrollRef.current?.scrollTo({ y: e.nativeEvent.layout.y, animated: false });
  };

  return (
    <Sheet
      title="Edit link"
      description={link.url}
      closeLabel="Close edit link"
      onClose={onClose}
      onDismiss={() => {
        if (!draft.isDirty) onClose();
      }}
      reveal={reveal}
      footer={<LinkEditActions draft={draft} onCancel={onClose} />}
    >
      <LinkEditFields
        link={link}
        draft={draft}
        focus={focus}
        onFocusFieldLayout={onFocusFieldLayout}
        reveal={reveal}
      />
    </Sheet>
  );
}
