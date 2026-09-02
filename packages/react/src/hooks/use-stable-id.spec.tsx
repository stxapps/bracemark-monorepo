import { renderHook } from '@testing-library/react';

import { useStableId } from './use-stable-id';

// What this hook buys is the NORMALISATION: React's useId format is opaque and has
// already moved once (18's `:r0:` → 19's `«r0»`), so any assertion phrased against
// one version's delimiters passes vacuously under the other — which is exactly how
// the colon-only version of this line survived as dead code. These assert the
// property instead: whatever React emits, the result is spendable unescaped as an
// HTML `id`, a CSS selector and a URI fragment, and is still unique per instance.
describe('useStableId', () => {
  it('yields only characters that need no escaping in an id, a selector or a fragment', () => {
    const { result } = renderHook(() => useStableId());
    expect(result.current).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps the prefix readable and the id still escape-free', () => {
    const { result } = renderHook(() => useStableId('ffx'));
    expect(result.current).toMatch(/^ffx-[A-Za-z0-9_-]+$/);
  });

  // The counter React varies has to survive the strip. A char class that took too
  // much (digits, say) would collapse `«r0»` and `«r1»` onto the same string, and
  // the symptom is two SVGs on one page sharing a gradient — the second icon
  // silently wearing the first one's colours, with no error anywhere.
  it('stays unique across instances', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) seen.add(renderHook(() => useStableId('ffx')).result.current);
    expect(seen.size).toBe(8);
  });
});
