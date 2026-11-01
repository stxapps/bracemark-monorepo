// Edit operations for links, bound to the active account and wired to a sync
// kick — the expo port of web-react's use-link-mutations (that file is the
// canonical doc for each op's semantics: the one-file-per-entity LWW model,
// the re-read-before-merge, destroy's satellite sweep, saveCustomImage's
// content-before-metadata ordering). The full set is ported; one platform
// divergence: `saveCustomImage` takes a picked file's uri+dimensions rather
// than bytes — content stays out of the JS heap here (file-store.ts), so the
// resize (lib/image.ts) and the store write (mutations.ts writeFile)
// are both uri/path-to-path.
//
// `updateMany`/`destroyMany` are the batched forms every bulk action must ride
// rather than looping their single-link siblings — web's header carries the
// reasoning (a loop is a transaction, a sync kick and a full repaint per link).

import { useCallback, useMemo } from 'react';
import { File } from 'expo-file-system';

import { newId } from '@stxapps/expo-crypto';
import {
  extractionFileIds,
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  LINKS_PREFIX,
  pathFromId,
  PINS_PREFIX,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import {
  bulkDeleteEntities,
  bulkWriteLinks,
  deleteExtraction,
  deleteFile,
  deleteLink,
  deletePin,
  type LinkEdit,
  type LinkPatch,
  writeFile,
  writeLink,
} from '../data/mutations';
import {
  linkIdOf,
  type LinkItem,
  readExtraction,
  readExtractionsByLinkIds,
  readLinkById,
  readLinksByPaths,
} from '../data/queries';
import { resizeImage, type ResizeImageSource } from '../lib/image';

// What the add form collects — web-react's LinkDraft, verbatim. `title` is
// intentionally absent: a link is saved from just a URL, and its title is
// back-filled by a later metadata fetch. `listId` always resolves to a
// concrete list at the call site (the active list, or My List as the inbox
// default).
export interface LinkDraft {
  url: string;
  listId: string;
  tagIds: string[];
  // Optional free-text note the user typed at save.
  // Stored inline on the link (`note` on linkSchema); omitted/blank → no note.
  note?: string;
}

export interface LinkMutations {
  // Create a link from a draft. Returns the created link so the UI can
  // focus/scroll to its new row, mirroring useListMutations.create. A blank URL
  // is a no-op (returns null).
  create: (draft: LinkDraft) => Promise<LinkItem | null>;
  // Patch a link's user-authored fields (LinkPatch — an explicitly-undefined
  // field clears it). Every caller rides this one op: move-to-list, archive,
  // restore, trash are all `{ listId }`; the edit dialog passes the full patch.
  update: (link: LinkItem, patch: LinkPatch) => Promise<void>;
  // Apply N per-link patches in ONE write — what every BULK action rides (the
  // bulk bar's move/archive/restore/remove, the retag sheet). Not a loop over
  // `update`: a loop costs a transaction, a sync kick and a full re-read +
  // repaint of the list PER LINK. Callers pass only the links that actually
  // change (a no-op patch would bump `updatedAt` and reorder the date-modified
  // sort); an empty batch is a no-op.
  updateMany: (edits: LinkEdit[]) => Promise<void>;
  // Permanently delete a link AND its satellites: the `files/` blobs it (or its
  // extraction) references, its `extractions/{id}.enc`, its pin, then the link
  // itself. Irreversible — callers confirm first; "move to Trash" is `update`.
  destroy: (link: LinkItem) => Promise<void>;
  // `destroy` for N links, batched the same way `updateMany` batches `update`.
  destroyMany: (links: LinkItem[]) => Promise<void>;
  // Persist a user-picked image as a new `files/{id}.enc` (dimension-capped via
  // resizeImage — the client-side thumbnailing step) and return the file id to
  // store as `customImageId`. Content-before-metadata: call this FIRST, then
  // `update` with the returned id (which also kicks the sync). Takes the picked
  // file's uri + reported dimensions (not bytes — see the header).
  saveCustomImage: (source: ResizeImageSource) => Promise<string>;
  // Drop a replaced/cleared custom image's `files/{id}.enc` blob. Call AFTER the
  // `update` that removed/replaced the reference.
  deleteCustomImage: (fileId: string) => Promise<void>;
}

export function useLinkMutations(): LinkMutations {
  const { username } = useAuth();
  const { requestSync } = useSync();

  const create = useCallback(
    async (draft: LinkDraft) => {
      if (!username) throw new Error('useLinkMutations: no active account');

      const url = draft.url.trim();
      if (url === '') return null;

      const id = newId();
      // createdAt: 0 → writeLink stamps it now (same first-write contract as
      // writeList); path is the well-known store key its blob will live at. No title
      // here: a link is saved from just a URL, and its title is filled later into the
      // separate `extractions/{id}.enc` (the writer-split — see docs/link-extraction.md);
      // a user-typed title would go in `customTitle`, which this quick-add doesn't collect.
      const link: LinkItem = {
        url,
        tagIds: draft.tagIds,
        listId: draft.listId,
        createdAt: 0,
        updatedAt: 0,
        path: pathFromId(id, LINKS_PREFIX),
      };

      // A blank note stays absent (not an empty string) — keeps the link's blob
      // minimal and matches "omitted → no note".
      const note = draft.note?.trim();
      if (note) link.note = note;

      await writeLink(username, link, {});
      requestSync();
      return link;
    },
    [username, requestSync],
  );

  const update = useCallback(
    async (link: LinkItem, patch: LinkPatch) => {
      if (!username) throw new Error('useLinkMutations: no active account');

      // Re-read the current blob before merging: the caller's `link` is a row/dialog
      // snapshot, and a sync may have landed a fresher blob since it rendered —
      // writeLink spreads the patch onto what it's handed, so merging onto the stale
      // snapshot would silently resurrect overwritten fields. Gone entirely (deleted
      // on another device) falls back to the snapshot: the edit recreates the link,
      // the honest LWW outcome for edit-vs-delete.
      const current = (await readLinkById(linkIdOf(link))) ?? link;
      await writeLink(username, current, patch);
      requestSync();
    },
    [username, requestSync],
  );

  const updateMany = useCallback(
    async (edits: LinkEdit[]) => {
      if (!username) throw new Error('useLinkMutations: no active account');
      if (edits.length === 0) return;

      // No re-read here, unlike `update`: bulkWriteLinks re-reads each current
      // blob INSIDE its transaction — the stronger form of the same staleness
      // rule (no window between the read and the put).
      await bulkWriteLinks(username, edits);
      requestSync();
    },
    [username, requestSync],
  );

  const destroy = useCallback(
    async (link: LinkItem) => {
      if (!username) throw new Error('useLinkMutations: no active account');

      const id = linkIdOf(link);
      // Freshest copy for the sweep (same staleness argument as `update`): the
      // custom-image ref may have changed since the row rendered.
      const current = (await readLinkById(id)) ?? link;
      const extraction = await readExtraction(id);

      // The link's `files/` content: the user's custom image plus everything the
      // extraction references. Content first, entities after — a briefly-dangling
      // ref reads as "no bytes" (readFileBytes → undefined), whereas deleting the
      // link first would orphan the blobs forever if interrupted.
      const fileIds = [current.customImageId, ...extractionFileIds(extraction)].filter(
        (fileId): fileId is string => typeof fileId === 'string',
      );
      for (const fileId of fileIds) await deleteFile(username, fileId);

      // Satellites keyed by the link's id. Absent ones (never extracted, never
      // pinned) are local no-ops + harmless tombstones upstream.
      await deleteExtraction(username, id);
      await deletePin(username, id);
      await deleteLink(username, current);
      requestSync();
    },
    [username, requestSync],
  );

  const destroyMany = useCallback(
    async (links: LinkItem[]) => {
      if (!username) throw new Error('useLinkMutations: no active account');
      if (links.length === 0) return;

      const ids = links.map((link) => linkIdOf(link));
      // Two batched reads for the whole selection where `destroy` does two per
      // link — the freshest blobs (the custom-image ref may have changed since
      // the rows rendered) and their extractions, which name the `files/`
      // content to sweep.
      const [current, extractions] = await Promise.all([
        readLinksByPaths(links.map((link) => link.path)),
        readExtractionsByLinkIds(ids),
      ]);

      // Every path this delete touches, flat: each link's `files/` blobs (its
      // custom image plus everything its extraction references), its
      // `extractions/{id}.enc`, its pin, and the link itself. `destroy` orders
      // content before entities so an interruption leaves a dangling ref rather
      // than orphaned blobs; one transaction has no interruption to order around
      // (bulkDeleteEntities, which also sweeps the plaintext files after the
      // rows).
      const paths: string[] = [];
      for (let i = 0; i < links.length; i++) {
        const link = current[i] ?? links[i];
        const extraction = extractions[i];
        const fileIds = [link.customImageId, ...extractionFileIds(extraction)].filter(
          (fileId): fileId is string => typeof fileId === 'string',
        );
        for (const fileId of fileIds) paths.push(pathFromId(fileId, FILES_PREFIX));
        paths.push(pathFromId(ids[i], EXTRACTIONS_PREFIX));
        paths.push(pathFromId(ids[i], PINS_PREFIX));
        paths.push(link.path);
      }

      await bulkDeleteEntities(username, paths);
      requestSync();
    },
    [username, requestSync],
  );

  const saveCustomImage = useCallback(
    async (source: ResizeImageSource) => {
      if (!username) throw new Error('useLinkMutations: no active account');

      const fileId = newId();
      // Cap dimensions before it's stored (docs/link-extraction.md — thumbnailing
      // is a client step, bounding the per-user quota); resizeImage falls back to
      // the original uri for anything it can't process, so this never rejects a
      // pick. Callers may have resized at pick time already — within-cap input
      // passes through untouched, so the backstop costs nothing.
      const capped = await resizeImage(source);
      await writeFile(username, fileId, new File(capped.uri));
      // No sync kick here: the caller follows with `update({ customImageId })`,
      // which kicks it — content-before-metadata within one drain.
      return fileId;
    },
    [username],
  );

  const deleteCustomImage = useCallback(
    async (fileId: string) => {
      if (!username) throw new Error('useLinkMutations: no active account');

      await deleteFile(username, fileId);
      requestSync();
    },
    [username, requestSync],
  );

  return useMemo<LinkMutations>(
    () => ({
      create,
      update,
      updateMany,
      destroy,
      destroyMany,
      saveCustomImage,
      deleteCustomImage,
    }),
    [create, update, updateMany, destroy, destroyMany, saveCustomImage, deleteCustomImage],
  );
}
