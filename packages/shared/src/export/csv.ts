import type { ExportBundle, ExportFolder } from './bundle';

// CSV serializer targeting Raindrop.io's import (its documented columns:
// url/folder/title/note/tags/created) — and any spreadsheet. Preferred over
// Netscape HTML for Raindrop because it carries the link's `note`, which HTML
// has no slot for. `folder` is the slash-joined list path ("Parent/Child" —
// Raindrop recreates it as nested collections), `tags` are comma-joined names
// inside one quoted cell, `created` is ISO 8601. RFC 4180 quoting with CRLF row
// separators (the RFC's convention, and what Excel expects).

const HEADER = ['url', 'folder', 'title', 'note', 'tags', 'created'];

// Quote only when needed; a quote inside a quoted field doubles.
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function pushFolder(folder: ExportFolder, parentPath: string, out: string[]): void {
  const path = parentPath === '' ? folder.name : `${parentPath}/${folder.name}`;
  for (const link of folder.links) {
    const row = [
      link.url,
      path,
      link.title,
      link.note ?? '',
      link.tagNames.join(','),
      new Date(link.createdAt).toISOString(),
    ];
    out.push(row.map(field).join(','));
  }
  for (const child of folder.children) pushFolder(child, path, out);
}

export function toRaindropCsv(bundle: ExportBundle): string {
  const out = [HEADER.join(',')];
  for (const folder of bundle.folders) pushFolder(folder, '', out);
  return out.join('\r\n') + '\r\n';
}
