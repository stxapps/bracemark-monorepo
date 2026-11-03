import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { installJsdomStubs } from '../../testing/jsdom-stubs';
import { NewPasswordField, useNewPassword } from './new-password-field';
import { loadPasswordScorer } from './password-strength';

// `useNewPassword` is THE GATE on a new password, at create-account and at Settings →
// change password alike: one field that starts out holding generated words and ends up
// holding whatever the user or their manager put there. Both callers spell their
// submit's `disabled` as its `ok`, so everything below is about when that opens. None
// of it is visible to lint or the type checker, and the e2e fixture types a known
// password and so only ever sees the last case of the editing block.
//
// This drives the real estimator (a genuine ~1.7 MB dynamic import), so the cases that
// type carry the same generous timeouts as the dictionary spec beside them.

const LABEL = 'New password';

function probe(username: string | undefined = 'wit_e2e', currentPassword?: string) {
  const result = { current: null as ReturnType<typeof useNewPassword> | null };
  function Probe() {
    const control = useNewPassword({ username, currentPassword });
    result.current = control;
    return <NewPasswordField control={control} id="new-password" label={LABEL} />;
  }
  render(<Probe />);
  return {
    get current() {
      if (!result.current) throw new Error('the probe never rendered');
      return result.current;
    },
  };
}

const field = () => screen.getByLabelText(LABEL) as HTMLInputElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });

// How a test ends when its assertions never wait for the estimator. Mounting starts the
// import (`usePasswordStrength` loads on mount), and a synchronous test that returns
// before it lands leaves the hook's `setScoreFn` to fire in the gap before RTL's cleanup
// unmounts the probe: outside `act`, so React warns, on the runs where the import wins
// that race (docs/testing.md, _an update that lands after `act()` returns_). Waiting at
// the END, not in `probe`, keeps those tests about the state BEFORE an estimate exists,
// which is the point of the generated-words ones: the gate must not need it.
//
// A second load inside `act` covers the probe's own: both read the same cached modules
// through the same number of steps, and the probe's started first, so it lands first.
const estimatorLanded = () =>
  act(async () => {
    await loadPasswordScorer();
  });

beforeAll(() => {
  installJsdomStubs();
});

describe('useNewPassword — the generated default', () => {
  it('starts the field on generated words, with the gate open', async () => {
    const view = probe();

    expect(field().value).toBe(view.current.password);
    expect(view.current.password.split('-')).toHaveLength(7);
    expect(view.current.generated).toBe(true);
    expect(view.current.ok).toBe(true);

    await estimatorLanded();
  });

  // The field a manager reads. Masked, it has to be a real password input.
  it('is a masked new-password input', async () => {
    probe();

    expect(field().type).toBe('password');
    expect(field().autocomplete).toBe('new-password');

    await estimatorLanded();
  });

  it('replaces the words on Regenerate, and still needs nothing ticked', async () => {
    const view = probe();
    const first = view.current.password;

    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));

    expect(view.current.password).not.toBe(first);
    expect(view.current.ok).toBe(true);

    await estimatorLanded();
  });
});

describe('useNewPassword — editing is choosing your own', () => {
  it('shuts the gate the moment the words are edited down', async () => {
    const view = probe();

    type('short');

    expect(view.current.generated).toBe(false);
    await waitFor(() => expect(view.current.ok).toBe(false), { timeout: 30_000 });
  });

  it('holds an edit to the entropy floor, however long it is', async () => {
    const view = probe();

    type('password password password');

    await waitFor(() => expect(view.current.message.tone).toBe('error'), { timeout: 30_000 });
    expect(view.current.ok).toBe(false);
  });

  it('penalises a password built out of the username', async () => {
    const view = probe('correcthorsebatterystaple');

    type('correcthorsebatterystaple');

    await waitFor(() => expect(view.current.message.tone).toBe('error'), { timeout: 30_000 });
  });

  it('opens for a password that clears both floors, and gets back to the words', async () => {
    const view = probe();

    type('x7Kq2mVn9Rt4Lw8Zp3Hy6Bf1');
    await waitFor(() => expect(view.current.ok).toBe(true), { timeout: 30_000 });
    expect(view.current.password).toBe('x7Kq2mVn9Rt4Lw8Zp3Hy6Bf1');

    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(view.current.generated).toBe(true);
  });
});

// The floors an edited value meets, ported from the typed path the old Settings block
// had. Settled = the estimator has answered, so `ok` is its verdict and not a wait.
const settle = (view: ReturnType<typeof probe>) =>
  waitFor(() => expect(view.current.message.tone).not.toBe('muted'), { timeout: 30_000 });

describe('useNewPassword — what an edit is measured as', () => {
  it('stays shut below the length floor even at high entropy', async () => {
    const view = probe();
    // 19 chars of randomness: past the entropy floor, under the 20-char one.
    type('Qx7-vT2m_pR9wLd4Zk1');
    await settle(view);

    expect(view.current.ok).toBe(false);
  }, 30_000);

  // THE SCORER IS FED THE CANONICAL PASSWORD. `ilovemydogsomuchyess` scores ~10^17.6,
  // under the 10^18 floor, but zxcvbn models two trailing spaces as ~10^19.6. The
  // derivation TRIMS them, so they are not part of the secret: score the raw string
  // and the gate opens on a password that is below the floor the moment it is used.
  it('scores the canonical password, so trailing spaces buy no entropy', async () => {
    const view = probe();
    type('ilovemydogsomuchyess  ');
    await settle(view);

    expect(view.current.ok).toBe(false);
  }, 30_000);

  it('measures the trimmed password against the length floor', async () => {
    const view = probe();
    type('  Qx7-vT2m_pR9wLd4Zk1  ');
    await settle(view);

    expect(view.current.ok).toBe(false);
  }, 30_000);

  // What is SUBMITTED stays exactly what was typed: canonicalization belongs to the
  // derivation, which does it on both sides.
  it('submits the password verbatim', async () => {
    const view = probe();
    type('  Qx7-vT2m_pR9wLd4Zk1B-nH6  ');
    await settle(view);

    expect(view.current.ok).toBe(true);
    expect(view.current.password).toBe('  Qx7-vT2m_pR9wLd4Zk1B-nH6  ');
  }, 30_000);
});

describe('useNewPassword — the current password', () => {
  // Change password passes its proof field. A rotation to the same password would
  // clear every other rung, since it cleared them when it was set, so this is the one
  // thing that keeps the gate shut on it.
  it('stays shut for the current password, compared canonical', async () => {
    const view = probe(undefined, 'Qx7-vT2m_pR9wLd4Zk1B-nH6');
    type(' Qx7-vT2m_pR9wLd4Zk1B-nH6 ');
    await settle(view);

    expect(view.current.message.text).toBe('That’s your current password.');
    expect(view.current.ok).toBe(false);
  }, 30_000);

  it('passes the generated words, which are not the current password', async () => {
    const view = probe(undefined, 'Qx7-vT2m_pR9wLd4Zk1B-nH6');

    expect(view.current.generated).toBe(true);
    expect(view.current.ok).toBe(true);

    await estimatorLanded();
  });
});

describe('NewPasswordField — showing the words', () => {
  const show = () => fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

  // Seven words do not fit a one-line input on a phone, and this is the one string the
  // user is here to write down: the box under the field shows all of it.
  it('shows the whole password under the field, and hides it again', async () => {
    const view = probe();
    const box = () => screen.queryByText(view.current.password, { selector: 'div' });

    expect(box()).toBeNull();
    show();
    expect(box()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(box()).toBeNull();

    await estimatorLanded();
  });

  it('keeps the box on the password as it is edited', async () => {
    probe();
    show();

    type('x7Kq2mVn9Rt4Lw8Zp3Hy6Bf1');

    expect(screen.getByText('x7Kq2mVn9Rt4Lw8Zp3Hy6Bf1', { selector: 'div' })).toBeTruthy();

    await estimatorLanded();
  });

  // ⚠ The reveal only flips `type`. It used to swap in a <textarea>, which unmounted a
  // filled password field on every press of the eye — a manager can read that as a
  // submission, and iOS did, to the native twin (password-input.tsx). Only a real
  // browser would show the prompt; this pins the element that avoids it.
  it('stays the same <input> through a reveal', async () => {
    probe();
    const input = field();

    show();
    expect(field()).toBe(input);
    expect(input.type).toBe('text');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(field()).toBe(input);
    expect(input.type).toBe('password');

    await estimatorLanded();
  });
});

describe('NewPasswordField — a manager fills the field', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // Only `:autofill`, because Testing Library calls `matches` too.
  const browserFilled = (input: HTMLInputElement, answer: boolean) => {
    const real = input.matches.bind(input);
    input.matches = (selector) => (selector === ':autofill' ? answer : real(selector));
  };

  // iOS re-presents its "Use Strong Password?" sheet over a prefilled field while the
  // focus stays in it, with Save & Fill under the same thumb, and a second accept mints
  // a second password. Only a real iPhone or simulator shows the sheet; this pins the
  // move that stops it.
  it('leaves the field, so iOS does not offer again', async () => {
    probe();
    const input = field();
    input.focus();
    browserFilled(input, true);

    type('gomvow-fYjdef-9wajpu');
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(document.activeElement).not.toBe(input);

    await estimatorLanded();
  });

  it('stays put for someone typing', async () => {
    probe();
    const input = field();
    input.focus();
    browserFilled(input, false);

    type('gomvow');
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(document.activeElement).toBe(input);

    await estimatorLanded();
  });
});

// Step one's Copy is a text button beside Regenerate (docs/account.md, _creating an
// account_), so the one thing that says a copy happened is its label, and Regenerate,
// one row away, must take that back.
describe('NewPasswordField — Copy beside Regenerate', () => {
  let writeText: jest.Mock;
  beforeEach(() => {
    writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  it('copies the password in the field, and Regenerate takes "Copied" back', async () => {
    const view = probe();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledWith(view.current.password);

    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('copies an edited password, not the words it replaced', async () => {
    probe();
    type('x7Kq2mVn9Rt4Lw8Zp3Hy6Bf1');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledWith('x7Kq2mVn9Rt4Lw8Zp3Hy6Bf1');
  });
});
