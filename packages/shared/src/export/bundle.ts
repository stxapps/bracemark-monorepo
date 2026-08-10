// The decoded, policy-filtered snapshot the interop export serializers consume
// (netscape.ts / csv.ts / text.ts — the "export all data" formats other apps
// import). Pure data, no Dexie/React: the gathering — reading the local store,
// dropping locked/Trash links, resolving titles and tag names — happens in the
// client's export orchestrator (web-react data/export-all-data.ts); by the time
// a bundle reaches a serializer every policy decision is already made, so the
// serializers stay pure `(bundle) => string` functions any platform (web today,
// Expo later) can reuse. The Bracemark-backup zip does NOT go through this: it
// round-trips raw entities per path, not this display-resolved projection.

// One link, display-resolved: `title` is the resolved display title
// (`customTitle ?? extraction.title ?? host(url)` — the gatherer applies the
// same override-wins rule the link views use), `tagNames` are resolved names in
// the link's tag order (dangling tag ids already dropped). Timestamps are epoch
// ms like everywhere else in the sync system; serializers convert to their
// format's convention (Netscape seconds, CSV ISO 8601).
export interface ExportLinkRow {
  url: string;
  title: string;
  note?: string;
  tagNames: string[];
  createdAt: number;
  updatedAt: number;
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

export interface ExportBundle {
  folders: ExportFolder[];
  exportedAt: number;
}
