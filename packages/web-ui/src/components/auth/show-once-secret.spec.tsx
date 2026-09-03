import { act, fireEvent, render, screen } from '@testing-library/react';

import { ShowOnceSecret } from './show-once-secret';

// The wallet-style panel behind BOTH of the account's irrecoverable secrets — the
// generated passphrase and the recovery code. There is no server-side reset, so
// this ceremony is the only moment either exists in a form the user can save, and
// the panel's whole job is getting it into a password manager.
//
// The load-bearing case is the SETTLE-BEFORE-COMMIT one: `actions` (Regenerate)
// sits directly above Copy, and regenerating silently invalidates a copy already
// taken — the clipboard still holds the old secret. If the button goes on saying
// "Copied" over a new value, the panel is actively asserting something false
// about the one string the user cannot recover. Nothing catches that: the reset
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
  const onSavedChange = jest.fn();
  const props: React.ComponentProps<typeof ShowOnceSecret> = {
    id: 'saved',
    secret: 'ripe-anchor-velvet-quill-north-timber',
    label: 'Your passphrase',
    confirmLabel: 'I’ve saved my passphrase',
    saved: false,
    onSavedChange,
    ...overrides,
  };
  const view = render(<ShowOnceSecret {...props} />);
  return {
    ...view,
    onSavedChange,
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
    expect(box.getAttribute('aria-label')).toBe('Your passphrase');
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

  // The checkbox is the gate every caller spells its submit's `disabled` against.
  it('reports the confirmation up to the caller', () => {
    const { onSavedChange } = renderPanel();

    fireEvent.click(screen.getByRole('checkbox', { name: 'I’ve saved my passphrase' }));

    expect(onSavedChange).toHaveBeenCalledWith(true);
  });

  it('reflects the caller’s saved state rather than keeping its own', () => {
    const view = renderPanel({ saved: true });
    expect((screen.getByRole('checkbox') as HTMLInputElement).getAttribute('data-state')).toBe(
      'checked',
    );

    view.rerender({ saved: false });
    expect((screen.getByRole('checkbox') as HTMLInputElement).getAttribute('data-state')).toBe(
      'unchecked',
    );
  });

  // `actions` are the controls that change WHICH secret you get, and they render
  // between the value and Copy so they read as belonging to the value above them.
  it('renders the caller’s actions before the copy step', () => {
    renderPanel({ actions: <button type="button">Regenerate</button> });

    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.indexOf('Regenerate')).toBeLessThan(buttons.indexOf('Copy'));
  });
});
