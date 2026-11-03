import { act, renderHook } from '@testing-library/react';

import { beginWelcome, endWelcome, updateWelcomePassword, useWelcome } from './welcome-store';

// The held password's whole lifecycle, which is the security half of the welcome
// (docs/account.md, _the welcome_): it exists between a create and the welcome's end,
// in memory only, and an update keeps it the one that opens the account. Teardown
// ending it is the auth providers' (`endWelcome` in each `teardown`).
describe('welcome-store', () => {
  afterEach(() => {
    act(() => endWelcome());
  });

  it('holds nothing until a create begins it', () => {
    const { result } = renderHook(() => useWelcome());
    expect(result.current).toBeNull();
  });

  it('holds the account and password between begin and end', () => {
    const { result } = renderHook(() => useWelcome());
    act(() => beginWelcome({ username: 'wit', password: 'one' }));
    expect(result.current).toEqual({ username: 'wit', password: 'one' });

    act(() => updateWelcomePassword('two'));
    expect(result.current).toEqual({ username: 'wit', password: 'two' });

    act(() => endWelcome());
    expect(result.current).toBeNull();
  });

  it('does not begin one by updating', () => {
    const { result } = renderHook(() => useWelcome());
    act(() => updateWelcomePassword('two'));
    expect(result.current).toBeNull();
  });

  it('is never written to storage', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    act(() => beginWelcome({ username: 'wit', password: 'secret' }));
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
