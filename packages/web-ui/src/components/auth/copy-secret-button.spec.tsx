import { act, fireEvent, render, screen } from '@testing-library/react';

import { CopySecretButton } from './copy-secret-button';

// The full-width Copy under the recovery code's panel (on the welcome after
// create-account and in Settings) and under the new password in Settings. There is
// no server-side reset for a recovery code, so the panel's moment is the only one
// in which the code exists in a form the user can save, and this button is how it
// gets somewhere safe.
//
// The load-bearing case is the reset: a new secret drops "Copied". If the button went
// on saying "Copied" over a new value, it would be asserting something false about
// the one string the user cannot recover. Nothing else catches that: the reset is an
// effect keyed on `secret`, drop it and every render still looks right.

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

const SECRET = 'ripe-anchor-velvet-quill-north-timber';

const copyButton = () => screen.getByRole('button', { name: /^Cop/ });

describe('CopySecretButton', () => {
  it('copies the secret and says so in words', async () => {
    render(<CopySecretButton secret={SECRET} />);
    expect(copyButton().textContent).toBe('Copy');

    await act(async () => {
      fireEvent.click(copyButton());
    });

    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(copyButton().textContent).toBe('Copied');
  });

  // THE ONE THAT MATTERS. Regenerate replaces the secret; the clipboard still
  // holds the previous one and nothing on screen would say so.
  it('drops "Copied" when the secret is replaced', async () => {
    const view = render(<CopySecretButton secret={SECRET} />);
    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect(copyButton().textContent).toBe('Copied');

    view.rerender(<CopySecretButton secret="amber-lattice-drift-pillar-onset-kernel" />);

    expect(copyButton().textContent).toBe('Copy');
  });

  // Copy is a step, not a one-shot — the affordance has to come back so a user
  // who copied into the wrong place can copy again.
  it('reverts to "Copy" after a beat', async () => {
    jest.useFakeTimers();
    try {
      render(<CopySecretButton secret={SECRET} />);
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
    render(<CopySecretButton secret={SECRET} />);

    await act(async () => {
      fireEvent.click(copyButton());
    });

    expect(copyButton().textContent).toBe('Copy');
  });
});
