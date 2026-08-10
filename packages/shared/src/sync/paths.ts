// The `items` / R2 key namespaces — the storage path contract every client and
// the API agree on. One decrypted blob per path; the prefix TYPES the blob (see
// docs/local-first-sync.md "plaintext typing" and the schemas in entities.ts). A
// path is `{namespace}{id}.enc` — except `settings/`, keyed by concern name
// rather than an id (`settings/<concern>.enc`).
//
// These live in `shared` so the server (bracemark-api), the web read layer, and a
// future native client all reference ONE definition instead of hardcoding
// 'links/' / 'files/' literals that can silently drift apart.
//
// The trailing slash is part of each constant: it's what makes a key-range
// `startsWith` scan exact (no `metaX/` bleed) and a path unambiguously
// namespace-prefixed.

// The always-resident link index — `links/{id}.enc` (one link per blob).
export const LINKS_PREFIX = 'links/';
// User lists — `lists/{id}.enc`.
export const LISTS_PREFIX = 'lists/';
// User tags — `tags/{id}.enc`.
export const TAGS_PREFIX = 'tags/';
// Media/content blobs fetched LAZILY — `files/{id}.enc`: the preview image (the
// one such blob the free tier stores) plus the heavier saved page copy / screenshot.
// All opaque to the server, so the byte/count quota — not a per-namespace gate —
// is what bounds them (see apps/bracemark-api/src/lib/quota.ts, docs/iap.md).
export const FILES_PREFIX = 'files/';
// Pinned-link markers — `pins/{id}.enc`, where `{id}` is the pinned link's id (so
// `pins/{id}.enc` shadows `links/{id}.enc`). One small file per pinned link.
export const PINS_PREFIX = 'pins/';
// The MACHINE half of a link — `extractions/{id}.enc`, where `{id}` is the link's id
// (so `extractions/{id}.enc` shadows `links/{id}.enc`). One file per link holding BOTH
// the extracted display result (title, imageId, pageCopyId, screenshotId) AND the
// per-facet automated bookkeeping (status/extractedBy/retry). Split BY WRITER from the
// user-authored `links/{id}.enc`, so a background extractor writes only this file and
// never clobbers a concurrent user edit under file-level LWW (see link-extraction.md).
export const EXTRACTIONS_PREFIX = 'extractions/';
// Concern-scoped settings — `settings/<concern>.enc`.
export const SETTINGS_PREFIX = 'settings/';

// The encrypted-blob suffix every path ends with.
export const ENC_SUFFIX = '.enc';

// The bare `{id}` of an id-keyed path — `idFromPath('links/abc.enc', LINKS_PREFIX)`
// → `'abc'`. The inverse of building `{prefix}{id}.enc`: strip the namespace prefix
// and the `.enc` suffix. The ONE home for this slice math, so every read edge (and
// any writer that holds a path) derives an id the same way — and, crucially, derives
// it from the PATH, the only authority for identity. An entity's plaintext `id` copy
// (tags/lists/pins/extractions carry one) is a redundant convenience that a loose,
// round-tripped blob could drift on; never trust it for identity, go through here.
// `path` is assumed to be under `prefix` — the caller names the namespace.
export function idFromPath(path: string, prefix: string): string {
  return path.slice(prefix.length, -ENC_SUFFIX.length);
}

// The id-keyed path for a bare `{id}` — `pathFromId('abc', LINKS_PREFIX)` →
// `'links/abc.enc'`. The inverse of `idFromPath` and its housemate, so building and
// parsing the `{prefix}{id}.enc` shape can never drift apart. Use it wherever a layer
// holds a bare entity id (a reference field, a freshly minted id, a pin's link id) and
// needs the `items`/R2 key. Arg order mirrors `idFromPath`: the value first, then the
// namespace prefix.
export function pathFromId(id: string, prefix: string): string {
  return `${prefix}${id}${ENC_SUFFIX}`;
}

// Rekey a path from one id-keyed namespace to its CO-KEYED shadow in another —
// `rekey('links/abc.enc', LINKS_PREFIX, EXTRACTIONS_PREFIX)` → `'extractions/abc.enc'`.
// The writer-split family of namespaces shares one `{id}` across prefixes
// (`extractions/{id}` and `pins/{id}` both shadow `links/{id}`), so mapping between
// the shadows is a pure prefix swap: strip `from`'s prefix to recover the `{id}`,
// then rebuild under `to`. Composes `idFromPath` + `pathFromId` so the swap can't
// drift from the `{prefix}{id}.enc` shape either half builds. `path` is assumed to
// be under `from` — the caller names both namespaces.
export function rekey(path: string, from: string, to: string): string {
  return pathFromId(idFromPath(path, from), to);
}

// The well-known path of the general settings file (`settingsGeneralSchema`). The
// `settings/` family is keyed by a fixed concern name, not a random id, so its
// paths are baked into client code rather than generated — one source of truth so
// the read/write edges can't drift on the literal. (`general` is the first such
// concern; a new concern adds its own `SETTINGS_<NAME>_PATH` const beside this.)
export const SETTINGS_GENERAL_PATH = `${SETTINGS_PREFIX}general${ENC_SUFFIX}`;

// The id-keyed namespaces — every prefix whose path is `{prefix}{randomId}.enc`.
// `settings/` is excluded on purpose: its segment is a fixed lowercase concern
// name, not a random id, so it's validated as its own shape.
//
// `syncPathSchema` (sync/endpoints.ts) BUILDS its wire-validation regex from this
// list instead of re-listing the namespaces as literals — so adding a namespace is
// just: add the `*_PREFIX` const above, add it here, add its entity schema. The
// server gate can't silently drift from the path contract, and `paths.spec.ts`
// fails if a new `*_PREFIX` isn't reachable through validation at all.
export const ID_KEYED_PREFIXES = [
  LINKS_PREFIX,
  LISTS_PREFIX,
  TAGS_PREFIX,
  FILES_PREFIX,
  PINS_PREFIX,
  EXTRACTIONS_PREFIX,
] as const;
