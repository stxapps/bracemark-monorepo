import * as React from 'react';
import { render, screen } from '@testing-library/react-native';

import { SESSION_COPY } from '@stxapps/react';

import { RevokedNotice } from './revoked-notice';

let mockReason: string | null = null;
jest.mock('@stxapps/expo-react', () => ({
  useAuth: () => ({ reason: mockReason }),
}));

// The twin of bracemark-web's revoked-notice.spec: the words carry the status
// role themselves (a wrapping View contributes nothing to announce —
// docs/accessibility.md, _the iOS asterisk_).
describe('RevokedNotice', () => {
  it('says the local copy was erased after a session_revoked wipe', () => {
    mockReason = 'revoked';
    render(<RevokedNotice />);
    expect(screen.getByRole('status')).toHaveTextContent(SESSION_COPY.revoked);
  });

  it.each([['signed-out'], [null]])('renders nothing for reason %s', (reason) => {
    mockReason = reason;
    render(<RevokedNotice />);
    expect(screen.queryByTestId('revoked-notice')).toBeNull();
  });
});
