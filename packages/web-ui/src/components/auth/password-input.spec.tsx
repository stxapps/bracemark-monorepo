import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { PasswordInput } from './password-input';

// The ONE spelling of a secret field on this platform — auth forms, settings,
// delete-account and both lock surfaces all render this. It carries a reveal
// toggle instead of a "confirm password" second input, and that is a security
// decision, not a convenience: the account has no password reset, so a mistyped
// secret at create-account is a permanent lockout of everything encrypted under
// it (docs/account.md, _every field that takes a secret reveals it_).
//
// So the toggle actually revealing the value is the behaviour worth pinning. It
// is also silently breakable: `{...props}` spreads LAST, so a caller passing
// `type="password"` wins over the state, and the eye then toggles nothing while
// still announcing that it did.
const renderField = (props: React.ComponentProps<'input'> = {}) =>
  render(
    <>
      <label htmlFor="pw">Password</label>
      <PasswordInput id="pw" {...props} />
    </>,
  );

const field = () => screen.getByLabelText('Password') as HTMLInputElement;

describe('PasswordInput', () => {
  it('masks the value until the toggle is pressed', () => {
    renderField();
    expect(field().type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field().type).toBe('text');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(field().type).toBe('password');
  });

  // The toggle is a control with no text, so its state has to reach a screen
  // reader some other way; `aria-pressed` plus a label that names the NEXT action
  // is that way. Losing either leaves a user who can't see the field with no way
  // to know whether their secret is currently on screen.
  it('announces its state', () => {
    renderField();

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  // Tab goes field → submit, not field → eye. The reveal is a mouse/touch
  // affordance for someone checking what they typed; putting it in the tab order
  // adds a stop between every secret field and the button that acts on it, on
  // forms that are nothing but secret fields.
  it('keeps the toggle out of the tab order', () => {
    renderField();

    expect(screen.getByRole('button', { name: 'Show password' }).getAttribute('tabindex')).toBe(
      '-1',
    );
  });

  // It is a `type="button"`, so it can't submit the form it sits inside. The
  // default for a bare <button> is `submit`, and the symptom would be pressing
  // "show my password" and signing in instead.
  it('does not submit the form it sits in', () => {
    const onSubmit = jest.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput aria-label="Password" />
      </form>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  // react-hook-form's `register()` supplies ref/name/onChange/onBlur as spread
  // props, and every auth form relies on that reaching the real input rather than
  // the wrapper div.
  it('forwards a ref and input props to the field itself', () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = jest.fn();
    render(
      <PasswordInput
        ref={ref}
        aria-label="Password"
        name="password"
        autoComplete="current-password"
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText('Password') as HTMLInputElement;
    expect(ref.current).toBe(input);
    expect(input.name).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('current-password');

    fireEvent.change(input, { target: { value: 'hunter2' } });
    expect(onChange).toHaveBeenCalled();
    expect(input.value).toBe('hunter2');
  });

  // Revealing must not disturb what has been typed — this field is often filled
  // by a password manager, and a reveal that reset it would be worse than no
  // reveal at all.
  it('keeps the typed value across a reveal', () => {
    renderField();
    fireEvent.change(field(), { target: { value: 'correct horse battery staple' } });

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(field().value).toBe('correct horse battery staple');
  });
});
