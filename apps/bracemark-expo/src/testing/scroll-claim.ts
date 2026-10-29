// The structural half of components/ui/scroll-claim.tsx's rule, for the specs of
// the surfaces that wrap a scroller in a touch claimant. jest has no native
// scroll view, so the dead iOS drag itself cannot be reproduced here. What can
// be pinned is its cause. Walk up from a node that claims no touch of its own
// (a label, an alert's description) the way the responder system bubbles, and
// the first host node that would claim the touch must come BEFORE the scroller.
// If the scroller comes first, the claimant is an ancestor of it, and on iOS
// the drag starting on `node` does not scroll.
//
// RNTL's `fireEvent` cannot stand in for this: it walks up for the nearest
// handler too, but it reports the press, not where the responder ended up.

// The slice of RNTL's element (react-test-renderer's ReactTestInstance, whose
// package ships no types here) that the walk reads.
type TestNode = { type: unknown; props: Record<string, unknown>; parent: TestNode | null };

const isScroller = (n: TestNode) => typeof n.type === 'string' && /ScrollView$/.test(n.type);

function claims(n: TestNode): boolean {
  if (typeof n.type !== 'string') return false;
  const handler = n.props.onStartShouldSetResponder as ((e: unknown) => boolean) | undefined;
  return handler?.({ nativeEvent: { touches: [] } }) === true;
}

/**
 * Where a touch on `node` is claimed, relative to the nearest scroller above
 * it: `'inside'` (the scroller still scrolls), `'ancestor'` (it doesn't on
 * iOS), `'none'` (nothing claims it), or `'no-scroller'` (the spec pointed at
 * a node no scroller contains, which would make `'inside'` vacuous).
 */
export function touchClaim(node: TestNode): 'inside' | 'ancestor' | 'none' | 'no-scroller' {
  let claimed = false;
  for (let n: TestNode | null = node; n; n = n.parent) {
    claimed ||= claims(n);
    if (isScroller(n)) return claimed ? 'inside' : hasClaimantAbove(n) ? 'ancestor' : 'none';
  }
  return 'no-scroller';
}

function hasClaimantAbove(scroller: TestNode): boolean {
  for (let n = scroller.parent; n; n = n.parent) if (claims(n)) return true;
  return false;
}
