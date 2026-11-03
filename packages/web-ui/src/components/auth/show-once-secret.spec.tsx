import { act, fireEvent, render, screen } from '@testing-library/react';

import { ShowOnceSecret } from './show-once-secret';

// The wallet-style panel behind the recovery code, on the welcome after create-account
// and in Settings. There is no server-side reset, so this is the only moment the code
// exists in a form the user can save, and the panel's whole job is getting it
// somewhere safe.
//
// The load-bearing case is the reset: a new secret drops "Copied". If the button went
// on saying "Copied" over a new value, the panel would be asserting something false
// about the one string the user cannot recover. Nothing else catches that: the reset
// is an effect keyed on `secret`, drop it and every render still looks right.

const writeText = jest.fn<Promise<void>, [string]>();

beforeAll(() => {
  // jsdom ships no clipboard.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text: string) => writeText(text) },
  });
});

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
});

function renderPanel(overrides: Partial<React.ComponentProps<typeof ShowOnceSecret>> = {}) {
  const props: React.ComponentProps<typeof ShowOnceSecret> = {
    secret: 'ripe-anchor-velvet-quill-north-timber',
    label: 'Your recovery code',
    ...overrides,
  };
  const view = render(<ShowOnceSecret {...props} />);
  return {
    ...view,
    rerender: (next: Partial<React.ComponentProps<typeof ShowOnceSecret>>) =>
      view.rerender(<ShowOnceSecret {...props} {...next} />),
  };
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

  it('copies the secret and says so in words', async () => {
    renderPanel();
    expect(copyButton().textContent).toBe('Copy');

    await act(async () => {
      fireEvent.click(copyButton());
    });

    expect(writeText).toHaveBeenCalledWith('ripe-anchor-velvet-quill-north-timber');
    expect(copyButton().textContent).toBe('Copied');
  });

  // THE ONE THAT MATTERS. Regenerate replaces the secret; the clipboard still
  // holds the previous one and nothing on screen would say so.
  it('drops "Copied" when the secret is replaced', async () => {
    const view = renderPanel();
    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect(copyButton().textContent).toBe('Copied');

    view.rerender({ secret: 'amber-lattice-drift-pillar-onset-kernel' });

    expect(copyButton().textContent).toBe('Copy');
    expect(screen.getByRole('status').textContent).toBe('amber-lattice-drift-pillar-onset-kernel');
  });

  // Copy is a step, not a one-shot — the affordance has to come back so a user
  // who copied into the wrong place can copy again.
  it('reverts to "Copy" after a beat', async () => {
    jest.useFakeTimers();
    try {
      renderPanel();
      await act(async () => {
        fireEvent.click(copyButton());
      });
      expect(copyButton().textContent).toBe('Copied');

      act(() => jest.advanceTimersByTime(2000));

      expect(copyButton().textContent).toBe('Copy');
    } finally {
      jest.useRealTimers();
    }
  });

  // Clipboard access fails on an insecure context and under some permission
  // policies. The secret is on screen and selectable, so the recovery is
  // select-and-copy — but the button must not claim a copy that didn't happen.
  it('does not claim success when the clipboard is blocked', async () => {
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    renderPanel();

    await act(async () => {
      fireEvent.click(copyButton());
    });

    expect(copyButton().textContent).toBe('Copy');
  });

  // Every code it shows is already live, so it asks for no tick: one read as the thing
  // that would make the code count.
  it('asks for no "I’ve saved it" tick', () => {
    renderPanel();

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(copyButton().textContent).toBe('Copy');
  });
});
