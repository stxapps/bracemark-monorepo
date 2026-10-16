// A decoded entity joined to its storage PATH — the read-layer bundle that sits
// between the two files it's built from: the plaintext shapes (entities.ts) and
// the path↔id math (paths.ts). Kept OUT of entities.ts on purpose: that file is
// scoped to the plaintext INSIDE the ciphertext (what's encrypted), whereas `path`
// is the opposite — the storage key, infrastructure the server assigns, never part
// of the plaintext. This is a cross-platform contract like the shapes themselves:
// every client decodes a blob keyed by a path, so the "entity + where it lives"
// bundle lives here in `shared`, not in any one app's read layer.

import type { Extraction, Link, List, Pin, Tag } from './entities';
import { idFromPath, LINKS_PREFIX, LISTS_PREFIX, PINS_PREFIX, TAGS_PREFIX } from './paths';

// A parsed entity always carries its source `items` path — the stable id every
// other layer (op log, pending queue, R2) keys by, and what the UI needs to
// select/edit/delete a row without a second lookup.
export type WithPath<T> = T & { path: string };
export type LinkItem = WithPath<Link>;
export type ListItem = WithPath<List>;
export type TagItem = WithPath<Tag>;
export type PinItem = WithPath<Pin>;
export type ExtractionItem = WithPath<Extraction>;

// A link's id is the `{id}` of its `links/{id}.enc` path. Derive it from the stored
// path (the only authority for identity — never the plaintext `id` copy) so callers
// pass a LinkItem and nothing reconstructs ids by hand. The one home for links; the
// pin/extraction shadows are built by rekeying this same path (see sync/paths.ts).
export function linkIdOf(link: LinkItem): string {
  return idFromPath(link.path, LINKS_PREFIX);
}

// A list or tag as a read edge hands it on: its `id` is the `{id}` of its path,
// whatever the copy inside the plaintext says. A link has no such copy to get
// wrong (linkIdOf, above); a list and a tag do, and everything downstream goes by
// it — `parentId` resolves against it, a link's `listId` and `tagIds` name it,
// the lock model covers it, a system list is recognised by it — so for these two
// the copy WAS the identity, and nothing made it agree with the path. The store
// is keyed by path and sync writes whatever arrives, so two records could share
// an id, or a user list hold `trash`, and every reader took their word. Applied
// by both platforms' readLists/readTags (data/queries.ts); the unchanged entity
// is handed back when the two agree, which is every record this app wrote.
//
// What it changes for a record that disagrees: anything naming its OLD id — a
// child's `parentId`, a link's `listId` or `tagIds` — is now a dangling
// reference, which every reader already tolerates (the child is a root, the link
// files under My List on export and loses the tag). One of those references is
// not harmless: a device-local list lock is keyed by list id, so a lock set
// under the old id covers nothing afterwards (docs/locks.md, Keying). The next
// edit rewrites the plaintext with the path's id.
function withPathId<T extends { id: string }>(entity: WithPath<T>, prefix: string): WithPath<T> {
  const id = idFromPath(entity.path, prefix);
  return entity.id === id ? entity : { ...entity, id };
}

export function listWithPathId(list: ListItem): ListItem {
  return withPathId(list, LISTS_PREFIX);
}

export function tagWithPathId(tag: TagItem): TagItem {
  return withPathId(tag, TAGS_PREFIX);
}

// A pin carries its link's id the same way (`pins/{linkId}.enc`), and the
// readers went by the copy: the pinned overlay looks up the link it names, pin
// reordering finds the moved pin and its neighbour, and both bulk-edit bars
// split a selection into "to pin" and "to unpin". A pin whose copy disagrees
// with its path then named one link while its file shadowed another — and
// writePin writes the copy back unchanged, so a reorder never corrected it.
// Applied by both platforms' readPins, which every one of those readers goes
// through; the next write stores the path's id.
export function pinWithPathId(pin: PinItem): PinItem {
  return withPathId(pin, PINS_PREFIX);
}
