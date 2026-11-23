import React from 'react';
import { render, screen } from '@testing-library/react';

import {
  APP_STORE_URL,
  CHROME_WEB_STORE_URL,
  FIREFOX_ADDONS_URL,
  PLAY_STORE_URL,
} from '@stxapps/shared';

import Page from './page';

describe('Page', () => {
  it('should render successfully', () => {
    const { baseElement } = render(<Page />);
    expect(baseElement).toBeTruthy();
  });

  // The "Also on" row is four icon-only links. Their name used to be an
  // `aria-label` on the `<svg>` with no `role="img"`, which some screen readers
  // skip and axe reports as a link with no text — and jsdom's name computation
  // accepts it, so the name alone cannot tell the two forms apart. Hence both
  // halves: the link names itself, and the mark beside it is hidden, so nothing
  // can be read twice or depend on how a reader treats an unlabelled svg.
  it.each([PLAY_STORE_URL, APP_STORE_URL, CHROME_WEB_STORE_URL, FIREFOX_ADDONS_URL])(
    'names the store link to %s on the link itself',
    (href) => {
      const { container } = render(<Page />);
      const link = container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
      expect(link).not.toBeNull();
      expect(link?.getAttribute('aria-label')).toBeTruthy();
      expect(
        screen.getAllByRole('link', { name: link?.getAttribute('aria-label') ?? '' }),
      ).toContain(link);
      for (const svg of link?.querySelectorAll('svg') ?? []) {
        expect(svg.getAttribute('aria-hidden')).toBe('true');
      }
    },
  );
});
