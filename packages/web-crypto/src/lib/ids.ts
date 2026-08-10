// ID helpers. Uses the Web Crypto API (`crypto.*`), a global in the browser —
// no imports needed. Lives here in @stxapps/web-crypto (the platform:web crypto
// home) rather than in @stxapps/shared, which is platform:agnostic and
// deliberately avoids runtime crypto globals. bracemark-api keeps its own copy
// (apps/bracemark-api/src/lib/ids.ts) because it's platform:worker and can't import
// this platform:web package — both mint ids the same way.

// A random, collision-resistant id for new entities (lists, links, tags). UUID
// v4 is plenty for client-minted ids; we don't need sortable/k-ordered ids.
export function newId(): string {
  return crypto.randomUUID();
}
