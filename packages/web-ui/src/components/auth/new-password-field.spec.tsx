import { act, render, waitFor } from '@testing-library/react';

import { useNewPassword } from './new-password-field';

// `useNewPassword` is THE GATE for choosing a new password, and both surfaces
// that choose one — create-account's setup step and Settings → change password —
// spell their submit's `disabled` as nothing but its `ok`. It is shared for a
// reason: the two used to hand-roll this block near-verbatim and had already
// drifted, with Settings scoring the password against no penalty terms while
// create-account passed the username, so the same string passed the entropy floor
// at rotation and failed it at signup (docs/account.md).
//
// Everything below is about `ok` — when the gate opens and when it must not.
// None of it is visible to lint or the type checker: `ok` is a boolean either
// way, and every wrong version of it still renders a button.
//
// This drives the real estimator (a genuine ~1.7 MB dynamic import), so the
// typed-path cases carry the same generous timeouts as the dictionary spec beside
// them.

function probe(username?: string) {
  const result = { current: null as ReturnType<typeof useNewPassword> | null };
  function Probe() {
    result.current = useNewPassword({ username });
    return null;
  }
  render(<Probe />);
  const current = () => {
    if (!result.current) throw new Error('the probe never rendered');
    return result.current;
  };
  return {
    get current() {
      return current();
    },
    /** Runs a control action and lets React settle. */
    run: (action: (control: ReturnType<typeof useNewPassword>) => void) =>
      act(() => action(current())),
  };
}

/** Types into the typed-your-own path and waits for the estimator's verdict. */
const type = async (view: ReturnType<typeof probe>, password: string) => {
  view.run((c) => c.setMode('own'));
  view.run((c) => c.setOwnPassword(password));
  await waitFor(() => expect(view.current.message.tone).not.toBe('muted'), { timeout: 30_000 });
};

describe('useNewPassword — the generated path', () => {
  // The passphrase is minted in an effect on MOUNT rather than in a lazy
  // initializer, so that SSR and the first client render agree — a random value
  // produced during render would hydrate-mismatch. The cost is one frame with no
  // passphrase, and the gate has to be shut through it: an `ok` on an empty
  // secret would mean a submit that encrypts the library under the empty string.
  it('starts in generated mode with the gate shut, then mints a passphrase', async () => {
    const view = probe();

    expect(view.current.mode).toBe('generated');
    expect(view.current.ok).toBe(false);

    await waitFor(() => expect(view.current.passphrase).not.toBe(''));
    // Still shut — a minted passphrase is not a saved one.
    expect(view.current.ok).toBe(false);
  });

  it('opens only once the user confirms they saved it', async () => {
    const view = probe();
    await waitFor(() => expect(view.current.passphrase).not.toBe(''));

    view.run((c) => c.setPassphraseSaved(true));

    expect(view.current.ok).toBe(true);
    expect(view.current.password).toBe(view.current.passphrase);
  });

  // REGENERATE INVALIDATES THE CONFIRMATION. The checkbox attests to having saved
  // a specific string; a new one makes that attestation false, and a gate left
  // open would let the account be created under a passphrase the user never saw
  // saved — irrecoverably, since there is no reset.
  it('shuts the gate again when the passphrase is regenerated', async () => {
    const view = probe();
    await waitFor(() => expect(view.current.passphrase).not.toBe(''));
    view.run((c) => c.setPassphraseSaved(true));
    const first = view.current.passphrase;

    view.run((c) => c.regenerate());

    expect(view.current.passphrase).not.toBe(first);
    expect(view.current.passphraseSaved).toBe(false);
    expect(view.current.ok).toBe(false);
  });
});

describe('useNewPassword — the typed-your-own path', () => {
  // Switching modes must not carry the other mode's verdict across. The generated
  // passphrase is ~77 bits by construction and its gate is a checkbox; the typed
  // one is scored. An `ok` that survived the switch would let a saved-passphrase
  // tick admit an empty typed password.
  it('shuts the gate on switching to typed, however settled the generated path was', async () => {
    const view = probe();
    await waitFor(() => expect(view.current.passphrase).not.toBe(''));
    view.run((c) => c.setPassphraseSaved(true));
    expect(view.current.ok).toBe(true);

    view.run((c) => c.setMode('own'));

    expect(view.current.ok).toBe(false);
    expect(view.current.password).toBe('');
  });

  it('opens for a password that clears both floors', async () => {
    const view = probe();
    await type(view, 'Qx7-vT2m_pR9wLd4Zk1B-nH6');

    expect(view.current.message.tone).toBe('ok');
    expect(view.current.ok).toBe(true);
    expect(view.current.password).toBe('Qx7-vT2m_pR9wLd4Zk1B-nH6');
  }, 30_000);

  it('stays shut for a long-but-guessable password', async () => {
    const view = probe();
    await type(view, 'correcthorsebatterystaple');

    expect(view.current.ok).toBe(false);
  }, 30_000);

  it('stays shut below the length floor even at high entropy', async () => {
    const view = probe();
    // 19 chars of randomness: past the entropy floor, under the 20-char one.
    await type(view, 'Qx7-vT2m_pR9wLd4Zk1');

    expect(view.current.ok).toBe(false);
  }, 30_000);

  // THE DRIFT THIS HOOK EXISTS TO END. The username is fed to zxcvbn as a penalty
  // term; omitting it (which is what Settings did while it had its own copy of
  // this block) leaves a password built out of the account name clearing the gate.
  // Both halves are asserted, because only the pair proves it is the penalty term
  // doing it rather than the string being weak on its own.
  it('penalises a password built out of the username', async () => {
    const derived = 'qmvtkzrb-9Xf2-qmvtkzrb';

    const withUsername = probe('qmvtkzrb');
    await type(withUsername, derived);
    expect(withUsername.current.ok).toBe(false);

    const withoutUsername = probe();
    await type(withoutUsername, derived);
    expect(withoutUsername.current.ok).toBe(true);
  }, 30_000);

  // THE SCORER IS FED THE CANONICAL PASSWORD, and this is the case where that
  // matters rather than being a tidiness point. `ilovemydogsomuchyess` scores
  // ~10^17.6 on its own — under the 10^18 floor — but zxcvbn models two trailing
  // spaces as ~10^19.6, because as far as it knows they are two more characters
  // an attacker has to guess. The derivation TRIMS them (canonicalizePassword),
  // so they are not part of the secret at all: score the raw string and the gate
  // opens on a password that is below the floor the moment it is used. The length
  // ladder does not save this one — the trimmed string is exactly 20 characters —
  // so the scorer's input is the only thing standing between it and an account.
  it('scores the canonical password, so trailing spaces buy no entropy', async () => {
    const view = probe();
    await type(view, 'ilovemydogsomuchyess  ');

    expect(view.current.ok).toBe(false);
  }, 30_000);

  // The same shape, one step earlier: a password whose trimmed form is under the
  // 20-character floor is refused however long the raw string is.
  it('measures the trimmed password against the length floor', async () => {
    const padded = probe();
    await type(padded, '  Qx7-vT2m_pR9wLd4Zk1  ');

    expect(padded.current.ok).toBe(false);
  }, 30_000);

  // What is SUBMITTED stays exactly what was typed — canonicalization belongs to
  // the derivation, which does it on both sides, so the field must not quietly
  // rewrite the user's secret on its way out.
  it('submits the password verbatim', async () => {
    const view = probe();
    await type(view, '  Qx7-vT2m_pR9wLd4Zk1B-nH6  ');

    expect(view.current.ok).toBe(true);
    expect(view.current.password).toBe('  Qx7-vT2m_pR9wLd4Zk1B-nH6  ');
  }, 30_000);

  it('carries the typed value back on switching to generated, without losing it', async () => {
    const view = probe();
    await type(view, 'Qx7-vT2m_pR9wLd4Zk1B-nH6');

    view.run((c) => c.setMode('generated'));

    expect(view.current.password).toBe(view.current.passphrase);
    expect(view.current.ownPassword).toBe('Qx7-vT2m_pR9wLd4Zk1B-nH6');
  }, 30_000);
});
