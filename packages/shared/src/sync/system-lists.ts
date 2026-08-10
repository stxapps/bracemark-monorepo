// The three lists every account has — My List, Archive, Trash — provided as
// CODE DEFAULTS, not synced `lists/{id}.enc` entities. Part of the cross-platform
// data contract (the id space for a link's `listId` — see entities.ts), so they
// live here in `shared` beside the schemas, not in any one app.
//
// They start as defaults so a brand-new account has them with nothing to encrypt
// or seed — and so two devices can't race to create duplicate "My List" files.
// But they are FULLY EDITABLE: rename, reorder, or reparent one and the client
// writes a real `lists/{id}.enc` blob AT THE RESERVED SYSTEM ID (an override).
// Because every device writes to that same deterministic path, file-level LWW
// collapses concurrent edits to one file — no duplicate, no race — which is the
// whole reason the defaults aren't seeded as blobs up front. On read, merge:
// `stored override ?? default` (see mergeSystemLists in the web read layer).
//
// A link belongs to one of these exactly like any user list, via its `listId`
// (`link.listId === id`), so filtering stays uniform across system and user
// lists. Their ids are the same on every account, so they leak nothing in a URL
// (`?list=trash` is safe) — unlike a user list, whose id is an opaque token.
//
// RESERVED INVARIANT: creating a NEW user list must never mint an id equal to one
// of these (or ALL_ID). The only blob allowed at a system id is an override of
// that system list itself.

import type { List } from './entities';
import { ranksBetween } from './rank';

// `all` is the Show-All pseudo-list (no filter — every link), distinct from the
// three real system lists below. It's a list-param value, not an entity id.
export const ALL_ID = 'all';

// The label for the Show-All view. It's a no-filter pseudo-list, NOT a system
// list, so it's deliberately kept OUT of SYSTEM_LIST_NAMES / SYSTEM_LIST_IDS /
// SYSTEM_LIST_DEFAULTS — those three mean exactly My List / Archive / Trash. Same
// i18n fate as the names below (graduates to the translation layer; the id stays).
export const ALL_LABEL = 'Show All';

export const MY_LIST_ID = 'my-list';
export const ARCHIVE_ID = 'archive';
export const TRASH_ID = 'trash';

// What a brand-new link belongs to, and the default selection a client shows when
// no list is chosen. My List is the default inbox.
export const DEFAULT_LIST_ID = MY_LIST_ID;

// The system list ids, for `isSystemListId` and the reserved-id invariant.
export const SYSTEM_LIST_IDS: ReadonlySet<string> = new Set([MY_LIST_ID, ARCHIVE_ID, TRASH_ID]);

export function isSystemListId(id: string): boolean {
  return SYSTEM_LIST_IDS.has(id);
}

// Trash takes no children: it's the deletion staging area (links pending the
// purge window), so nesting a list inside it is incoherent. It can still be
// moved/renamed and BE a child — it just can't be a parent. buildTree promotes
// anything naming it as `parentId` back to the root; pass this to the list tree.
export const LIST_NO_CHILDREN_IDS: ReadonlySet<string> = new Set([TRASH_ID]);

// Default display names for the system selections, keyed by id. User list/tag
// names come from the decrypted store instead; these are the only names that live
// in code, and the default a system list shows until the user renames it (which
// writes an override blob whose `name` then wins). NOTE: these are the canonical
// English labels — when i18n arrives they graduate to the translation layer (an
// untouched system list localizes; a user-renamed one keeps its literal string)
// and only the ids stay here.
export const SYSTEM_LIST_NAMES: Record<string, string> = {
  [MY_LIST_ID]: 'My List',
  [ARCHIVE_ID]: 'Archive',
  [TRASH_ID]: 'Trash',
};

// Three evenly-spaced rank keys seeding the default order My List < Archive <
// Trash. Real fractional-index keys (rank.ts) in the same keyspace as user lists,
// so a newly created user list can rank against / between them. Computed once.
const [MY_LIST_RANK, ARCHIVE_RANK, TRASH_RANK] = ranksBetween(null, null, 3);

// The default system lists, in order. All root-level (`parentId: null`). The
// timestamps are a fixed genesis value: an untouched default never enters the
// store and never sorts by time (rank orders the tree), and an override blob
// stamps real timestamps when written. The merge in the read layer overlays a
// stored override by id; these are the fallbacks.
export const SYSTEM_LIST_DEFAULTS: readonly List[] = [
  {
    id: MY_LIST_ID,
    name: SYSTEM_LIST_NAMES[MY_LIST_ID],
    parentId: null,
    rank: MY_LIST_RANK,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: ARCHIVE_ID,
    name: SYSTEM_LIST_NAMES[ARCHIVE_ID],
    parentId: null,
    rank: ARCHIVE_RANK,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: TRASH_ID,
    name: SYSTEM_LIST_NAMES[TRASH_ID],
    parentId: null,
    rank: TRASH_RANK,
    createdAt: 0,
    updatedAt: 0,
  },
];
