import type { ImportedLink } from '../import/bundle';
import type { Extraction, Link, Tag } from '../sync/entities';
import type { ListItem } from '../sync/items';
import { LIST_NO_CHILDREN_IDS, MY_LIST_ID, TRASH_ID } from '../sync/system-lists';
import { buildTree, type TreeNode } from '../sync/tree';
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

  const toFolder = (node: TreeNode<ListItem>): ExportFolder => ({
    name: node.item.name,
    links: rowsByListId.get(node.item.id) ?? [],
    children: node.children.map(toFolder),
  });
  return { folders: tree.map(toFolder) };
}
