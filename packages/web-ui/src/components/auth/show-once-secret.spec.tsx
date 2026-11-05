import { render, screen } from '@testing-library/react';

import { ShowOnceSecret } from './show-once-secret';

// The wallet-style panel behind the recovery code, on the welcome after create-account
// and in Settings. There is no server-side reset, so this is the only moment the code
// exists in a form the user can save, and the panel's whole job is getting it
// somewhere safe. The Copy under it, and its "Copied" flash, are
// copy-secret-button.spec.tsx's.

function renderPanel(overrides: Partial<React.ComponentProps<typeof ShowOnceSecret>> = {}) {
  const props: React.ComponentProps<typeof ShowOnceSecret> = {
    secret: 'ripe-anchor-velvet-quill-north-timber',
    label: 'Your recovery code',
    ...overrides,
  };
  return render(<ShowOnceSecret {...props} />);
}

const copyButton = () => screen.getByRole('button', { name: /^Cop/ });

describe('ShowOnceSecret', () => {
  // `<output>` carries an implicit `role="status"`, which is what makes a
  // regenerated secret announce itself without an aria-live of our own. A styled
  // <div> here would look identical and say nothing.
  it('presents the secret in a live status region, named for a screen reader', () => {
    renderPanel();

    const box = screen.getByRole('status');
    expect(box.textContent).toBe('ripe-anchor-velvet-quill-north-timber');
    expect(box.getAttribute('aria-label')).toBe('Your recovery code');
  });

  // Every code it shows is already live, so it asks for no tick: one read as the thing
  // that would make the code count.
  it('asks for no "I’ve saved it" tick', () => {
    renderPanel();

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(copyButton().textContent).toBe('Copy');
  });
});
