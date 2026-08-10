'use client';

// The full link editor: a centered modal dialog covering exactly the
// user-authored `links/{id}.enc` fields — custom title, custom image, list,
// tags, note (docs/link-extraction.md "manual overrides"). One Save = one
// writeLink, one LWW unit; pinning is deliberately NOT here (a separate
// `pins/` entity, fully served by the row menu — a form that wrote two files
// would race two LWW points). It's a dialog, not a route: an edit session is
// ephemeral, private draft state, which the page-provider's URL doctrine keeps
// out of the URL (`/links/{id}` stays reserved for a future link DETAIL view).
//
// Rendered ONCE at the page level (Main) and driven by the hoisted `editing`
// state in view-state-provider: rows are virtualized and repaint under sync, so
// a row-owned dialog could unmount mid-edit — the row menu only *requests* the
// edit. While open it holds `engaged`, so background sync results are staged
// rather than repainting the list under the modal.
//
// Title/image follow the override-wins model: the inputs edit `customTitle` /
// `customImageId`, the placeholders/preview fall back to the extracted values,
// and CLEARING an override (blank title / "Reset to extracted") deletes the
// field so the display falls back to `extraction.title ?? host(url)` — revert
// is trivial because the discovered value was never destroyed.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ImageOff, ImagePlus } from 'lucide-react';

import { hostFromText, LINK_NOTE_MAX, LINK_TITLE_MAX, TRASH_ID } from '@stxapps/shared';
import {
  linkIdOf,
  type LinkPatch,
  type LinkView,
  readExtraction,
  readFileBytes,
  resizeImage,
  useLinkMutations,
} from '@stxapps/web-react';
import { ListSelect } from '@stxapps/web-ui/components/links/list-select';
import { TagsField } from '@stxapps/web-ui/components/links/tags-field';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@stxapps/web-ui/components/ui/dialog';
import { Input } from '@stxapps/web-ui/components/ui/input';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { Textarea } from '@stxapps/web-ui/components/ui/textarea';

import { useLinksViewState } from '../_contexts/view-state-provider';

export function LinkEditDialog() {
  const { editing, closeEditor } = useLinksViewState();
  // Closed = fully unmounted (no exit animation — deliberate), so the form below
  // initializes its draft from the link at every open; the key remounts it when
  // an open dialog is retargeted at another link.
  if (!editing) return null;
  return (
    <LinkEditForm
      key={editing.link.path}
      link={editing.link}
      focus={editing.focus}
      onClose={closeEditor}
    />
  );
}

// What the user has decided about the custom image this session: leave it alone,
// replace it with picked bytes, or clear the override back to the extracted one.
type ImageDraft =
  { kind: 'keep' } | { kind: 'pick'; bytes: Uint8Array; previewUrl: string } | { kind: 'clear' };

// Order-sensitive equality is fine here: the draft starts FROM link.tagIds, so
// any reordering means the user removed and re-added — a real edit either way.
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function LinkEditForm({
  link,
  focus,
  onClose,
}: {
  link: LinkView;
  focus?: 'tags' | 'note';
  onClose: () => void;
}) {
  const { update, saveCustomImage, deleteCustomImage } = useLinkMutations();

  // The extraction supplies the fallbacks the overrides sit above: the
  // placeholder title and the image shown after "Reset to extracted". Live, so
  // a backfill landing mid-edit updates them.
  const id = linkIdOf(link);
  const extraction = useLiveQuery(() => readExtraction(id), [id]);
  const extractedTitle = extraction?.title;

  // Draft state, snapshotted from the row at open (this component mounts per
  // open — see LinkEditDialog). Title/note hold the OVERRIDE/typed value, not
  // the resolved display value: blank title = "no override".
  const [title, setTitle] = useState(link.customTitle ?? '');
  const [listId, setListId] = useState(link.listId);
  const [tagIds, setTagIds] = useState<string[]>(link.tagIds);
  const [note, setNote] = useState(link.note ?? '');
  const [image, setImage] = useState<ImageDraft>({ kind: 'keep' });
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Where focus lands on open. Radix would otherwise focus the first focusable
  // (the title input) and override any per-field autoFocus, so we drive it
  // ourselves from the dialog's onOpenAutoFocus (below) via these refs.
  const titleRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // The stored image the preview shows when no fresh pick is pending: the
  // override-wins resolution, except 'clear' previews the post-clear fallback
  // (the extracted image, or nothing). Local bytes only (readFileBytes) — a blob
  // this device hasn't materialized just shows the empty hint.
  const storedImageId =
    image.kind === 'clear' ? extraction?.imageId : (link.customImageId ?? extraction?.imageId);
  const storedBytes = useLiveQuery(
    () => (storedImageId ? readFileBytes(storedImageId) : Promise.resolve(undefined)),
    [storedImageId],
  );
  const storedUrl = useMemo(
    () => (storedBytes ? URL.createObjectURL(new Blob([storedBytes as BlobPart])) : undefined),
    [storedBytes],
  );
  useEffect(
    () => () => {
      if (storedUrl) URL.revokeObjectURL(storedUrl);
    },
    [storedUrl],
  );
  // The picked file's object URL lives inside the draft; revoke it whenever the
  // draft moves off that pick (new pick, clear, unmount).
  useEffect(
    () => () => {
      if (image.kind === 'pick') URL.revokeObjectURL(image.previewUrl);
    },
    [image],
  );
  const previewUrl = image.kind === 'pick' ? image.previewUrl : storedUrl;

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Allow re-picking the same file after a clear: the input's value is
    // consumed here so the next change always fires.
    e.target.value = '';
    if (!file) return;
    // Cap dimensions at pick time (the client-thumbnailing step — see
    // resize-image.ts / docs/editors.md) so the draft holds exactly the bytes
    // that will be stored and the preview reflects them, not a full-size original
    // kept in state. resizeImage returns the input untouched when it's already
    // within the cap and never throws, so a pick can't be rejected. saveCustomImage
    // resizes again on Save — a no-op on these already-capped bytes, kept as the
    // backstop for any other caller.
    const bytes = await resizeImage(new Uint8Array(await file.arrayBuffer()));
    // Preview from the resized bytes, not the file, so what the user sees is what
    // gets stored. An object URL over typeless bytes still renders (the <img>
    // sniffs the format — same as the stored-image preview below).
    setImage({
      kind: 'pick',
      bytes,
      previewUrl: URL.createObjectURL(new Blob([bytes as BlobPart])),
    });
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

  const onSubmit = async (e: React.SubmitEvent) => {
    e.preventDefault();
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
        patch.customImageId = await saveCustomImage(image.bytes);
      } else if (image.kind === 'clear' && replacedImageId) {
        patch.customImageId = undefined;
      }

      if (Object.keys(patch).length > 0) {
        await update(link, patch);
        if (image.kind !== 'keep' && replacedImageId) {
          await deleteCustomImage(replacedImageId);
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    // Guard only the ACCIDENTAL close vectors — backdrop click, Escape, and the
    // corner X all funnel through onOpenChange. When there are unsaved changes,
    // swallow those so a stray click can't drop a typed note or picked image;
    // the user must then reach for Save or the explicit Cancel below (which calls
    // onClose directly, bypassing this — a deliberate discard stays one click).
    <Dialog open onOpenChange={(open) => !open && !isDirty && onClose()}>
      {/* Cap to the viewport and scroll the fields region (below) rather than
          the whole dialog, so the header and Save/Cancel footer stay pinned
          when the form (image preview + tags + note) outgrows a short screen. */}
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md"
        // Radix's default open-autofocus grabs the first focusable — the title
        // input — so "View note"/"Edit tags" would still land on title. Take
        // over: focus the field the opener asked for. The tags trigger rings
        // itself off its own focus state (see TagsField), so a plain focus() is
        // enough for all three.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          if (focus === 'note') noteRef.current?.focus();
          else if (focus === 'tags') tagsRef.current?.focus();
          else titleRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit link</DialogTitle>
          <DialogDescription className="truncate">{link.url}</DialogDescription>
        </DialogHeader>

        <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={onSubmit} noValidate>
          {/* The scrollable body. -mx-1 px-1 gives focus rings room so
              overflow-y-auto doesn't clip them at the edges. */}
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-title">Title</Label>
              <Input
                ref={titleRef}
                id="edit-title"
                maxLength={LINK_TITLE_MAX}
                placeholder={extractedTitle ?? hostFromText(link.url)}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              {/* The placeholder isn't selectable, so someone who wants to tweak
                  just part of the extracted title has no seed to edit. Offer one
                  ONLY while the field is blank (no override yet) and a real
                  extracted title exists — seeding host(url) isn't worth editing,
                  and once there's content this affordance can't clobber it.
                  Note: seeding turns the live fallback into a frozen override,
                  which is exactly what editing the title means. */}
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Leave blank to use the page&rsquo;s own title.
                </p>
                {title.trim() === '' && extractedTitle && (
                  <button
                    type="button"
                    className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
                    onClick={() => setTitle(extractedTitle)}
                  >
                    Edit it instead
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-image">Image</Label>
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt=""
                  className="max-h-40 w-full rounded-md border border-border object-cover"
                />
              ) : (
                <p className="text-xs text-muted-foreground">No preview image.</p>
              )}
              <div className="flex gap-1.5">
                <input
                  ref={fileInputRef}
                  id="edit-image"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => void onPickImage(e)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus className="size-4" />
                  Choose image
                </Button>
                {(image.kind === 'pick' || (image.kind === 'keep' && link.customImageId)) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setImage({ kind: 'clear' })}
                  >
                    <ImageOff className="size-4" />
                    Reset to extracted
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-list">List</Label>
              {/* No Trash target: trashing is the menu's Remove, never a "move".
                  Locked/hidden lists stay pickable — hiding only declutters the
                  sidebar, it never blocks filing into a list you know exists. */}
              <ListSelect
                id="edit-list"
                value={listId}
                onValueChange={setListId}
                excludeIds={[TRASH_ID]}
                allowCreate
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-tag">Tags</Label>
              <TagsField ref={tagsRef} id="edit-tag" value={tagIds} onChange={setTagIds} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-note">Note</Label>
              {/* The row menu's "View note" lands here (focus === 'note'): the
                  note has no read-only surface — the layouts are fixed-height, so
                  a row can only badge it — and at LINK_NOTE_MAX a textarea reads
                  as well as any viewer would, with the edit already in hand.
                  Focusing also scrolls this last field into view. */}
              <Textarea
                ref={noteRef}
                id="edit-note"
                maxLength={LINK_NOTE_MAX}
                placeholder="Optional note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="default" size="sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
