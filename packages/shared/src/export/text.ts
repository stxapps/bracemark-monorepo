import type { ExportBundle, ExportFolder } from './bundle';

// Plain-text serializer — just the URLs, one per line, in the bundle's walk
// order (each folder's links newest-first, then its subfolders). The
// lowest-common-denominator export: opens in any editor, pastes anywhere.

function pushFolder(folder: ExportFolder, out: string[]): void {
  for (const link of folder.links) out.push(link.url);
  for (const child of folder.children) pushFolder(child, out);
}

export function toUrlText(bundle: ExportBundle): string {
  const out: string[] = [];
  for (const folder of bundle.folders) pushFolder(folder, out);
  return out.length === 0 ? '' : out.join('\n') + '\n';
}
