// `newId` looks like a one-line delegation, and the one line that matters is the
// one you can't see: the require is LAZY on purpose.
//
// `newId` is all the iOS share extension needs from this package on its cold
// path, and that process is re-created on every share. A static import would put
// quick-crypto's ~390KB of JS — plus readable-stream, buffer and nitro-modules —
// into the boot of every single share (docs/share-sheet.md, _keep
// index.share.js lean_). "Tidying" the require back to a top-level import
// changes no behaviour, passes lint, passes typecheck, and passes every other
// spec in this package; it just makes the share sheet slower to appear, on a
// device, in a way nobody attributes to this file. That is what the first test
// below is for.
//
// The second half — the memoization — is why bulk import can mint ids in a loop
// without a module lookup per id.
//
// quick-crypto is shimmed onto node:crypto under jest (see ../testing); this
// counts how many times that module is EVALUATED, which is the cost the share
// path is avoiding.
const mockLoads = { count: 0 };

jest.mock('react-native-quick-crypto', () => {
  mockLoads.count += 1;
  return jest.requireActual('react-native-quick-crypto');
});

// 8-4-4-4-12 lowercase hex, version nibble 4, variant nibble 8|9|a|b.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A fresh module registry per test: the memoized `randomUUID` is module-level
// state, so a shared instance would make "not loaded yet" untestable after the
// first call anywhere.
const freshIds = async () => {
  jest.resetModules();
  mockLoads.count = 0;
  return import('./ids');
};

it('does NOT pull quick-crypto in at import time — the share extension’s cold path', async () => {
  await freshIds();
  expect(mockLoads.count).toBe(0);
});

it('loads it on the first call, and never again (bulk import mints ids in a loop)', async () => {
  const { newId } = await freshIds();

  newId();
  expect(mockLoads.count).toBe(1);

  for (let i = 0; i < 100; i++) newId();
  expect(mockLoads.count).toBe(1);
});

it('mints a random (v4) UUID, the same form every other platform’s newId does', async () => {
  // Ids minted here share sync paths and R2 object keys with ids minted by
  // web-crypto's newId and by bracemark-api's own copy — three implementations
  // that must keep producing one shape, and the id is opaque everywhere it is
  // consumed, so a divergence would surface as nothing at all.
  const { newId } = await freshIds();
  expect(newId()).toMatch(UUID_V4);
});

it('does not repeat itself', async () => {
  const { newId } = await freshIds();
  const ids = new Set(Array.from({ length: 1000 }, newId));
  expect(ids.size).toBe(1000);
});
