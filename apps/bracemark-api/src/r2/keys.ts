// R2 object-key construction, in one place. Every user's blobs live under a
// per-user prefix in the single USER_FILES bucket; the wire only ever carries the
// path RELATIVE to that prefix (see syncPathSchema in @stxapps/shared). The server
// derives the prefix from the authenticated session and prepends it here, so a
// client can't name another user's object — the whole of the authorization check
// reduces to "validate the relative shape (the schema), then prefix (here)". See
// docs/local-first-sync.md "storage layout" / "authorization & quota".

// The key prefix namespacing a user's objects: `users/{uid}/`. Trailing slash so
// it doubles as the `list({ prefix })` argument for the fallback listing.
export function userPrefix(userId: string): string {
  return `users/${userId}/`;
}

// Full R2 object key for a user's relative path, e.g.
// ('u1', 'links/l_abc.enc') → 'users/u1/links/l_abc.enc'.
export function userFileKey(userId: string, relativePath: string): string {
  return userPrefix(userId) + relativePath;
}

// Inverse of userFileKey for a listing: strip the user's prefix back to the
// relative wire path. Returns null for a key not under the prefix (defensive —
// `list({ prefix })` shouldn't return those, so a non-match is skipped, not served).
export function stripUserPrefix(userId: string, key: string): string | null {
  const prefix = userPrefix(userId);
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}
