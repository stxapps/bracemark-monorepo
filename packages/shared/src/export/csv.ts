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

function pushLinks(links: ExportLinkRow[], path: string, out: string[], safe: boolean): void {
  for (const link of links) {
    const row = [
      link.url,
      path,
      link.title,
      link.note ?? '',
      link.tagNames.join(','),
      link.createdAt === undefined ? '' : new Date(link.createdAt).toISOString(),
    ];
    out.push(row.map((value) => cell(value, safe)).join(','));
  }
}

function pushFolder(folder: ExportFolder, parentPath: string, out: string[], safe: boolean): void {
  const path = parentPath === '' ? folder.name : `${parentPath}/${folder.name}`;
  pushLinks(folder.links, path, out, safe);
  for (const child of folder.children) pushFolder(child, path, out, safe);
}

export function toRaindropCsv(
  bundle: ExportBundle,
  options: { spreadsheetSafe?: boolean } = {},
): string {
  const out = [HEADER.join(',')];
  const safe = options.spreadsheetSafe === true;
  pushLinks(bundle.rootLinks ?? [], '', out, safe);
  for (const folder of bundle.folders) pushFolder(folder, '', out, safe);
  return out.join('\r\n') + '\r\n';
}
