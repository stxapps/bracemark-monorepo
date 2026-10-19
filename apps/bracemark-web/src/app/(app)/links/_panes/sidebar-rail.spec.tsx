import { act, fireEvent, render, screen } from '@testing-library/react';

import { buildTree, LIST_NO_CHILDREN_IDS } from '@stxapps/shared';
import { type SidebarRail, useLists, useLocks, useTags } from '@stxapps/web-react';

import { RAIL_WIDTH, takeRailFocus } from '../_hooks/use-sidebar-rail';
import { Sidebar } from './sidebar';

// The rail's dock state: its width and whether it is collapsed. Every failure here is
// silent in the ordinary sense — the rail still renders, still typechecks — and shows
// up as a rail that lands outside its bounds, a drag that commits on cancel, a
// collapse that strands keyboard focus on `body`, or a shortcut that hides the rail
// on a phone where there is none to see go.
//
// `@stxapps/web-react` is mocked at the barrel (the trees' hooks are Dexie liveQueries
// over an encrypted store); the rail's store is replaced by an in-memory one with the
// same subscribe/snapshot contract, so the component's reads and writes are real.

let mockRail: SidebarRail;
const mockListeners = new Set<() => void>();
const mockWrite = jest.fn((patch: Partial<SidebarRail>) => {
  mockRail = { ...mockRail, ...patch };
  for (const listener of mockListeners) listener();
});

jest.mock('@stxapps/web-react', () => ({
  useLists: jest.fn(),
  useTags: jest.fn(),
  useLocks: jest.fn(),
  readSidebarCollapsedIds: () => [],
  writeSidebarCollapsedIds: jest.fn(),
  DEFAULT_SIDEBAR_RAIL: { collapsed: false, width: null },
  getSidebarRail: () => mockRail,
  subscribeSidebarRail: (listener: () => void) => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  },
  writeSidebarRail: (patch: Partial<SidebarRail>) => mockWrite(patch),
}));

jest.mock('../_contexts/page-provider', () => ({
  useLinksPage: () => ({ selection: { kind: 'all' }, setSimpleQuery: jest.fn() }),
}));

// jsdom ships no PointerEvent (a pointer event would arrive without `clientX`) and no
// pointer capture.
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent });
HTMLElement.prototype.setPointerCapture = () => undefined;
HTMLElement.prototype.releasePointerCapture = () => undefined;

let mdMatches = true;
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({ matches: mdMatches, media: query }),
});

const rail = () => screen.queryByRole('complementary');
const splitter = () => screen.getByRole('separator', { name: 'Resize sidebar' });
const railWidth = () => (rail() as HTMLElement).style.width;
const valueNow = () => Number(splitter().getAttribute('aria-valuenow'));

// The rail measures itself once, at pointerdown; jsdom lays nothing out.
function stubRailWidth(px: number) {
  jest
    .spyOn(rail() as HTMLElement, 'getBoundingClientRect')
    .mockReturnValue({ width: px } as DOMRect);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRail = { collapsed: false, width: null };
  mdMatches = true;
  // 1280 × 0.4 = 512, so the viewport cap sits above `max` and the bounds under test
  // are the rail's own.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  jest
    .mocked(useLists)
    .mockReturnValue(buildTree([], { noChildrenIds: LIST_NO_CHILDREN_IDS }) as never);
  jest.mocked(useTags).mockReturnValue(buildTree([]) as never);
  jest.mocked(useLocks).mockReturnValue({
    hiddenListIds: new Set(),
    listLocks: new Map(),
    lockList: jest.fn(),
  } as unknown as ReturnType<typeof useLocks>);
  // Drain any focus handoff a previous case left pending.
  takeRailFocus('show');
  takeRailFocus('hide');
});

describe('Sidebar rail — width', () => {
  it('starts at the default width when none has been stored', () => {
    render(<Sidebar />);

    expect(railWidth()).toBe(`${RAIL_WIDTH.default}px`);
    expect(valueNow()).toBe(RAIL_WIDTH.default);
  });

  // A stored width is untrusted (an older build's bounds, a hand edit), and the
  // separator must never announce a value outside the min/max it also announces.
  it.each([
    [10, RAIL_WIDTH.min],
    [9999, RAIL_WIDTH.max],
  ])('sizes a stored %ipx rail inside its bounds (%ipx)', (stored, shown) => {
    mockRail = { collapsed: false, width: stored };
    render(<Sidebar />);

    expect(railWidth()).toBe(`${shown}px`);
    expect(valueNow()).toBe(shown);
  });

  it('steps with the arrows, further with Shift, and stops at Home/End', () => {
    render(<Sidebar />);

    fireEvent.keyDown(splitter(), { key: 'ArrowRight' });
    expect(valueNow()).toBe(RAIL_WIDTH.default + 16);
    fireEvent.keyDown(splitter(), { key: 'ArrowLeft', shiftKey: true });
    expect(valueNow()).toBe(RAIL_WIDTH.default + 16 - 64);
    fireEvent.keyDown(splitter(), { key: 'Home' });
    expect(valueNow()).toBe(RAIL_WIDTH.min);
    fireEvent.keyDown(splitter(), { key: 'ArrowLeft' });
    expect(valueNow()).toBe(RAIL_WIDTH.min);
    fireEvent.keyDown(splitter(), { key: 'End' });
    expect(valueNow()).toBe(RAIL_WIDTH.max);
  });

  // The CSS caps the rail at 40vw; a stored width past that would be a number the
  // separator announces and the screen doesn't show.
  it('never stores a width wider than the window lets the rail be', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    render(<Sidebar />);

    fireEvent.keyDown(splitter(), { key: 'End' });

    expect(mockRail.width).toBe(320);
  });

  // The drag writes the DOM, not the store, until it is let go — the store is what
  // re-renders the trees, and it would on every pointermove.
  it('follows a drag live and commits once, on release', () => {
    render(<Sidebar />);
    stubRailWidth(240);

    fireEvent.pointerDown(splitter(), { button: 0, clientX: 240 });
    fireEvent.pointerMove(splitter(), { clientX: 300 });
    expect(railWidth()).toBe('300px');
    expect(mockWrite).not.toHaveBeenCalled();

    fireEvent.pointerUp(splitter(), { clientX: 300 });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockRail.width).toBe(300);
  });

  it('puts the rail back, and stores nothing, when the browser cancels the drag', () => {
    render(<Sidebar />);
    stubRailWidth(240);

    fireEvent.pointerDown(splitter(), { button: 0, clientX: 240 });
    fireEvent.pointerMove(splitter(), { clientX: 360 });
    fireEvent.pointerCancel(splitter());

    expect(railWidth()).toBe('240px');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns to the default width on double-click', () => {
    mockRail = { collapsed: false, width: 320 };
    render(<Sidebar />);

    fireEvent.doubleClick(splitter());

    expect(mockRail.width).toBeNull();
    expect(valueNow()).toBe(RAIL_WIDTH.default);
  });
});

describe('Sidebar rail — collapse', () => {
  it('renders nothing while collapsed, so the trees are not mounted twice', () => {
    mockRail = { collapsed: true, width: null };
    render(<Sidebar />);

    expect(rail()).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  // The control pressed is inside what disappears: without the handoff a keyboard
  // user lands on `body`, at the top of the page's tab order.
  it('hands focus to the topbar when Hide is pressed from inside the rail', () => {
    render(<Sidebar />);
    const hide = screen.getByRole('button', { name: 'Hide sidebar' });

    hide.focus();
    fireEvent.click(hide);

    expect(rail()).toBeNull();
    expect(takeRailFocus('show')).toBe(true);
  });

  // A positive control for the case above: the handoff is for focus that is going
  // away, not a grab of whatever has focus.
  it('leaves focus alone when it was outside the rail', () => {
    render(
      <>
        <input aria-label="elsewhere" />
        <Sidebar />
      </>,
    );
    screen.getByRole('textbox', { name: 'elsewhere' }).focus();

    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });

    expect(rail()).toBeNull();
    expect(takeRailFocus('show')).toBe(false);
  });

  it('collapses when the splitter gets Enter', () => {
    render(<Sidebar />);

    fireEvent.keyDown(splitter(), { key: 'Enter' });

    expect(rail()).toBeNull();
  });

  // Released past the threshold, the drag folds the rail — and the width it had
  // before the drag is the one it comes back at, not the one it was dropped at.
  it('collapses on a drag released past the threshold, keeping the width it had', () => {
    mockRail = { collapsed: false, width: 300 };
    render(<Sidebar />);
    stubRailWidth(300);

    fireEvent.pointerDown(splitter(), { button: 0, clientX: 300 });
    fireEvent.pointerMove(splitter(), { clientX: 40 });
    expect(rail()?.getAttribute('data-collapsing')).toBe('true');
    fireEvent.pointerUp(splitter(), { clientX: 40 });

    expect(mockRail).toEqual({ collapsed: true, width: 300 });
  });

  it('toggles both ways with Ctrl+\\ — bound even while the rail is collapsed', () => {
    render(<Sidebar />);

    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    expect(rail()).toBeNull();
    fireEvent.keyDown(window, { key: '\\', metaKey: true });
    expect(rail()).not.toBeNull();
  });

  // Below `md` the rail is a drawer; flipping the flag there would only surface later,
  // on a wider window, as a rail that is inexplicably gone.
  it('ignores the shortcut below md', () => {
    mdMatches = false;
    render(<Sidebar />);

    act(() => {
      fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    });

    expect(mockWrite).not.toHaveBeenCalled();
  });
});
