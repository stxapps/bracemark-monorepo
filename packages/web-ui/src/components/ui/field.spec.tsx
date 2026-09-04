import { render, screen } from '@testing-library/react';

import { FieldError } from './field';

// `FieldError` is the web carrier for the announced-error tripwire
// (docs/accessibility.md, _errors_): an error that MOUNTS must carry
// `role="alert"`, or the button re-enables, a line of red text appears, and a
// screen-reader user is told nothing. Nothing else catches its absence — no lint
// rule, no type error — and every auth surface routes its errors through here
// (sign-in's `errors.root`, create-account's confirm mismatch and submit
// failure), so one dropped attribute silences all of them at once.
//
// The rest of this pins the `errors` prop's own shape rules, which are the half a
// caller can't see from the call site: it renders NOTHING rather than an empty
// box, one message stays a sentence rather than becoming a one-item list, and
// react-hook-form handing the same message twice must not print it twice.
describe('FieldError', () => {
  it('announces — the mounted error carries role="alert"', () => {
    render(<FieldError>That doesn’t match. Check what you saved and try again.</FieldError>);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('That doesn’t match. Check what you saved and try again.');
  });

  it('announces an error supplied through `errors` too', () => {
    render(<FieldError errors={[{ message: 'Incorrect username or password' }]} />);

    expect(screen.getByRole('alert').textContent).toBe('Incorrect username or password');
  });

  // The "nothing to say" state is what lets a caller render it unconditionally —
  // create-account's submit error sits permanently below the two buttons so that
  // mounting it moves nothing. That only works if the empty case is truly empty:
  // an empty alert node would still be an announced region, and a bordered/spaced
  // one would reserve a gap that the form's own rhythm doesn't expect.
  it.each([
    ['no children and no errors', {}],
    ['an empty errors array', { errors: [] }],
    ['a null child', { children: null }],
    ['an undefined message', { errors: [undefined] }],
  ])('renders nothing for %s', (_label, props) => {
    const { container } = render(<FieldError {...props} />);

    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // One message is a sentence, not a bullet. The list form only earns its place
  // when there is genuinely more than one thing wrong.
  it('renders a single message as plain text, not a list', () => {
    render(<FieldError errors={[{ message: 'Username is required' }]} />);

    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Username is required');
  });

  it('renders several distinct messages as a list', () => {
    render(
      <FieldError errors={[{ message: 'Too short' }, { message: 'Contains your username' }]} />,
    );

    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Too short', 'Contains your username']);
  });

  // react-hook-form reports one message per failing rule, and a schema can fail
  // two rules with the same sentence. Printing it twice reads as two separate
  // problems the user has to find two separate fixes for.
  it('deduplicates repeated messages', () => {
    render(
      <FieldError
        errors={[{ message: 'Too short' }, { message: 'Too short' }, { message: 'No spaces' }]}
      />,
    );

    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Too short',
      'No spaces',
    ]);
  });

  // Both are legal props; a caller that passes children means them, and silently
  // preferring `errors` would drop a hand-written message on the floor.
  it('prefers children over errors', () => {
    render(<FieldError errors={[{ message: 'from errors' }]}>from children</FieldError>);

    expect(screen.getByRole('alert').textContent).toBe('from children');
  });
});
