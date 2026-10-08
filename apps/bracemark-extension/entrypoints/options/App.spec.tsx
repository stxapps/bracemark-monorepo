import { act, fireEvent, render, screen } from '@testing-library/react';

import { type FakeBrowser, installFakeBrowser } from '../../testing/fake-browser';
import App from './App';

// The Settings page: durable configuration only. Sync status lives in the popup,
// extraction progress in the web app, so nothing on this page changes on its own —
// which is exactly why its three states are worth pinning, along with the account
// row that carries the extension's ONLY way out of a session.
//
// The signed-out state is the one with a rule behind it. This page has no sign-in
// and cannot grow one — the popup owns it, and a tab cannot open a popup for the
// user — so the empty state has to point at the toolbar icon rather than report a
// requirement. `ThemeSection` is covered in its own spec; here it is only asked
// whether it appears at all.

const mockUseAuth = jest.fn();
const mockUseSignOut = jest.fn();
const mockCountPendingOps = jest.fn();
const mockUseSettings = jest.fn();
const mockUseSettingMutations = jest.fn();

jest.mock('@stxapps/web-react', () => ({
  get useAuth() {
    return mockUseAuth;
  },
  get useSignOut() {
    return mockUseSignOut;
  },
  get countPendingOps() {
    return mockCountPendingOps;
  },
  get useSettings() {
    return mockUseSettings;
  },
  get useSettingMutations() {
    return mockUseSettingMutations;
  },
}));

const signOutMutate = jest.fn();

const body = () => document.body.textContent ?? '';

let fake: FakeBrowser;

beforeEach(() => {
  jest.clearAllMocks();
  fake = installFakeBrowser();
  mockUseAuth.mockReturnValue({ status: 'authenticated', username: 'alice' });
  mockUseSignOut.mockReturnValue({
    mutate: signOutMutate,
    reset: jest.fn(),
    isPending: false,
    isError: false,
  });
  mockCountPendingOps.mockResolvedValue(0);
  mockUseSettings.mockReturnValue({
    themeSource: 'sync',
    syncTheme: { mode: 'system', lightStart: '06:00', darkStart: '18:00' },
    localTheme: { mode: 'system', lightStart: '06:00', darkStart: '18:00' },
  });
  mockUseSettingMutations.mockReturnValue({
    setThemeSource: jest.fn(async () => undefined),
    setSyncTheme: jest.fn(async () => undefined),
    setLocalTheme: jest.fn(async () => undefined),
  });
});

describe('the three states', () => {
  it('waits quietly while auth resolves', () => {
    mockUseAuth.mockReturnValue({ status: 'loading' });

    render(<App />);

    expect(screen.getByText('Loading')).toBeTruthy();
    expect(screen.queryByText('Account')).toBeNull();
  });

  it('points a signed-out visitor at the toolbar icon, since this page has no sign-in', () => {
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    render(<App />);

    expect(screen.getByText('Not signed in')).toBeTruthy();
    expect(body()).toContain('Click the Bracemark icon in your browser toolbar');
    expect(screen.queryByText('Account')).toBeNull();
    expect(screen.queryByText('Theme')).toBeNull();
  });

  it('shows account and theme once there is a session', () => {
    render(<App />);

    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Theme')).toBeTruthy();
  });
});

describe('the account row', () => {
  it('names the signed-in account beside the button that ends it', () => {
    render(<App />);

    expect(screen.getByText('Signed in as')).toBeTruthy();
    expect(screen.getByText('alice')).toBeTruthy();
  });

  it('holds the row rather than printing "undefined" before the username arrives', () => {
    mockUseAuth.mockReturnValue({ status: 'authenticated', username: undefined });

    render(<App />);

    expect(screen.getByText('—')).toBeTruthy();
  });

  it('says what signing out costs, because here it costs more than on a website', () => {
    render(<App />);

    // clearData() wipes this browser's decrypted copy of the library along with the
    // encryption key — worth a sentence before the click, not a surprise after it.
    expect(body()).toContain('removes this browser’s copy of your library and its encryption key');
    expect(body()).toContain('Nothing on the server changes');
  });

  // The click goes through the hoisted flow (@stxapps/web-ui's sign-out-provider, which
  // has its own spec), and the count it reads is asynchronous — hence the act.
  it('signs out when pressed, with nothing waiting to sync', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await act(async () => undefined);

    expect(signOutMutate).toHaveBeenCalledTimes(1);
  });

  // The sentence under the row promises the library can be downloaded again. A save the
  // popup queued while offline cannot: it exists only in this browser, and the sign-out
  // erases the queue. So the row's one click has to stop and say so.
  it('asks first when a save has not synced, and signs nothing out yet', async () => {
    mockCountPendingOps.mockResolvedValue(2);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await act(async () => undefined);

    expect(signOutMutate).not.toHaveBeenCalled();
    expect(body()).toContain('2 changes that haven’t synced and exist nowhere else');

    fireEvent.click(screen.getByTestId('sign-out-confirm'));

    expect(signOutMutate).toHaveBeenCalledTimes(1);
  });

  it('reports progress and refuses a second press while signing out', () => {
    mockUseSignOut.mockReturnValue({
      mutate: signOutMutate,
      reset: jest.fn(),
      isPending: true,
      isError: false,
    });

    render(<App />);

    const button = screen.getByRole('button', { name: 'Signing out…' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});

describe('the footer', () => {
  it('prints the built version, read from the manifest so it cannot disagree', () => {
    fake.runtime.getManifest.mockReturnValue({ version: '1.4.2' });

    render(<App />);

    expect(screen.getByText('Version 1.4.2')).toBeTruthy();
  });

  it('opens the library in a tab', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /Open Bracemark/ }));

    expect(fake.tabs.create).toHaveBeenCalledWith({ url: 'http://localhost:3000/links' });
  });
});
