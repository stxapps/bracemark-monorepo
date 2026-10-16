import type { ImportedLink } from '../import/bundle';
import type { Extraction, Link, Tag } from '../sync/entities';
import type { ListItem } from '../sync/items';
import { LIST_NO_CHILDREN_IDS, MY_LIST_ID, TRASH_ID } from '../sync/system-lists';
import { buildTree, TREE_MAX_DEPTH, type TreeNode } from '../sync/tree';
import { hostFromText } from '../url/url';

// The decoded, policy-filtered snapshot the interop export serializers consume
// (netscape.ts / csv.ts / text.ts — the "export all data" formats other apps
// import). Pure data, no Dexie/React: the gathering — reading the local store,
// dropping locked/Trash links, resolving titles and tag names — happens in the
// client's export orchestrator (web-react data/export-all-data.ts); by the time
// a bundle reaches a serializer every policy decision is already made, so the
// serializers stay pure `(bundle) => string` functions any platform (web today,
// Expo later) can reuse. The Bracemark-backup zip does NOT go through this: it
// round-trips raw entities per path, not this display-resolved projection.
//
// Two builders below. `bundleFromLibrary` is the app's snapshot — both
// platforms' export orchestrators call it with what they gathered, and the
// marketing site's bookmark converter calls it with what a Bracemark backup
// holds, so a converted backup and an in-app export are the same file.
// `bundleFromImported` is the converter's other road in, from parsed files. That
// one is why the dates and `rootLinks` are optional — the app's own snapshot
// always has dates and puts every link in a list.

// One link, display-resolved: `title` is the resolved display title
// (`customTitle ?? extraction.title ?? host(url)` — the gatherer applies the
// same override-wins rule the link views use), `tagNames` are resolved names in
// the link's tag order (dangling tag ids already dropped). Timestamps are epoch
// ms like everywhere else in the sync system; serializers convert to their
// format's convention (Netscape seconds, CSV ISO 8601). A converted file can
// lack them, and serializers omit an absent date rather than invent the day of
// conversion.
export interface ExportLinkRow {
  url: string;
  title: string;
  note?: string;
  tagNames: string[];
  createdAt?: number;
  updatedAt?: number;
}

// One list as a folder: its links (newest first — the app's display order) and
// its child folders in sidebar (rank) order. Locked subtrees and Trash never
// appear (pruned by the gatherer); empty folders DO — an importer recreating the
// user's structure is a feature, not noise.
export interface ExportFolder {
  name: string;
  links: ExportLinkRow[];
  children: ExportFolder[];
}

// `rootLinks` are links outside any folder, written before the folders.
export interface ExportBundle {
  folders: ExportFolder[];
  rootLinks?: ExportLinkRow[];
  exportedAt?: number;
}

// The deepest folder a serializer writes is the tree's own limit,
// TREE_MAX_DEPTH (sync/tree.ts), so every file this app exports places its
// folders where its own import would. A folder deeper than this is written at
// this level, beside its parent's other children rather than inside them: under
// its own name, holding its own links, so only the nesting below level 100 is
// flattened. Its descendants follow it at the same level.
//
// Nesting is not just memory here, it is the file's size. Every CSV row repeats
// its folder's whole path and every Netscape line is indented by its folder's
// depth, so an unbounded chain made the output grow with the square of its
// depth: 10,000 nested lists made a file past V8's longest string, and the
// export failed with `RangeError: Invalid string length` instead of saving
// anything. The editors no longer build such a chain, but sync can still
// deliver one, and a library can hold one from before the limit
// (docs/data-limits.md).

// Every folder in the tree with its root-first path, parents before children and
// siblings in order — the order the serializers write. Walked with an explicit
// stack, not recursion: the tree is as deep as the library's `parentId` chain,
// which a backup or another device can make deeper than the call stack. No path
// is longer than TREE_MAX_DEPTH: a folder at that depth hands its
// children its parent's path, not its own, so they come out as its siblings.
export function foldersWithPaths(
  folders: ExportFolder[],
): { folder: ExportFolder; path: string[] }[] {
  const out: { folder: ExportFolder; path: string[] }[] = [];
  const pending: { folder: ExportFolder; parent: string[] }[] = [];
  for (let i = folders.length - 1; i >= 0; i--) pending.push({ folder: folders[i], parent: [] });
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const path = [...next.parent, next.folder.name];
    out.push({ folder: next.folder, path });
    const below = path.length < TREE_MAX_DEPTH ? path : next.parent;
    const { children } = next.folder;
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push({ folder: children[i], parent: below });
    }
  }
  return out;
}

// How many folders sit deeper than TREE_MAX_DEPTH and so are written at
// that level instead. The export's receipt reports it; nothing about the file
// depends on it.
export function foldersPastMaxDepth(folders: ExportFolder[]): number {
  let count = 0;
  const pending: { folder: ExportFolder; depth: number }[] = folders.map((folder) => ({
    folder,
    depth: 1,
  }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.depth > TREE_MAX_DEPTH) count += 1;
    for (const child of next.folder.children)
      pending.push({ folder: child, depth: next.depth + 1 });
  }
  return count;
}

function exportRow(link: ImportedLink): ExportLinkRow {
  return {
    url: link.url,
    title: link.customTitle ?? link.title ?? link.url,
    tagNames: link.tagNames,
    ...(link.note === undefined ? {} : { note: link.note }),
    ...(link.createdAt === undefined ? {} : { createdAt: link.createdAt }),
    ...(link.updatedAt === undefined ? {} : { updatedAt: link.updatedAt }),
  };
}

// Parsed import rows → the serializers' tree, so any import format can be
// written as any export format. `paths` are folder chains to create even when
// no link lands in them (a source's empty folders); folders appear in the order
// their paths are first seen, links under their `folderPath` in row order, and
// a link with an empty path goes to `rootLinks`. The display title follows the
// app's override-wins rule, falling back to the address. Import-only signal
// (`systemList`, `pinRank`, `imageRef`) has no field here — the caller decides
// what, if anything, it becomes first.
export function bundleFromImported(links: ImportedLink[], paths: string[][] = []): ExportBundle {
  const rootLinks: ExportLinkRow[] = [];
  const bundle: ExportBundle = { folders: [], rootLinks };
  const folders = new Map<string, ExportFolder>();
  function ensure(path: string[]): ExportFolder | undefined {
    let siblings = bundle.folders;
    let folder: ExportFolder | undefined;
    for (let length = 1; length <= path.length; length++) {
      const key = JSON.stringify(path.slice(0, length));
      folder = folders.get(key);
      if (!folder) {
        folder = { name: path[length - 1], links: [], children: [] };
        folders.set(key, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    return folder;
  }
  for (const path of paths) ensure(path);
  for (const link of links) (ensure(link.folderPath)?.links ?? rootLinks).push(exportRow(link));
  return bundle;
}

// One link with its co-keyed extraction (the writer-split shadow that holds the
// extracted title), both decoded.
export interface LibraryLink {
  link: Link;
  extraction: Extraction | undefined;
}

// The library → the serializers' tree: the list tree minus Trash, each folder's
// links display-resolved (title override-wins, tag ids → names) in the order
// given — callers pass newest first, the app's display order. `lists` is the
// MERGED set (mergeSystemLists), already without any locked subtree; a link
// whose list is absent files under My List (a dangling ref — the list was
// deleted on another device), unless My List itself is absent, in which case
// it has no unlocked home and drops like its list's other links. Trash links
// never appear: importing deleted-pending links into a browser as live
// bookmarks is never wanted (docs/data-lifecycle.md, _export_).
export function bundleFromLibrary(
  links: readonly LibraryLink[],
  lists: ListItem[],
  tags: Tag[],
): ExportBundle {
  const visibleLists = lists.filter((list) => list.id !== TRASH_ID);
  const tree = buildTree(visibleLists, { noChildrenIds: LIST_NO_CHILDREN_IDS });
  const listIds = new Set(visibleLists.map((list) => list.id));
  const tagNameById = new Map(tags.map((tag) => [tag.id, tag.name]));

  const rowsByListId = new Map<string, ExportLinkRow[]>();
  for (const { link, extraction } of links) {
    if (link.listId === TRASH_ID) continue;
    const listId = listIds.has(link.listId) ? link.listId : MY_LIST_ID;
    if (!listIds.has(listId)) continue;

    const row: ExportLinkRow = {
      url: link.url,
      title: link.customTitle ?? extraction?.title ?? hostFromText(link.url),
      tagNames: link.tagIds
        .map((id) => tagNameById.get(id))
        .filter((name): name is string => name !== undefined),
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    };
    if (link.note !== undefined) row.note = link.note;

    const rows = rowsByListId.get(listId);
    if (rows) rows.push(row);
    else rowsByListId.set(listId, [row]);
  }

  // Tree → folders with an explicit stack, not `children.map(toFolder)`: the
  // tree is as deep as the library's `parentId` chain (sync/tree.ts).
  const folders: ExportFolder[] = [];
  const pending: { nodes: TreeNode<ListItem>[]; into: ExportFolder[] }[] = [
    { nodes: tree, into: folders },
  ];
  for (let group = pending.pop(); group !== undefined; group = pending.pop()) {
    for (const node of group.nodes) {
      const folder: ExportFolder = {
        name: node.item.name,
        links: rowsByListId.get(node.item.id) ?? [],
        children: [],
      };
      group.into.push(folder);
      if (node.children.length > 0) pending.push({ nodes: node.children, into: folder.children });
    }
  }
  return { folders };
}
