import { render, screen } from '@testing-library/react';

import { PasswordInput } from '../auth/password-input';
import { Input } from './input';
import { Textarea } from './textarea';

// What a field tells the browser about itself. A browser keeps what is typed into
// a text field in its own form history, outside this app's storage and past a
// sign-out: Chrome's profile held the add-link URL and the edit dialog's Title
// after the account had left it. Nothing in the app looks different either way —
// the residue is a suggestion on someone's own machine — so the default is pinned
// here, where a control that stops applying it fails.
describe('what a field tells the browser to keep', () => {
  it('is nothing, for a field that does not say what it is', () => {
    render(
      <>
        <Input aria-label="URL" />
        <Textarea aria-label="Note" />
      </>,
    );

    expect(screen.getByLabelText('URL').getAttribute('autocomplete')).toBe('off');
    expect(screen.getByLabelText('Note').getAttribute('autocomplete')).toBe('off');
  });

  // The other direction, and the one that would hurt at once: a credential field
  // that lost its token to the default is one a password manager no longer fills.
  it.each(['username', 'current-password', 'new-password'])(
    'leaves a field that names itself alone: %s',
    (token) => {
      render(<Input aria-label="Field" autoComplete={token} />);

      expect(screen.getByLabelText('Field').getAttribute('autocomplete')).toBe(token);
    },
  );

  // PasswordInput is the one wrapper every secret goes through, so the default
  // has to reach its field, and so does a caller's token. `off` is not enough on
  // its own for a secret that is not this site's login: Chrome ignores it on a
  // password field, which is why the lock surfaces say `one-time-code` instead
  // (docs/accessibility.md, _what a field tells the browser_).
  it('reaches a secret field through PasswordInput, and yields to its token', () => {
    render(
      <>
        <PasswordInput aria-label="Secret" />
        <PasswordInput aria-label="Account password" autoComplete="current-password" />
      </>,
    );

    expect(screen.getByLabelText('Secret').getAttribute('autocomplete')).toBe('off');
    expect(screen.getByLabelText('Account password').getAttribute('autocomplete')).toBe(
      'current-password',
    );
  });
});

describe('typing assistance follows the field purpose', () => {
  it('keeps exact entry separate from prose, including through Textarea', () => {
    render(
      <>
        <Input aria-label="Username" autoComplete="username" />
        <Textarea aria-label="Note" />
        <Input aria-label="Title" autoCapitalize="sentences" autoCorrect="on" spellCheck />
        <Textarea aria-label="Code" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        <Input aria-label="Recovery code" autoCapitalize="characters" />
      </>,
    );

    for (const label of ['Username', 'Code']) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute('autocapitalize')).toBe('none');
      expect(field.getAttribute('autocorrect')).toBe('off');
      expect(field.getAttribute('spellcheck')).toBe('false');
    }
    for (const label of ['Note', 'Title']) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute('autocapitalize')).toBe('sentences');
      expect(field.getAttribute('autocorrect')).toBe('on');
      expect(field.getAttribute('spellcheck')).toBe('true');
    }
    expect(screen.getByLabelText('Recovery code').getAttribute('autocapitalize')).toBe(
      'characters',
    );
  });
});
