// `expect/build/matchers` — a deep import that jest 30 no longer ships.
//
// expo-router's testing-library (`expo-router/testing-library`, the home of
// `renderRouter`) reaches for it to build its own matchers — toHavePathname,
// toHaveSearchParams and friends, each of which just delegates to `toEqual`.
// The require throws before any of that module's exports are reachable, so
// without this mapping a spec can't use `renderRouter` at all.
//
// This is a real implementation, not a stub that always passes: it reuses the
// public `expect` (a global inside a test env, hence the lazy reference) and
// converts a thrown assertion into the {pass, message} shape a matcher returns,
// so expo-router's matchers report honestly if a spec ever uses one.
const matchers = {
  // expo-router assigns to this on import (`matchers.customTesters = []`).
  customTesters: [],
  toEqual(received, expected) {
    try {
      expect(received).toEqual(expected);
      return { pass: true, message: () => 'expected values not to be equal' };
    } catch (error) {
      return { pass: false, message: () => error.message };
    }
  },
};

module.exports = matchers;
// Read through esModule interop (`__importDefault`), so both spellings resolve.
module.exports.default = matchers;
