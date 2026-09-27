import type { ExportBundle, ExportFolder, ExportLinkRow } from './bundle';

// Netscape Bookmark File serializer — the one interop format everything reads:
// web browsers (Chrome/Firefox/Safari "Import bookmarks"), LinkWarden, and
// Karakeep all accept it, so it's a single serializer behind three of the export
// destinations. Folders come from the list tree (`<H3>` + nested `<DL>`), links
// carry ADD_DATE/LAST_MODIFIED (epoch SECONDS — the format's convention, unlike
// our ms) and the link's tag names in the de-facto TAGS attribute (written by
// Pocket/Pinboard exports; LinkWarden reads it, others ignore it harmlessly).
//
// The file is a "tag soup" format — real-world importers parse it line-wise and
// never expect closing </DT> tags — so the shape below (including the odd
// `<DL><p>` pairs) deliberately mirrors what browsers themselves emit, not what
// an HTML validator would prefer.

// Minimal HTML escape for both text content and double-quoted attribute values.
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkLines(link: ExportLinkRow, indent: string, includeNotes: boolean): string[] {
  const attrs = [`HREF="${esc(link.url)}"`];
  if (link.createdAt !== undefined) attrs.push(`ADD_DATE="${Math.floor(link.createdAt / 1000)}"`);
  if (link.updatedAt !== undefined)
    attrs.push(`LAST_MODIFIED="${Math.floor(link.updatedAt / 1000)}"`);
  if (link.tagNames.length > 0) attrs.push(`TAGS="${esc(link.tagNames.join(','))}"`);
  const lines = [`${indent}<DT><A ${attrs.join(' ')}>${esc(link.title)}</A>`];
  if (includeNotes && link.note) lines.push(`${indent}<DD>${esc(link.note)}`);
  return lines;
}

function pushFolder(
  folder: ExportFolder,
  indent: string,
  out: string[],
  includeNotes: boolean,
): void {
  out.push(`${indent}<DT><H3>${esc(folder.name)}</H3>`);
  out.push(`${indent}<DL><p>`);
  const inner = indent + '    ';
  for (const link of folder.links) out.push(...linkLines(link, inner, includeNotes));
  for (const child of folder.children) pushFolder(child, inner, out, includeNotes);
  out.push(`${indent}</DL><p>`);
}

export function toNetscapeHtml(
  bundle: ExportBundle,
  options: { includeNotes?: boolean } = {},
): string {
  const out: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  for (const link of bundle.rootLinks ?? [])
    out.push(...linkLines(link, '    ', options.includeNotes === true));
  for (const folder of bundle.folders)
    pushFolder(folder, '    ', out, options.includeNotes === true);
  out.push('</DL><p>');
  return out.join('\n') + '\n';
}
