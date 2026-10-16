// Find-or-create resolution for the taxonomy an interop file names by STRING:
// a bookmark row carries a folder path and tag names, never this library's ids,
// so every import has to walk those names against the existing lists/tags and
// mint what's missing. Pure — the caller passes the current lists/tags (read
// from its own store) and gets back the resolved ids plus the entities to
// write; nothing here touches a store.
//
// `newId` is a constructor argument because id minting is the one thing that
// isn't shared: it's `@stxapps/web-crypto` on web and `@stxapps/expo-crypto` on
// expo, and `shared` can't import either (both are platform-tagged). Same seam
// the sync engine uses for its platform deps.
//
// Both resolvers are STATEFUL over one import run: the sibling groups they sort
// and rank against grow as entities are created, so a second row naming the
// same new folder reuses it and ranks stay monotonic. One resolver per run.

import {
  cleanName,
  LINK_TAGS_MAX,
  type List,
  LIST_NAME_MAX,
  type Tag,
  TAG_NAME_MAX,
} from '../sync/entities';
import { LISTS_PREFIX, pathFromId, TAGS_PREFIX } from '../sync/paths';
import { compareRank, rankForIndex } from '../sync/rank';
import { MY_LIST_ID, TRASH_ID } from '../sync/system-lists';
import { TREE_MAX_DEPTH } from '../sync/tree';

// A minted entity and the items path to write it at — structurally the write
// edge's RawEntityEntry (data/mutations.ts, both platforms), which is where
// these go.
export interface CreatedEntity<T> {
  path: string;
  data: T;
}

// The existing lists/tags a resolver matches against — the columns it needs,
// so a caller can hand it whatever its read layer returns.
export interface ResolverNode {
  id: string;
  name: string;
  parentId: string | null;
  rank: string;
}

// The deepest folder chain an import builds is the tree's own limit,
// TREE_MAX_DEPTH (sync/tree.ts). A file names its own depth — a Netscape file
// by how many <DL>s it opens, a CSV by the separators in one cell, a LinkWarden
// backup by its parentId chain — and every level becomes a list, so without a
// bound the file would decide how deep this library's tree is.
//
// A deeper folder is PLACED at the limit, not refused: it becomes a list at
// level TREE_MAX_DEPTH, beside its level-(TREE_MAX_DEPTH - 1) ancestor's other
// children, under its own name and holding its own links. So no link lands in a
// list that isn't named for its own folder, and only the nesting below the limit
// is lost — the same shape the interop exports write (export/bundle.ts), so a
// deep library exported and imported again comes back the same lists. It used
// to refuse the whole file, which left the user nothing to import and nothing
// they could do short of editing the file by hand (docs/data-limits.md).
//
// A folder path is held to at most TREE_MAX_DEPTH + 1 names: the first
// TREE_MAX_DEPTH, then the row's own folder when it sits deeper. capFolderPath
// is that shape; a parser may hand the resolver a longer path (the resolver
// caps it) or cap its own as it builds them, which is what keeps a long chain
// from costing a path copy per level per row (linkwarden.ts).
export function capFolderPath(path: string[]): string[] {
  return path.length <= TREE_MAX_DEPTH + 1
    ? path
    : [...path.slice(0, TREE_MAX_DEPTH), path[path.length - 1]];
}

export class ListResolver {
  private childrenOf = new Map<string | null, { id: string; name: string; rank: string }[]>();
  private resolved = new Map<string, string>();
  // The lists a too-deep folder was placed in at the limit (capFolderPath), by
  // id — a list found again by another row counts once.
  private readonly flattenedIds = new Set<string>();
  readonly created: CreatedEntity<List>[] = [];
  private readonly now: number;
  private readonly newId: () => string;

  constructor(lists: ResolverNode[], now: number, newId: () => string) {
    this.now = now;
    this.newId = newId;
    for (const list of lists) {
      const siblings = this.childrenOf.get(list.parentId) ?? [];
      siblings.push(list);
      this.childrenOf.set(list.parentId, siblings);
    }
    for (const siblings of this.childrenOf.values()) siblings.sort(compareRank);
  }

  // Lists that hold a folder from deeper than TREE_MAX_DEPTH, placed at it.
  get flattenedCount(): number {
    return this.flattenedIds.size;
  }

  // The list id for one root-first folder chain; [] → the default list. A chain
  // past TREE_MAX_DEPTH files the row's own folder at that level, as a child of
  // the level-(TREE_MAX_DEPTH - 1) list (capFolderPath, above).
  resolve(folderPath: string[]): string {
    if (folderPath.length === 0) return MY_LIST_ID;
    const path = capFolderPath(folderPath);
    const memoKey = path.join('\u0000');
    const memoized = this.resolved.get(memoKey);
    if (memoized !== undefined) return memoized;

    let parentId: string | null = null;
    let listId = MY_LIST_ID;
    // The parent of the level-TREE_MAX_DEPTH list — where a deeper folder goes.
    let parentAtLimit: string | null = null;
    for (let level = 1; level <= path.length; level++) {
      if (level === TREE_MAX_DEPTH) parentAtLimit = parentId;
      if (level > TREE_MAX_DEPTH) parentId = parentAtLimit;
      listId = this.findOrCreate(parentId, path[level - 1]);
      if (level > TREE_MAX_DEPTH) this.flattenedIds.add(listId);
      parentId = listId;
    }
    this.resolved.set(memoKey, listId);
    return listId;
  }

  // A name past LIST_NAME_MAX is cut there, as the editors cut one, and matched
  // as cut — so two long folder names that share their first LIST_NAME_MAX
  // characters under one parent become one list.
  private findOrCreate(parentId: string | null, segment: string): string {
    const siblings = this.childrenOf.get(parentId) ?? [];
    this.childrenOf.set(parentId, siblings);
    const name = cleanName(segment, LIST_NAME_MAX);
    const wanted = name.toLowerCase();
    // Trash is excluded from matching — a folder named "Trash" becomes a
    // regular list rather than mapping links into deletion staging.
    const match = siblings.find(
      (list) => list.id !== TRASH_ID && list.name.trim().toLowerCase() === wanted,
    );
    if (match) return match.id;
    const list: List = {
      id: this.newId(),
      name,
      parentId,
      rank: rankForIndex(siblings, siblings.length),
      createdAt: this.now,
      updatedAt: this.now,
    };
    this.created.push({ path: pathFromId(list.id, LISTS_PREFIX), data: list });
    siblings.push({ id: list.id, name: list.name, rank: list.rank });
    return list.id;
  }
}

// Find-or-create tags by case-insensitive name. New tags are root-level,
// appended after the existing root siblings in rank order.
export class TagResolver {
  private idByName = new Map<string, string>();
  private rootSiblings: { id: string; rank: string }[];
  readonly created: CreatedEntity<Tag>[] = [];
  private readonly now: number;
  private readonly newId: () => string;

  constructor(tags: ResolverNode[], now: number, newId: () => string) {
    this.now = now;
    this.newId = newId;
    for (const tag of tags) this.idByName.set(tag.name.trim().toLowerCase(), tag.id);
    this.rootSiblings = tags.filter((tag) => tag.parentId === null).sort(compareRank);
  }

  // The tag ids for one row's names, in the file's order: at most LINK_TAGS_MAX
  // of them (entities.ts), the first ones, and no tag minted for a name past
  // that. A name past TAG_NAME_MAX is cut there and matched as cut.
  resolve(names: string[]): string[] {
    const ids: string[] = [];
    for (const raw of names) {
      if (ids.length === LINK_TAGS_MAX) break;
      const name = cleanName(raw, TAG_NAME_MAX);
      const wanted = name.toLowerCase();
      if (wanted === '') continue;
      let id = this.idByName.get(wanted);
      if (id === undefined) {
        const tag: Tag = {
          id: this.newId(),
          name,
          parentId: null,
          rank: rankForIndex(this.rootSiblings, this.rootSiblings.length),
          createdAt: this.now,
          updatedAt: this.now,
        };
        this.created.push({ path: pathFromId(tag.id, TAGS_PREFIX), data: tag });
        this.rootSiblings.push({ id: tag.id, rank: tag.rank });
        this.idByName.set(wanted, tag.id);
        id = tag.id;
      }
      // A link's tag set — repeated names in one row collapse.
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }
}
