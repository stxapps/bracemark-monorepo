import { render, screen } from '@testing-library/react';

import { SESSION_COPY } from '@stxapps/react';

import { SignIn } from './SignIn';

// The revoked notice is the one piece of news on this screen: the server told
// this browser to forget, and its library is gone. As a second muted caption
// under the heading it was read past; it is its own status block now, holding
// the words and nothing else.

let mockReason: string | null = null;
jest.mock('@stxapps/web-react', () => ({
  useAuth: () => ({ reason: mockReason }),
}));
jest.mock('@stxapps/web-ui/components/auth/sign-in-form', () => ({
  SignInForm: () => <form aria-label="sign in form" />,
}));

describe('SignIn — the revoked notice', () => {
  it('says the local copy was erased after a session_revoked wipe', () => {
    mockReason = 'revoked';
    render(<SignIn />);
    expect(screen.getByRole('status').textContent).toBe(SESSION_COPY.revoked);
  });

  it.each([['signed-out'], [null]])('is absent for reason %s', (reason) => {
    mockReason = reason;
    render(<SignIn />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.textContent).not.toContain(SESSION_COPY.revoked);
  });
});
