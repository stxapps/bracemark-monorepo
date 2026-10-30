import { act, fireEvent, render, screen } from '@testing-library/react';

import { type FakeBrowser, installFakeBrowser } from '../../testing/fake-browser';
import App from './App';

// The Settings page: durable configuration only. Sync status lives in the popup,
// extraction progress in the web app, so nothing on this page changes on its own —
// which is exactly why its three states are worth pinning, along with the account
// row that carries the extension's ONLY way out of a session.
//
// The signed-out state is the one with a rule behind it. This page has no sign-in
// of its own — the popup owns it — so the empty state hands the user to the popup
// (`action.openPopup()`), and where the browser can't open it (Chrome 111–126, or a
// refused call) points at the toolbar icon instead. Either way it never just reports
// a requirement. `ThemeSection` is covered in its own spec; here it is only asked
// whether it appears at all.

const mockUseAuth = jest.fn();
const mockUseSignOut = jest.fn();
const mockCountPendingOps = jest.fn();
const mockUseSync = jest.fn();
const mockUseSettings = jest.fn();
const mockUseSettingMutations = jest.fn();

jest.mock('@stxapps/web-react', () => ({
  getSession: () => ({ generation: 'options-session' }),
  get useAuth() {
    return mockUseAuth;
  },
  get useSignOut() {
    return mockUseSignOut;
  },
  get countPendingOps() {
    return mockCountPendingOps;
  },
  get useSync() {
    return mockUseSync;
  },
  get useSettings() {
    return mockUseSettings;
  },
  get useSettingMutations() {
    return mockUseSettingMutations;
  },
}));

const signOutMutate = jest.fn();
const mockSyncAndWait = jest.fn(async () => undefined);

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
  // One function for the page's life, as Providers hands it over. This cycle pushes
  // nothing — the background could not reach the server — so a queued save stays queued.
  mockUseSync.mockReturnValue({ syncAndWait: mockSyncAndWait });
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

  it('hands a signed-out visitor to the popup, which owns the sign-in', () => {
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    render(<App />);

    expect(screen.getByText('Not signed in')).toBeTruthy();
    expect(screen.queryByText('Account')).toBeNull();
    expect(screen.queryByText('Theme')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(fake.action.openPopup).toHaveBeenCalledTimes(1);
  });

  it('points at the toolbar icon where the browser cannot open the popup', () => {
    // Chrome 111–126: under the floor's reach, but before action.openPopup shipped.
    fake.action.openPopup = undefined;
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    render(<App />);

    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(body()).toContain('Click the Bracemark icon in your browser toolbar');
  });

  it('falls back to the toolbar icon when the browser refuses to open the popup', async () => {
    fake.action.openPopup = jest.fn(async () => {
      throw new Error('openPopup requires a user gesture');
    });
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });

    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(body()).toContain('Click the Bracemark icon in your browser toolbar');
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
  // erases the queue. So the row's one click has to try the sync, and stop and say so
  // when that leaves the save where it was.
  it('asks first when a save could not be synced, and signs nothing out yet', async () => {
    mockCountPendingOps.mockResolvedValue(2);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await act(async () => undefined);

    expect(mockSyncAndWait).toHaveBeenCalledTimes(1);
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
