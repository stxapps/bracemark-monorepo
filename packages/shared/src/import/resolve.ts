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

import type { List, Tag } from '../sync/entities';
import { LISTS_PREFIX, pathFromId, TAGS_PREFIX } from '../sync/paths';
import { compareRank, rankForIndex } from '../sync/rank';
import { MY_LIST_ID, TRASH_ID } from '../sync/system-lists';

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

export class ListResolver {
  private childrenOf = new Map<string | null, { id: string; name: string; rank: string }[]>();
  private resolved = new Map<string, string>();
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

  // The list id for one root-first folder chain; [] → the default list.
  resolve(folderPath: string[]): string {
    if (folderPath.length === 0) return MY_LIST_ID;
    const memoKey = folderPath.join('\u0000');
    const memoized = this.resolved.get(memoKey);
    if (memoized !== undefined) return memoized;

    let parentId: string | null = null;
    let listId = MY_LIST_ID;
    for (const segment of folderPath) {
      const siblings = this.childrenOf.get(parentId) ?? [];
      this.childrenOf.set(parentId, siblings);
      const wanted = segment.toLowerCase();
      // Trash is excluded from matching — a folder named "Trash" becomes a
      // regular list rather than mapping links into deletion staging.
      const match = siblings.find(
        (list) => list.id !== TRASH_ID && list.name.trim().toLowerCase() === wanted,
      );
      if (match) {
        listId = match.id;
      } else {
        const list: List = {
          id: this.newId(),
          name: segment,
          parentId,
          rank: rankForIndex(siblings, siblings.length),
          createdAt: this.now,
          updatedAt: this.now,
        };
        this.created.push({ path: pathFromId(list.id, LISTS_PREFIX), data: list });
        siblings.push({ id: list.id, name: list.name, rank: list.rank });
        listId = list.id;
      }
      parentId = listId;
    }
    this.resolved.set(memoKey, listId);
    return listId;
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

  // The tag ids for one row's names, in the file's order.
  resolve(names: string[]): string[] {
    const ids: string[] = [];
    for (const name of names) {
      const wanted = name.trim().toLowerCase();
      if (wanted === '') continue;
      let id = this.idByName.get(wanted);
      if (id === undefined) {
        const tag: Tag = {
          id: this.newId(),
          name: name.trim(),
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
