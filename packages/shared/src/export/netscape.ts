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

function linkLine(link: ExportLinkRow, indent: string): string {
  const attrs = [
    `HREF="${esc(link.url)}"`,
    `ADD_DATE="${Math.floor(link.createdAt / 1000)}"`,
    `LAST_MODIFIED="${Math.floor(link.updatedAt / 1000)}"`,
  ];
  if (link.tagNames.length > 0) attrs.push(`TAGS="${esc(link.tagNames.join(','))}"`);
  return `${indent}<DT><A ${attrs.join(' ')}>${esc(link.title)}</A>`;
}

function pushFolder(folder: ExportFolder, indent: string, out: string[]): void {
  out.push(`${indent}<DT><H3>${esc(folder.name)}</H3>`);
  out.push(`${indent}<DL><p>`);
  const inner = indent + '    ';
  for (const link of folder.links) out.push(linkLine(link, inner));
  for (const child of folder.children) pushFolder(child, inner, out);
  out.push(`${indent}</DL><p>`);
}

export function toNetscapeHtml(bundle: ExportBundle): string {
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
  for (const folder of bundle.folders) pushFolder(folder, '    ', out);
  out.push('</DL><p>');
  return out.join('\n') + '\n';
}
