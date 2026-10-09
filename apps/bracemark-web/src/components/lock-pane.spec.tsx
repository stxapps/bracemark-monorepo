/**
 * @jest-environment jsdom
 */
// WHERE FOCUS GOES AS THE PANE MOUNTS — one rule, and the half of it that used
// to be missing.
//
// The pane exists to take a password, so its field takes focus on the way up.
// It did that with the `autoFocus` attribute, which cannot ask whether a MODAL
// is open over the pane — and below `md` one can be: the rail is a sheet there,
// and "Lock list" on the list being shown mounts this pane underneath it while
// it stays open. Focus then left the sheet's trap for a field in the page the
// sheet had marked `aria-hidden`: unreachable by a screen reader, and on a
// phone a keyboard raised for an input behind the scrim (docs/locks.md, _a hand
// relock does not ask to be undone_).
//
// Nothing else can see it. `autoFocus` is a valid attribute on a valid input,
// and the symptom needs a modal that is open in another part of the tree. What
// is pinned here is the pane's own half: it asks before it takes focus. That the
// sheet really does mark the page — and that "Lock app", chosen from a menu
// that is modal too, still ends with the field focused — is a browser's to say,
// and was checked in one.
import { render, screen } from '@testing-library/react';

import { LockPane } from './lock-pane';

jest.mock('@stxapps/web-ui/contexts/sign-out-provider', () => ({
  useSignOutFlow: () => ({ requestSignOut: jest.fn(), signingOut: false }),
}));

const pane = <LockPane title="Locked" description="Enter the password" onUnlock={jest.fn()} />;
const field = () => screen.getByLabelText('Password');

// The control, and the common case: a row press, a deep link, a reload behind
// the app lock.
test('a pane that mounts in the open takes focus in its field', () => {
  render(pane);

  expect(document.activeElement).toBe(field());
});

// What a Radix modal does to everything outside itself while it is open.
test.each(['aria-hidden="true"', 'inert'])(
  'a pane that mounts under a modal (%s) leaves focus where it is',
  (attribute) => {
    const hidden = document.createElement('div');
    hidden.innerHTML = `<div ${attribute}></div>`;
    document.body.appendChild(hidden);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    render(pane, { container: hidden.firstElementChild as HTMLElement });

    expect(document.activeElement).toBe(outside);
    hidden.remove();
    outside.remove();
  },
);
