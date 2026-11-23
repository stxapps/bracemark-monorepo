import React from 'react';
import { render, screen } from '@testing-library/react';

import { SESSION_COPY } from '@stxapps/react';

import { RevokedNotice } from './revoked-notice';

let mockReason: string | null = null;
jest.mock('@stxapps/web-react', () => ({
  useAuth: () => ({ reason: mockReason }),
}));

// The words are a polite status of their own, so a screen reader hears the news
// without the form around it, and they are the block's whole text: no caption
// rides along to dilute them.
describe('RevokedNotice', () => {
  it('says the local copy was erased after a session_revoked wipe', () => {
    mockReason = 'revoked';
    render(<RevokedNotice />);
    expect(screen.getByRole('status').textContent).toBe(SESSION_COPY.revoked);
  });

  it.each([['signed-out'], [null]])('renders nothing for reason %s', (reason) => {
    mockReason = reason;
    const { container } = render(<RevokedNotice />);
    expect(container.textContent).toBe('');
  });
});
