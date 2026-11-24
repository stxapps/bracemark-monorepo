import { act, fireEvent, render, screen } from '@testing-library/react';

import { type FakeBrowser, installFakeBrowser } from '../../testing/fake-browser';
import { ApiAccess, useApiAccess } from './ApiAccess';

// Safari grants the api host at install as Chrome and Firefox do NOT, so the
// popup asks for it first (docs/browser-extension.md, _Safari_). Two things
// here would fail with no symptom:
//
//   - OFF SAFARI THE HOOK MUST NOT CALL `permissions` AT ALL. Chrome and Firefox
//     had working popups before this screen existed; a check there would add a
//     loading frame to every open for nothing, and a wrong answer would lock
//     them out behind a Safari-worded screen.
//   - THE REQUEST IS THE FIRST THING THE CLICK DOES. Safari shows its prompt only
//     for a request made inside the click, so it is called synchronously, before
//     anything is awaited.
//   - ONLY THE TAB ASKS. From the toolbar popup Safari raised no dialog at all, so
//     the popup's button opens the page in a tab instead of requesting.

let mockIsSafari = false;
jest.mock('@/utils/target', () => ({
  get IS_SAFARI() {
    return mockIsSafari;
  },
  API_HOST: 'localhost:8787',
  API_ORIGINS: ['http://localhost:8787/*'],
}));

let fake: FakeBrowser;

beforeEach(() => {
  fake = installFakeBrowser();
});

afterEach(() => {
  mockIsSafari = false;
});

function Probe() {
  const [granted] = useApiAccess();
  return <div>{granted === undefined ? 'CHECKING' : granted ? 'GRANTED' : 'MISSING'}</div>;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useApiAccess', () => {
  it('is granted at once off Safari, without asking the browser', async () => {
    render(<Probe />);
    expect(screen.getByText('GRANTED')).toBeTruthy();
    await flush();
    expect(fake.permissions.contains).not.toHaveBeenCalled();
  });

  it('asks Safari whether the api origin is granted', async () => {
    mockIsSafari = true;
    fake.permissions.contains.mockResolvedValue(false);
    render(<Probe />);
    expect(screen.getByText('CHECKING')).toBeTruthy();
    await flush();
    expect(screen.getByText('MISSING')).toBeTruthy();
    expect(fake.permissions.contains).toHaveBeenCalledWith({
      origins: ['http://localhost:8787/*'],
    });
  });

  it('treats a failed check as missing, not granted', async () => {
    mockIsSafari = true;
    fake.permissions.contains.mockRejectedValue(new Error('nope'));
    render(<Probe />);
    await flush();
    expect(screen.getByText('MISSING')).toBeTruthy();
  });
});

describe('ApiAccess', () => {
  it('from the popup, opens the screen in a tab instead of asking', () => {
    const close = jest.spyOn(window, 'close').mockImplementation(() => undefined);
    render(<ApiAccess inTab={false} onGranted={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(fake.permissions.request).not.toHaveBeenCalled();
    expect(fake.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/popup.html?api-access',
    });
    expect(close).toHaveBeenCalled();
    close.mockRestore();
  });

  it('in the tab, requests the api origin inside the click and moves on when granted', async () => {
    const onGranted = jest.fn();
    render(<ApiAccess inTab onGranted={onGranted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Synchronous with the click: nothing awaited ahead of it.
    expect(fake.permissions.request).toHaveBeenCalledWith({
      origins: ['http://localhost:8787/*'],
    });
    await flush();
    expect(onGranted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says where to change it when Safari says no', async () => {
    fake.permissions.request.mockResolvedValueOnce(false);
    const onGranted = jest.fn();
    render(<ApiAccess inTab onGranted={onGranted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    expect(onGranted).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('set localhost:8787 to Allow');
  });

  it('names the host it asks for', () => {
    render(<ApiAccess inTab={false} onGranted={jest.fn()} />);
    expect(screen.getByText(/its own server, localhost:8787,/)).toBeTruthy();
  });
});
