import type { ImportedLink } from '../import/bundle';

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
// It has a second producer: the marketing site's bookmark converter builds one
// from parsed files (`bundleFromImported` below), so the same serializers write
// its downloads. That caller is why the dates and `rootLinks` are optional — the
// app's own snapshot always has dates and puts every link in a list.

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
