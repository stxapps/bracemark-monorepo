import { describe, expect, it } from 'vitest';

import { stripUserPrefix, userFileKey, userPrefix } from './keys';

// The whole cross-user authorization check reduces to "validate the relative
// shape (the contract's syncPathSchema), then prefix (here)" — so these three
// string functions are load-bearing rather than trivial. The route specs prove
// a caller can't read a neighbor's objects; what they can't show is the pair of
// edges that would make that possible without any test going red.
describe('r2 keys', () => {
  it('namespaces a wire-relative path under the user’s prefix', () => {
    expect(userFileKey('u1', 'links/l_abc.enc')).toBe('users/u1/links/l_abc.enc');
    expect(userPrefix('u1')).toBe('users/u1/');
  });

  // The trailing slash is what makes the prefix a boundary rather than a string
  // match: without it, `users/u1` also matches `users/u10/…`, and one user's
  // listing would serve another's objects.
  it('does not let one user id prefix-match another’s', () => {
    expect(userFileKey('u10', 'a.enc').startsWith(userPrefix('u1'))).toBe(false);
    expect(stripUserPrefix('u1', userFileKey('u10', 'a.enc'))).toBeNull();
  });

  it('round-trips a path through the prefix', () => {
    for (const path of ['links/l_abc.enc', 'files/img.enc', 'settings.enc', 'a/b/c/d.enc']) {
      expect(stripUserPrefix('u1', userFileKey('u1', path))).toBe(path);
    }
  });

  // The defensive arm: a key that isn't under the prefix is skipped by the
  // listing, never served as a relative path (which would name someone else's
  // object to the client as if it were its own).
  it('returns null for a key outside the prefix', () => {
    expect(stripUserPrefix('u1', 'users/u2/links/a.enc')).toBeNull();
    expect(stripUserPrefix('u1', 'links/a.enc')).toBeNull();
    expect(stripUserPrefix('u1', '')).toBeNull();
  });
});
