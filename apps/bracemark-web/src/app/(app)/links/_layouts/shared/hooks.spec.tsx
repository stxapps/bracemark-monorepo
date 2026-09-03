/**
 * @jest-environment jsdom
 */
// Three hooks the layouts and their virtualized rows share, and each one's
// failure lands somewhere other than where the bug is.
//
//   useEngagedOpen — an overlay that unmounts WHILE OPEN (a layout switch, a row
//     scrolling out of a virtualized window, a sync taking the row away) never
//     gets its close handler called, so its increment is never released and
//     `engaged` is pinned true for the life of the page. From then on every
//     background sync stages behind the refresh pill and the list stops
//     repainting — with no error, and nothing on screen pointing at a row menu
//     that closed minutes ago. The count is SHARED, which is also why a repeated
//     same-state call must be a no-op: a stray close would decrement another
//     overlay's increment.
//
//   useReportDisplayedLinkPaths — this is what the automatic-extraction loop
//     drains, so over-reporting means fetching pages the user never looked at,
//     and reporting the whole loaded page instead of the displayed window
//     re-scans thousands of paths on every probe re-run. The debounce is the
//     load-bearing part: virtual scrolling moves the window every frame, and a
//     fast scroll must not report every window it flew past.
//
//   useScrollTopOnQuery — not cosmetic. `useLinks` resets the page to PAGE_SIZE
//     on the same change, so a carried-over offset from a deeply paged view
//     exceeds the new content height, the browser clamps it to the maximum, and
//     the user lands at the BOTTOM of a list they never scrolled — which
//     immediately satisfies the layouts' infinite-scroll effect and pages it
//     further. It keys on the query IDENTITY, not on `selection`, because
//     selection holds still across two different searches and doesn't move at
//     all for a sort change, which reorders every row.

import { act, render } from '@testing-library/react';

import type { LinkQuery } from '@stxapps/shared';
import type { LinkView } from '@stxapps/web-react';

import { useEngagedOpen, useReportDisplayedLinkPaths, useScrollTopOnQuery } from './hooks';

const setMenuOpen = jest.fn();
const setScrolled = jest.fn();
const reportDisplayedLinkPaths = jest.fn();

let mockQuery: LinkQuery = {} as LinkQuery;

jest.mock('../../_contexts/view-state-provider', () => ({
  useLinksViewState: () => ({ setMenuOpen, setScrolled }),
}));

jest.mock('../../_contexts/page-provider', () => ({
  useLinksPage: () => ({ query: mockQuery }),
}));

jest.mock('@stxapps/web-react', () => ({
  useExtraction: () => ({ reportDisplayedLinkPaths }),
  useTags: () => [],
}));

const rowsOf = (...paths: string[]) => paths.map((path) => ({ path }) as unknown as LinkView);

beforeEach(() => {
  jest.useFakeTimers();
  setMenuOpen.mockClear();
  setScrolled.mockClear();
  reportDisplayedLinkPaths.mockClear();
  mockQuery = {} as LinkQuery;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useEngagedOpen', () => {
  let api: ReturnType<typeof useEngagedOpen>;

  function Probe() {
    api = useEngagedOpen();
    return null;
  }

  it('reports an open overlay into the shared count and back out', () => {
    render(<Probe />);
    expect(api[0]).toBe(false);

    act(() => api[1](true));
    expect(api[0]).toBe(true);
    expect(setMenuOpen).toHaveBeenCalledWith(true);

    act(() => api[1](false));
    expect(api[0]).toBe(false);
    expect(setMenuOpen).toHaveBeenLastCalledWith(false);
    expect(setMenuOpen).toHaveBeenCalledTimes(2);
  });

  // Radix fires onOpenChange more than once for a single interaction. The count
  // is shared, so the second call must not decrement someone else's increment.
  it('ignores a repeated call in the state it is already in', () => {
    render(<Probe />);

    act(() => api[1](true));
    act(() => api[1](true));
    expect(setMenuOpen).toHaveBeenCalledTimes(1);

    act(() => api[1](false));
    act(() => api[1](false));
    expect(setMenuOpen).toHaveBeenCalledTimes(2);
  });

  it('ignores a close with nothing open', () => {
    render(<Probe />);
    act(() => api[1](false));
    expect(setMenuOpen).not.toHaveBeenCalled();
  });

  // The leak. A virtualized row can take its own menu away, and no close handler
  // runs when it does.
  it('releases the count when it unmounts while still open', () => {
    const view = render(<Probe />);
    act(() => api[1](true));
    setMenuOpen.mockClear();

    view.unmount();
    expect(setMenuOpen).toHaveBeenCalledWith(false);
  });

  it('releases nothing when it unmounts closed', () => {
    const view = render(<Probe />);
    act(() => api[1](true));
    act(() => api[1](false));
    setMenuOpen.mockClear();

    view.unmount();
    expect(setMenuOpen).not.toHaveBeenCalled();
  });
});

describe('useReportDisplayedLinkPaths', () => {
  function Probe({
    links,
    startIndex,
    endIndex,
  }: {
    links: LinkView[];
    startIndex: number;
    endIndex: number;
  }) {
    useReportDisplayedLinkPaths(links, startIndex, endIndex);
    return null;
  }

  const settle = () => act(() => void jest.advanceTimersByTime(300));

  it('reports only the displayed window, inclusive of both ends', () => {
    render(<Probe links={rowsOf('a', 'b', 'c', 'd', 'e')} startIndex={1} endIndex={3} />);
    settle();
    expect(reportDisplayedLinkPaths).toHaveBeenCalledWith(['b', 'c', 'd']);
  });

  // The whole reason for the debounce: a fast scroll moves the window every
  // frame, and only where the user SETTLES should reach the extraction loop.
  it('reports where the scroll settles, not every window it flew past', () => {
    const links = rowsOf('a', 'b', 'c', 'd', 'e');
    const view = render(<Probe links={links} startIndex={0} endIndex={1} />);

    act(() => void jest.advanceTimersByTime(100));
    view.rerender(<Probe links={links} startIndex={2} endIndex={3} />);
    act(() => void jest.advanceTimersByTime(100));
    view.rerender(<Probe links={links} startIndex={3} endIndex={4} />);
    expect(reportDisplayedLinkPaths).not.toHaveBeenCalled();

    settle();
    expect(reportDisplayedLinkPaths).toHaveBeenCalledTimes(1);
    expect(reportDisplayedLinkPaths).toHaveBeenCalledWith(['d', 'e']);
  });

  // The virtualizer reports its own geometry, which can overhang the list on
  // either side. Neither end may produce an undefined row.
  it('clamps a window that overhangs the list', () => {
    render(<Probe links={rowsOf('a', 'b')} startIndex={-3} endIndex={9} />);
    settle();
    expect(reportDisplayedLinkPaths).toHaveBeenCalledWith(['a', 'b']);
  });

  // An empty report is the loop's "no links shown" contract — it PAUSES the
  // loop, which is different from never reporting at all.
  it('reports an empty window rather than staying silent', () => {
    render(<Probe links={[]} startIndex={0} endIndex={-1} />);
    settle();
    expect(reportDisplayedLinkPaths).toHaveBeenCalledWith([]);
  });
});

describe('useScrollTopOnQuery', () => {
  const scrollTo = jest.fn();
  const scroller = { scrollTo } as unknown as HTMLElement;

  function Probe() {
    useScrollTopOnQuery(() => scroller);
    return null;
  }

  beforeEach(() => scrollTo.mockClear());

  it('does not touch the scroller on the first render', () => {
    render(<Probe />);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(setScrolled).not.toHaveBeenCalled();
  });

  it('sends the pane back to the top when the view changes', () => {
    const view = render(<Probe />);

    mockQuery = {} as LinkQuery; // a new object — what a navigation produces
    act(() => view.rerender(<Probe />));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    // Left true, an offset that no longer exists keeps `engaged` pinned and
    // stages every background sync behind the refresh pill.
    expect(setScrolled).toHaveBeenCalledWith(false);
  });

  it('stays put across a re-render that does not change the view', () => {
    const view = render(<Probe />);
    act(() => view.rerender(<Probe />));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
