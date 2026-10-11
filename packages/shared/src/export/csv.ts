import { isCalendarTime } from '../sync/calendar-time';
import type { ExportBundle, ExportFolder, ExportLinkRow } from './bundle';

// CSV serializer targeting Raindrop.io's import (its documented columns:
// url/folder/title/note/tags/created) — and any spreadsheet. Preferred over
// the app’s default HTML export for Raindrop because it carries the link’s
// `note` (HTML descriptions are opt-in for the standalone converter). `folder` is the slash-joined list path ("Parent/Child" —
// Raindrop recreates it as nested collections), `tags` are comma-joined names
// inside one quoted cell, `created` is ISO 8601. RFC 4180 quoting with CRLF row
// separators (the RFC's convention, and what Excel expects).

const HEADER = ['url', 'folder', 'title', 'note', 'tags', 'created'];

// Quote only when needed; a quote inside a quoted field doubles.
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// Opt in for spreadsheet downloads; app-to-app exports keep their existing cells.
function cell(value: string, spreadsheetSafe: boolean): string {
  return field(spreadsheetSafe && /^[\s]*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value);
}

// The `created` cell: ISO 8601, or empty when the link has no date — or has one
// the calendar cannot name (sync/calendar-time.ts), for which `toISOString`
// throws. A stored link can carry such a value from before the import edges
// refused it, or from another device, and one of them must cost the export one
// empty cell, not the whole file.
function created(createdAt: number | undefined): string {
  if (createdAt === undefined || !isCalendarTime(createdAt)) return '';
  return new Date(createdAt).toISOString();
}

function pushLinks(links: ExportLinkRow[], path: string, out: string[], safe: boolean): void {
  for (const link of links) {
    const row = [
      link.url,
      path,
      link.title,
      link.note ?? '',
      link.tagNames.join(','),
      created(link.createdAt),
    ];
    out.push(row.map((value) => cell(value, safe)).join(','));
  }
}

// Folders are walked with an explicit stack, parents before children and
// siblings in order: a list tree is as deep as its `parentId` chain, which a
// backup or another device can make deeper than the call stack.
function pushFolders(folders: ExportFolder[], out: string[], safe: boolean): void {
  const pending: { folder: ExportFolder; parentPath: string }[] = [];
  for (let i = folders.length - 1; i >= 0; i--)
    pending.push({ folder: folders[i], parentPath: '' });
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { folder, parentPath } = next;
    const path = parentPath === '' ? folder.name : `${parentPath}/${folder.name}`;
    pushLinks(folder.links, path, out, safe);
    for (let i = folder.children.length - 1; i >= 0; i--) {
      pending.push({ folder: folder.children[i], parentPath: path });
    }
  }
}

export function toRaindropCsv(
  bundle: ExportBundle,
  options: { spreadsheetSafe?: boolean } = {},
): string {
  const out = [HEADER.join(',')];
  const safe = options.spreadsheetSafe === true;
  pushLinks(bundle.rootLinks ?? [], '', out, safe);
  pushFolders(bundle.folders, out, safe);
  return out.join('\r\n') + '\r\n';
}
