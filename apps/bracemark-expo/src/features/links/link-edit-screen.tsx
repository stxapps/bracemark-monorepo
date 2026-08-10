// The full link editor — the expo port of bracemark-web's LinkEditDialog
// (`(app)/links/_components/link-edit-dialog.tsx`, the canonical doc for the
// semantics: exactly the user-authored `links/{id}.enc` fields — custom title,
// custom image, list, tags, note; one Save = one writeLink, one LWW unit, pins
// deliberately elsewhere; the override-wins title/image model where CLEARING
// falls back to the extracted value; the minimal-patch Save; the dirty close
// guard). Presented like the add editor: a modal router screen summoned by the
// row menu (link-row-menu.tsx), not a hoisted page-level dialog — web hoists
// because virtualized rows repaint under the open dialog, but a pushed screen
// isn't anchored to a row and its draft is a snapshot, so no `editing` state
// (and no engagement signal) is needed in view-state-provider at all. Same
// router-screen-over-RN-Modal reasons as link-add-screen.tsx (keyboard-
// controller, portals, guardable close).
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
//    the keyboard — over the very note "View note" came to read.
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
} from '@stxapps/expo-react';
import { hostFromText, LINK_NOTE_MAX, LINK_TITLE_MAX, TRASH_ID } from '@stxapps/shared';

import { ListSelect } from '../../components/links/list-select';
import { TagsField } from '../../components/links/tags-field';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';

const StyledSafeAreaView = withUniwind(SafeAreaView);
const StyledKeyboardAwareScrollView = withUniwind(KeyboardAwareScrollView);

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

// A labeled field row (the add screen's Field, shared shape).
function Field({
  label,
  children,
  onLayout,
}: {
  label: string;
  children: React.ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  return (
    <View className="gap-1.5" onLayout={onLayout}>
      <Text className="text-xs text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
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

function LinkEditForm({ link, focus }: { link: LinkItem; focus?: EditFocus }) {
  const router = useRouter();
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

  // Guard only the ACCIDENTAL close vectors (swipe-down, Android back) while
  // dirty — the add screen's guard, same wiring: `closing` is the deliberate
  // door (Cancel/X/save), dropping the guard before the effect pops.
  const [closing, setClosing] = useState(false);
  usePreventRemove(isDirty && !closing, () => {
    // Swallowed silently — web's guard eats the backdrop-click/Escape the same
    // way; the Cancel button is the deliberate discard door.
  });
  useEffect(() => {
    if (closing) router.back();
  }, [closing, router]);
  const close = () => setClosing(true);

  // `focus` scrolls its field into view once, off that field's first layout
  // (fields are direct children of the scroll content, so layout.y is
  // content-relative). No programmatic focus — see the header.
  const scrollRef = useRef<ScrollView>(null);
  const scrolledToFocus = useRef(false);
  const onFocusFieldLayout = (e: LayoutChangeEvent) => {
    if (scrolledToFocus.current) return;
    scrolledToFocus.current = true;
    scrollRef.current?.scrollTo({ y: e.nativeEvent.layout.y, animated: false });
  };

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
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <View className="shrink-0 flex-row items-center justify-between gap-2 border-b border-border py-2 pr-2 pl-4">
        <View className="min-w-0 flex-1">
          <Text className="text-lg font-semibold">Edit link</Text>
          <Text numberOfLines={1} className="text-xs text-muted-foreground">
            {link.url}
          </Text>
        </View>
        <Pressable
          onPress={close}
          aria-label="Close edit link"
          className="size-10 shrink-0 items-center justify-center rounded-md"
        >
          <Icon as={X} className="size-5 text-muted-foreground" />
        </Pressable>
      </View>
      <StyledKeyboardAwareScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName="gap-4 p-4"
        keyboardShouldPersistTaps="handled"
        bottomOffset={16}
      >
        <Field label="Title">
          <Input
            value={title}
            onChangeText={setTitle}
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
              <Pressable onPress={() => setTitle(extractedTitle)} className="shrink-0">
                <Text className="text-xs text-primary">Edit it instead</Text>
              </Pressable>
            )}
          </View>
        </Field>

        <Field label="Image">
          {previewUri ? (
            <Image
              source={{ uri: previewUri }}
              accessibilityIgnoresInvertColors
              resizeMode="cover"
              className="h-40 w-full rounded-md border border-border"
            />
          ) : (
            <Text className="text-xs text-muted-foreground">No preview image.</Text>
          )}
          <View className="flex-row gap-1.5">
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
        </Field>

        {/* No Trash target: trashing is the menu's Remove, never a "move".
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

        <Field label="Tags" onLayout={focus === 'tags' ? onFocusFieldLayout : undefined}>
          <TagsField value={tagIds} onChange={setTagIds} />
        </Field>

        {/* The row menu's "View note" lands here (focus === 'note'): the note
            has no read-only surface — the layouts are fixed-height, so a row
            can only badge it — and at LINK_NOTE_MAX this input reads as well as
            any viewer would, with the edit already in hand. */}
        <Field label="Note" onLayout={focus === 'note' ? onFocusFieldLayout : undefined}>
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

        <View className="flex-row justify-end gap-2">
          <Button variant="ghost" size="sm" onPress={close}>
            <Text>Cancel</Text>
          </Button>
          <Button size="sm" disabled={saving} onPress={() => void onSubmit()}>
            <Text>{saving ? 'Saving…' : 'Save'}</Text>
          </Button>
        </View>
      </StyledKeyboardAwareScrollView>
    </>
  );
}
