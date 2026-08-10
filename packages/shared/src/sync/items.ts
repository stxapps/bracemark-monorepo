// A decoded entity joined to its storage PATH — the read-layer bundle that sits
// between the two files it's built from: the plaintext shapes (entities.ts) and
// the path↔id math (paths.ts). Kept OUT of entities.ts on purpose: that file is
// scoped to the plaintext INSIDE the ciphertext (what's encrypted), whereas `path`
// is the opposite — the storage key, infrastructure the server assigns, never part
// of the plaintext. This is a cross-platform contract like the shapes themselves:
// every client decodes a blob keyed by a path, so the "entity + where it lives"
// bundle lives here in `shared`, not in any one app's read layer.

import type { Extraction, Link, List, Pin, Tag } from './entities';
import { idFromPath, LINKS_PREFIX } from './paths';

// A parsed entity always carries its source `items` path — the stable id every
// other layer (op log, pending queue, R2) keys by, and what the UI needs to
// select/edit/delete a row without a second lookup.
export type WithPath<T> = T & { path: string };
export type LinkItem = WithPath<Link>;
export type ListItem = WithPath<List>;
export type TagItem = WithPath<Tag>;
export type PinItem = WithPath<Pin>;
export type ExtractionItem = WithPath<Extraction>;

// A link's id is the `{id}` of its `links/{id}.enc` path. Derive it from the stored
// path (the only authority for identity — never the plaintext `id` copy) so callers
// pass a LinkItem and nothing reconstructs ids by hand. The one home for links; the
// pin/extraction shadows are built by rekeying this same path (see sync/paths.ts).
export function linkIdOf(link: LinkItem): string {
  return idFromPath(link.path, LINKS_PREFIX);
}
