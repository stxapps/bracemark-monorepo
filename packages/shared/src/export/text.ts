import type { ExportBundle, ExportFolder } from './bundle';

// Plain-text serializer — just the URLs, one per line, in the bundle's walk
// order (each folder's links newest-first, then its subfolders). The
// lowest-common-denominator export: opens in any editor, pastes anywhere.

export function toUrlText(bundle: ExportBundle): string {
  const out: string[] = (bundle.rootLinks ?? []).map((link) => link.url);
  // An explicit stack, not recursion: the tree is as deep as the library's
  // `parentId` chain (see csv.ts).
  const pending: ExportFolder[] = bundle.folders.slice().reverse();
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const link of folder.links) out.push(link.url);
    for (let i = folder.children.length - 1; i >= 0; i--) pending.push(folder.children[i]);
  }
  return out.length === 0 ? '' : out.join('\n') + '\n';
}
