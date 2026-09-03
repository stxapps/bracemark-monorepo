import { act, render } from '@testing-library/react';

import { useMediaQuery } from './use-media-query';

// jsdom implements no `matchMedia` at all, so the hook needs one. This stub is
// deliberately a real registry rather than a `jest.fn()` returning a literal: two
// of the three things asserted below are about SUBSCRIPTION (that a listener is
// added for the current query and dropped for the previous one), which a stub
// with no bookkeeping cannot observe.
type Query = { matches: boolean; listeners: Set<() => void> };
const queries = new Map<string, Query>();

const queryFor = (query: string): Query => {
  let entry = queries.get(query);
  if (!entry) {
    entry = { matches: false, listeners: new Set() };
    queries.set(query, entry);
  }
  return entry;
};

/** Flip a query and fire its `change`, the way a real viewport resize would. */
const setMatches = (query: string, matches: boolean) => {
  const entry = queryFor(query);
  entry.matches = matches;
  act(() => {
    for (const listener of entry.listeners) listener();
  });
};

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => {
      const entry = queryFor(query);
      return {
        media: query,
        get matches() {
          return entry.matches;
        },
        addEventListener: (_: string, listener: () => void) => entry.listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => entry.listeners.delete(listener),
      };
    },
  });
});

beforeEach(() => queries.clear());

// Records the value the hook returned on EVERY render, not just the last one.
// The first entry is the hydration render, which is what the seed rule is about.
function probe(query: string) {
  const seen: boolean[] = [];
  function Probe({ query: q }: { query: string }) {
    seen.push(useMediaQuery(q));
    return null;
  }
  const view = render(<Probe query={query} />);
  return { ...view, seen, rerender: (q: string) => view.rerender(<Probe query={q} />) };
}

describe('useMediaQuery', () => {
  // THE SEED IS THE POINT. `useState(false)` must not be swapped for a lazy
  // initializer that reads `matchMedia` when `window` exists — that initializer
  // also runs on the client's HYDRATION render, so the first client render would
  // disagree with the server HTML for every visitor the query matches. The
  // symptom is a hydration mismatch, not a wrong value, so nothing here fails
  // loudly; the only place it shows is a console error in the app, which is why
  // the rule needs pinning at the render sequence rather than at the settled
  // value.
  it('renders false first even when the query already matches, then corrects', () => {
    queryFor('(min-width: 48rem)').matches = true;

    const { seen } = probe('(min-width: 48rem)');

    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
  });

  it('stays false for a query that does not match', () => {
    const { seen } = probe('(min-width: 48rem)');

    expect(seen.at(-1)).toBe(false);
  });

  it('follows the query across a change', () => {
    const { seen } = probe('(min-width: 48rem)');
    expect(seen.at(-1)).toBe(false);

    setMatches('(min-width: 48rem)', true);
    expect(seen.at(-1)).toBe(true);

    setMatches('(min-width: 48rem)', false);
    expect(seen.at(-1)).toBe(false);
  });

  // A caller that swaps the query string must end up subscribed to the NEW one
  // and off the old one. Getting the second half wrong leaves a live listener
  // writing the old query's answer into state — the value would then flip on a
  // resize that the current query doesn't care about.
  it('re-subscribes when the query changes, and drops the old one', () => {
    const { seen, rerender } = probe('(min-width: 48rem)');

    queryFor('(min-width: 64rem)').matches = true;
    act(() => rerender('(min-width: 64rem)'));
    expect(seen.at(-1)).toBe(true);

    expect(queries.get('(min-width: 48rem)')?.listeners.size).toBe(0);

    // The abandoned query firing must not move the value.
    setMatches('(min-width: 48rem)', true);
    expect(seen.at(-1)).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = probe('(min-width: 48rem)');
    expect(queries.get('(min-width: 48rem)')?.listeners.size).toBe(1);

    unmount();
    expect(queries.get('(min-width: 48rem)')?.listeners.size).toBe(0);
  });
});
