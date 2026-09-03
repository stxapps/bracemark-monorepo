import { act, fireEvent, render, screen } from '@testing-library/react';

import { buildTree, type ListItem } from '@stxapps/shared';
import { useLists } from '@stxapps/web-react';

import { installJsdomStubs } from '../../testing/jsdom-stubs';
import { MoveToSurface } from './move-to-surface';

// The container half of "Move to" — the same ListCommand in a bottom sheet below
// `md` and a centred dialog at and above it. The body is covered by
// `list-command.spec.tsx`; what is only true HERE is the `busy` state, and it is
// load-bearing in a way neither branch's markup shows.
//
// A picker has no submit button — selecting IS submitting — so `busy` is the only
// place progress can live, and the surface has to refuse dismissal while it
// shows. All three exits (Escape, the overlay, the ✕) route through one
// `onOpenChange`, so the guard is one function and forgetting it means a
// half-written multi-link move can be abandoned mid-flight with no error and no
// undo. Nothing types-checks or lints that; both branches still render.

jest.mock('@stxapps/web-react', () => ({ useLists: jest.fn(() => []) }));

beforeAll(installJsdomStubs);

const list = (id: string, name: string): ListItem => ({
  id,
  name,
  parentId: null,
  rank: `a${id}`,
  createdAt: 0,
  updatedAt: 0,
  path: `lists/${id}.enc`,
});

beforeEach(() => {
  jest.clearAllMocks();
  (useLists as jest.Mock).mockReturnValue(buildTree([list('1', 'Work'), list('2', 'Personal')]));
});

const renderSurface = (props: Partial<React.ComponentProps<typeof MoveToSurface>> = {}) => {
  const onOpenChange = jest.fn();
  const onSelect = jest.fn();
  render(
    <MoveToSurface
      wide
      title="Move to"
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      {...props}
    />,
  );
  return { onOpenChange, onSelect };
};

const pressEscape = () => act(() => void fireEvent.keyDown(document, { key: 'Escape' }));

describe.each([
  ['the dialog', true],
  ['the bottom sheet', false],
])('MoveToSurface — %s', (_name, wide) => {
  // The title is the surface's accessible name as well as its visible heading:
  // "Move to" over a list of lists, or "Move “X” to" where the thing being moved
  // isn't otherwise on screen.
  it('names itself with the caller’s title', () => {
    renderSurface({ wide });

    expect(screen.getByRole('dialog', { name: 'Move to' })).not.toBeNull();
  });

  it('shows the picker and reports a pick', () => {
    const { onSelect } = renderSurface({ wide });

    fireEvent.click(screen.getByRole('option', { name: 'Personal' }));

    expect(onSelect).toHaveBeenCalledWith('2');
  });

  it('closes on Escape when nothing is in flight', () => {
    const { onOpenChange } = renderSurface({ wide });

    pressEscape();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // Progress replaces the picker rather than sitting beside it: every row in that
  // list feeds a move that has already been submitted, so leaving them clickable
  // would invite a second, conflicting one.
  it('replaces the picker with the busy notice, announced politely', () => {
    renderSurface({ wide, busy: 'Moving 42 links…' });

    // `status`, not `alert` — this is progress, and an assertive announcement
    // would interrupt whatever the screen reader was saying about the pick.
    expect(screen.getByRole('status').textContent).toBe('Moving 42 links…');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('refuses to close while the move is landing', () => {
    const { onOpenChange } = renderSurface({ wide, busy: 'Moving 42 links…' });

    pressEscape();

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
