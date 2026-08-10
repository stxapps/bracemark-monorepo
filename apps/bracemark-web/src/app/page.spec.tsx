import React from 'react';
import { render } from '@testing-library/react';

import Page from './page';

// Page renders <HomeRedirect />, which calls useAuth() and then redirect()s in every
// settled state. Stub the auth context at 'loading' — the one state that renders
// without navigating — so this stays a provider-free render smoke test.
jest.mock('@stxapps/web-react', () => ({
  useAuth: () => ({ status: 'loading' }),
}));

describe('Page', () => {
  it('should render successfully', () => {
    const { baseElement } = render(<Page />);
    expect(baseElement).toBeTruthy();
  });
});
