import { act, fireEvent, render, screen } from '@testing-library/react';

import { buildTree, type TagItem } from '@stxapps/shared';
import { useTagMutations, useTags } from '@stxapps/web-react';

import { installJsdomStubs } from '../../testing/jsdom-stubs';
import { Label } from '../ui/label';
import { TagsField } from './tags-field';

// The token combobox the three link editors share. Its trigger is a `div`, not a
// `Button`, because each chosen tag carries its own ✕ and a button nested in a
// button is invalid HTML — and that one structural decision is what every
// assertion here is downstream of. A div is not a labelable element and not a
// focusable one, so the affordances the browser would have given it for free
// (a name from `<label>`, the label's click, keyboard activation) all have to be
// supplied by hand, and every one of them fails SILENTLY when it isn't: the
// control looks exactly like the ListSelect row above it and is simply dead.

jest.mock('@stxapps/web-react', () => ({
  useTags: jest.fn(() => []),
  useTagMutations: jest.fn(() => ({ findOrCreate: jest.fn() })),
}));

beforeAll(installJsdomStubs);

let clock = 0;
const tag = (id: string, name: string): TagItem => ({
  id,
  name,
  parentId: null,
  rank: `a${(clock++).toString().padStart(3, '0')}`,
  createdAt: 0,
  updatedAt: 0,
  path: `tags/${id}.enc`,
});

const setTags = (items: TagItem[]) => {
  clock = 0;
  (useTags as jest.Mock).mockReturnValue(buildTree(items));
};

const trigger = () => screen.getByRole('combobox', { name: 'Tags' });

beforeEach(() => {
  jest.clearAllMocks();
  (useTagMutations as jest.Mock).mockReturnValue({ findOrCreate: jest.fn() });
  setTags([tag('reading', 'reading'), tag('recipes', 'recipes')]);
});

describe('TagsField — the trigger', () => {
  // A `<label htmlFor>` names only a LABELABLE element, so the label above this
  // field contributes nothing to its accessible name. Without the hardcoded
  // `aria-label` the control is announced as an unnamed combobox — and it looks
  // identical to the named ListSelect sitting one row above it.
  it('names itself, since the consumer’s label cannot', () => {
    render(<TagsField value={[]} onChange={jest.fn()} />);

    const el = trigger();
    expect(el.getAttribute('aria-expanded')).toBe('false');
    // `aria-controls` names the list even while the popover content is unmounted,
    // which is what keeps the combobox valid in its closed state.
    expect(el.getAttribute('aria-controls')).not.toBeNull();
  });

  it('shows a placeholder when nothing is chosen', () => {
    render(<TagsField value={[]} onChange={jest.fn()} />);

    expect(trigger().textContent).toContain('Add tags');
  });

  it('renders a chip per chosen tag, in the chosen order', () => {
    render(<TagsField value={['recipes', 'reading']} onChange={jest.fn()} />);

    expect(
      screen.getAllByRole('button', { name: /^Remove/ }).map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Remove recipes', 'Remove reading']);
  });

  // A tag id can legitimately have no row yet: `findOrCreate` returns before the
  // live `useTags` query catches up, so for a beat the caller holds an id this
  // component cannot name. Rendering it anyway would put an empty chip — or the
  // word "undefined" — in the field.
  it('skips an id the tag tree has not surfaced yet', () => {
    render(<TagsField value={['reading', 'just-minted']} onChange={jest.fn()} />);

    expect(screen.getAllByRole('button', { name: /^Remove/ })).toHaveLength(1);
    expect(trigger().textContent).not.toContain('undefined');
  });

  it('removes just that tag when a chip’s ✕ is pressed', () => {
    const onChange = jest.fn();
    render(<TagsField value={['recipes', 'reading']} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove recipes' }));

    expect(onChange).toHaveBeenCalledWith(['reading']);
  });

  // The ✕ sits INSIDE the popover trigger, so its press would otherwise bubble
  // into Radix's trigger and open the picker — the user asks to drop one tag and
  // gets a picker over the field they were looking at.
  it('does not open the picker when a chip is removed', () => {
    render(<TagsField value={['recipes']} onChange={jest.fn()} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Remove recipes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove recipes' }));

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('TagsField — reaching the picker', () => {
  // A div has no implicit keyboard activation, so Enter/Space/ArrowDown are wired
  // by hand. Without them the field is reachable by Tab (it carries `tabIndex`)
  // and then inert — a focus ring on a control a keyboard user cannot open.
  it.each(['Enter', ' ', 'ArrowDown'])('opens on %s', (key) => {
    render(<TagsField value={[]} onChange={jest.fn()} />);

    act(() => void fireEvent.keyDown(trigger(), { key }));

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('ignores an unrelated key', () => {
    render(<TagsField value={[]} onChange={jest.fn()} />);

    act(() => void fireEvent.keyDown(trigger(), { key: 'a' }));

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  // THE DEAD-LABEL CASE, in the place it actually happened. `ui/label.tsx`
  // forwards a click to a non-labelable target by hand precisely because of this
  // control; the unit half of that lives in `label.spec.tsx`, and this is the
  // integration — the `id` prop has to land on the TRIGGER for the forwarding to
  // find it. Point it anywhere else and clicking "Tags" does nothing, between a
  // List row and a Note row that both work.
  it('opens when the consumer’s label is clicked', () => {
    render(
      <>
        <Label htmlFor="tags-field">Tags</Label>
        <TagsField id="tags-field" value={[]} onChange={jest.fn()} />
      </>,
    );

    act(() => void fireEvent.click(screen.getByText('Tags')));

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('TagsField — minting', () => {
  // Reuse-or-mint: `findOrCreate` matches case-insensitively, so retyping a known
  // tag returns the existing one rather than forking a duplicate. The field then
  // has to add the id it got back — including in the reuse case, where the tag is
  // not new but is not yet on this link either.
  it('adds the tag findOrCreate returns', async () => {
    const onChange = jest.fn();
    const findOrCreate = jest.fn(async () => ({ id: 'photography' }));
    (useTagMutations as jest.Mock).mockReturnValue({ findOrCreate });
    render(<TagsField value={['reading']} onChange={onChange} />);

    act(() => void fireEvent.keyDown(trigger(), { key: 'Enter' }));
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: '' }), {
        target: { value: 'photography' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Create/ }));
    });

    expect(findOrCreate).toHaveBeenCalledWith('photography');
    expect(onChange).toHaveBeenCalledWith(['reading', 'photography']);
  });

  // The reuse half of reuse-or-mint can hand back a tag the link ALREADY carries.
  // The picker's own suppression does not prevent this: it compares the trimmed,
  // lowercased query against the tag NAMES it can see, while `findOrCreate` does
  // its own matching over the store — two comparisons that can disagree, and the
  // live tag list can be a beat behind besides. Adding it again would put two
  // identical chips in the field and two copies of the id in the caller's list.
  it('does not add a tag the link already has', async () => {
    const onChange = jest.fn();
    const findOrCreate = jest.fn(async () => ({ id: 'reading' }));
    (useTagMutations as jest.Mock).mockReturnValue({ findOrCreate });
    render(<TagsField value={['reading']} onChange={onChange} />);

    act(() => void fireEvent.keyDown(trigger(), { key: 'Enter' }));
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: '' }), {
        target: { value: 'photography' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Create/ }));
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  // Multi-select: picking from the list toggles membership and the popover stays
  // open, so a user adding three tags does it in three clicks rather than three
  // round trips through the trigger.
  it('toggles a listed tag without closing the picker', () => {
    const onChange = jest.fn();
    render(<TagsField value={[]} onChange={onChange} />);

    act(() => void fireEvent.keyDown(trigger(), { key: 'Enter' }));
    fireEvent.click(screen.getByRole('option', { name: 'recipes' }));

    expect(onChange).toHaveBeenCalledWith(['recipes']);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });
});
