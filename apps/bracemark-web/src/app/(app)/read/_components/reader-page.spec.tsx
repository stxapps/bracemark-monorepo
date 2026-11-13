import { useEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ReaderPage } from './reader-page';

// The reader screen's decisions, each one a rule a doc states and nothing else
// checks (reader-page.tsx's header):
//
//   - a link in a LOCKED list shows the unlock pane and none of the copy — a
//     `/read?link=` URL in the history must not be a way round the lock;
//   - reading is NEVER gated: a free account sees a copy it has. Only the empty
//     state looks at the plan, to say what would fill it;
//   - one tab per copy the link has, one more for the copy this screen can take, and
//     no tabs when there is only one thing to show.
//
// The store, the locks and the copy's bytes are seams (`@stxapps/web-react` is
// mocked at the barrel); the copy's rendering is web-ui's ReaderArticle, real.

let mockLink: object | undefined;
let mockExtraction: object | undefined;
let mockLocked = false;
let mockKeptCopies = false;
const mockShowPaywall = jest.fn();
const mockRemoveCopy = jest.fn(async (_link: unknown, _facet: string) => true);
let mockServerAvailable = false;
let mockNeedsOptIn = false;
let mockReadModeImages = true;
const mockSetKeepOnSave = jest.fn(async (_patch: object) => undefined);
// Turning the opt-in on flips the gate the way the real hook would, on the next render.
const mockSetServerReadMode = jest.fn(async (enabled: boolean) => {
  mockServerAvailable = enabled;
  mockNeedsOptIn = !enabled;
});
const mockKeep = jest.fn(async (_link: unknown): Promise<object> => ({ kind: 'kept' }));
const mockSearch = 'link=l1';

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
}));
jest.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => Promise<unknown>, deps: unknown[]) => {
    const [value, setValue] = useState<unknown>(undefined);
    useEffect(() => {
      void querier().then(setValue);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's deps, as Dexie takes them
    }, deps);
    return value;
  },
}));
jest.mock('@stxapps/web-react', () => ({
  readLinkById: async () => mockLink,
  readExtraction: async () => mockExtraction,
  useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
  useImageFileUrl: (id: string | undefined) => (id ? `blob:${id}` : undefined),
  useKeptCopyMutations: () => ({ removeCopy: mockRemoveCopy }),
  useServerReadMode: () => ({
    available: mockServerAvailable,
    needsOptIn: mockNeedsOptIn,
    keep: mockKeep,
  }),
  useSettings: () => ({ keepOnSave: { readModeImages: mockReadModeImages } }),
  useSettingMutations: () => ({
    setServerReadMode: mockSetServerReadMode,
    setKeepOnSave: mockSetKeepOnSave,
  }),
  useLocks: () => ({
    status: 'ready',
    isListLocked: () => mockLocked,
    unlockList: jest.fn(),
  }),
  useReaderImages: () => ({ images: new Map(), settled: true }),
  useReaderDoc: (id: string | undefined) =>
    id
      ? {
          status: 'ready',
          doc: {
            version: 1,
            capturedAt: 0,
            blocks: [{ id: 'b0', kind: 'paragraph', runs: [{ text: 'The kept words.' }] }],
          },
        }
      : { status: 'none' },
}));
jest.mock('@/components/lock-pane', () => ({
  LockPane: ({ title }: { title: string }) => <div role="form" aria-label={title} />,
}));
jest.mock('@/contexts/paywall-provider', () => ({
  usePaywall: () => ({ show: mockShowPaywall }),
}));

const LINK = {
  url: 'https://example.com/post',
  listId: 'reading',
  customTitle: 'A post',
  createdAt: Date.UTC(2026, 10, 9, 8, 7, 6),
};
// The Internet Archive's capture nearest the day the link was saved (shared url.ts).
const WAYBACK = 'https://web.archive.org/web/20261109080706/https://example.com/post';

beforeEach(() => {
  mockLink = LINK;
  mockExtraction = undefined;
  mockLocked = false;
  mockKeptCopies = false;
  mockShowPaywall.mockClear();
  mockRemoveCopy.mockClear();
  mockServerAvailable = false;
  mockNeedsOptIn = false;
  mockReadModeImages = true;
  mockKeep.mockClear();
  mockSetServerReadMode.mockClear();
  mockSetKeepOnSave.mockClear();
});

test('a link in a locked list shows the unlock pane and none of the copy', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  mockLocked = true;

  render(<ReaderPage />);

  await waitFor(() => expect(screen.getByRole('form')).not.toBeNull());
  expect(screen.queryByText('The kept words.')).toBeNull();
  // Not even the way out to the page itself: the host is the list's contents too.
  expect(screen.queryByRole('link', { name: /open page/i })).toBeNull();
  expect(screen.queryByRole('link', { name: /wayback/i })).toBeNull();
});

test('beside a copy, the Wayback Machine is one press away — built here, asked nothing', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  const fetchSpy = jest.fn();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchSpy as never;

  try {
    render(<ReaderPage />);

    const link = await screen.findByRole('link', { name: 'Open in Wayback Machine' });
    expect(link.getAttribute('href')).toBe(WAYBACK);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    // No lookup: whether a capture exists is the archive's to say after the click.
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('no copy: the Wayback Machine is offered in words, beside the page itself', async () => {
  mockExtraction = { facets: {} };

  render(<ReaderPage />);

  await screen.findByText('Keep a copy of this page');
  expect(screen.getByText(/Wayback Machine may have it/)).not.toBeNull();
  expect(screen.getByRole('link', { name: /^Wayback Machine/ }).getAttribute('href')).toBe(WAYBACK);
});

test('a link no public archive could hold gets no Wayback exit', async () => {
  mockLink = { ...LINK, url: 'http://localhost:3000/admin' };
  mockExtraction = { facets: {} };

  render(<ReaderPage />);

  await screen.findByText('Keep a copy of this page');
  expect(screen.queryByRole('link', { name: /wayback/i })).toBeNull();
  expect(screen.queryByText(/Wayback Machine/)).toBeNull();
});

test('a free account reads a copy it already has — reading is never gated', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };

  render(<ReaderPage />);

  expect(await screen.findByText('The kept words.')).not.toBeNull();
  expect(screen.getByRole('heading', { level: 1, name: 'A post' })).not.toBeNull();
  expect(screen.queryByRole('tablist')).toBeNull();
});

test('a tab per copy when the link has both', async () => {
  mockExtraction = { readModeId: 'r1', screenshotId: 's1', facets: {} };

  render(<ReaderPage />);

  await screen.findByRole('tablist');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Read mode', 'Screenshot']);
});

test('a screenshot alone, where read mode can be taken: both tabs, opening on the screenshot', async () => {
  mockExtraction = { screenshotId: 's1', facets: {} };
  mockKeptCopies = true;
  mockServerAvailable = true;

  render(<ReaderPage />);

  await screen.findByRole('tablist');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Read mode', 'Screenshot']);
  // The copy that exists, not the empty tab.
  expect((await screen.findByRole('img')).getAttribute('src')).toBe('blob:s1');
  expect(screen.queryByRole('button', { name: 'Keep a read-mode copy' })).toBeNull();
});

test('its Read mode tab holds the keep section — and none of the Wayback one', async () => {
  mockExtraction = { screenshotId: 's1', facets: {} };
  mockKeptCopies = true;
  mockServerAvailable = true;

  render(<ReaderPage />);

  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Read mode' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Read mode' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep a read-mode copy' }));
  await waitFor(() => expect(mockKeep).toHaveBeenCalledTimes(1));
  // No Wayback section in the tab: the top bar has the exit.
  expect(screen.queryByText(/Wayback Machine may have it/)).toBeNull();
});

test('a screenshot alone, where only the opt-in is missing: the tab offers to turn it on', async () => {
  mockExtraction = { screenshotId: 's1', facets: {} };
  mockKeptCopies = true;
  mockNeedsOptIn = true;

  render(<ReaderPage />);

  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Read mode' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Read mode' }));
  expect(await screen.findByRole('button', { name: 'Turn on server read mode' })).not.toBeNull();
});

test('a screenshot alone, free: the bare screenshot — that tab would hold only an upsell', async () => {
  mockExtraction = { screenshotId: 's1', facets: {} };

  render(<ReaderPage />);

  expect((await screen.findByRole('img')).getAttribute('src')).toBe('blob:s1');
  expect(screen.queryByRole('tablist')).toBeNull();
});

test('a screenshot alone is shown as the image of the page', async () => {
  mockExtraction = { screenshotId: 's1', facets: {} };

  render(<ReaderPage />);

  const img = await screen.findByRole('img');
  expect(img.getAttribute('src')).toBe('blob:s1');
});

test('no copy, free: says how to get one and offers Plus', async () => {
  mockExtraction = { facets: {} };

  render(<ReaderPage />);

  await screen.findByText('Keep a copy of this page');
  screen.getByRole('button', { name: /plus/i }).click();
  expect(mockShowPaywall).toHaveBeenCalledWith('keptCopies');
});

test('no copy, Plus: no upsell — the browser extension is the way', async () => {
  mockExtraction = { facets: {} };
  mockKeptCopies = true;

  render(<ReaderPage />);

  await screen.findByText('Keep a copy of this page');
  expect(screen.queryByRole('button', { name: /plus/i })).toBeNull();
});

test('a link that is not in the library says so', async () => {
  mockLink = undefined;

  render(<ReaderPage />);

  expect(await screen.findByText(/isn’t in your library/)).not.toBeNull();
});

test('deleting a copy asks first, then removes that copy of this link', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };

  render(<ReaderPage />);

  fireEvent.click(await screen.findByRole('button', { name: /delete this read-mode copy/i }));
  expect(mockRemoveCopy).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  });
  expect(mockRemoveCopy).toHaveBeenCalledWith(LINK, 'readMode');
});

describe('keeping read mode through the link-extraction service', () => {
  test('is offered on an empty link only when the web app can take a copy', async () => {
    mockKeptCopies = true;
    render(<ReaderPage />);
    await screen.findByText('Keep a copy of this page');
    expect(screen.queryByRole('button', { name: 'Keep a read-mode copy' })).toBeNull();
  });

  test('a press asks once, for this link, and says why when there is no copy', async () => {
    mockKeptCopies = true;
    mockServerAvailable = true;
    mockKeep.mockResolvedValueOnce({
      kind: 'none',
      status: 'permanent',
      reason: 'robots-disallowed',
    });
    render(<ReaderPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep a read-mode copy' }));

    expect((await screen.findByRole('status')).textContent).toMatch(
      /asks services like ours not to/,
    );
    expect(mockKeep).toHaveBeenCalledTimes(1);
    expect(mockKeep.mock.calls[0][0]).toMatchObject({ url: LINK.url });
  });

  // A settled answer is the same on every press, so the button goes off with the reason
  // beside it rather than inviting a press that appears to do nothing.
  test('after a settled "no copy" the button is off and the reason stays', async () => {
    mockKeptCopies = true;
    mockServerAvailable = true;
    mockKeep.mockResolvedValueOnce({
      kind: 'none',
      status: 'permanent',
      reason: 'not-an-article',
    });
    render(<ReaderPage />);

    const keep = await screen.findByRole('button', { name: 'Keep a read-mode copy' });
    fireEvent.click(keep);

    expect((await screen.findByRole('status')).textContent).toMatch(/no article on this page/);
    await waitFor(() => expect((keep as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(keep);
    expect(mockKeep).toHaveBeenCalledTimes(1);
  });

  test('beside the action, Include images writes the synced setting', async () => {
    mockKeptCopies = true;
    mockServerAvailable = true;
    render(<ReaderPage />);

    const images = await screen.findByRole('checkbox', { name: 'Include images' });
    expect(images.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      fireEvent.click(images);
    });
    expect(mockSetKeepOnSave).toHaveBeenCalledWith({ readModeImages: false });
  });

  test('a transport failure says so rather than throwing', async () => {
    mockKeptCopies = true;
    mockServerAvailable = true;
    mockKeep.mockRejectedValueOnce(new Error('503'));
    render(<ReaderPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep a read-mode copy' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not keep a read-mode copy. Please try again.',
    );
  });

  // A failure learned nothing about the page, so a second press may work: the button
  // stays, and says so.
  test('after a failure the button stays on, as Try again', async () => {
    mockKeptCopies = true;
    mockServerAvailable = true;
    mockKeep.mockRejectedValueOnce(new Error('503'));
    render(<ReaderPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep a read-mode copy' }));
    await screen.findByRole('alert');

    const again = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    await waitFor(() => expect(mockKeep).toHaveBeenCalledTimes(2));
  });
});

// Server read mode is its OWN opt-in, off by default, and the empty state is where it is
// offered — in place, with the disclosure beside the button, and as a press of its own:
// turning it on fetches nothing, and only the next press asks for this page.
describe('turning server read mode on from the empty state', () => {
  beforeEach(() => {
    mockKeptCopies = true;
    mockNeedsOptIn = true;
  });

  test('offers the opt-in with what it sends, and no Keep yet', async () => {
    render(<ReaderPage />);

    expect(await screen.findByRole('button', { name: 'Turn on server read mode' })).not.toBeNull();
    expect(screen.getByText(/receives the link’s address, not your account/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep a read-mode copy' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Include images' })).toBeNull();
  });

  test('turning it on fetches nothing, and hands focus to Keep', async () => {
    render(<ReaderPage />);

    const turnOn = await screen.findByRole('button', { name: 'Turn on server read mode' });
    await act(async () => {
      fireEvent.click(turnOn);
    });

    expect(mockSetServerReadMode).toHaveBeenCalledWith(true);
    expect(mockKeep).not.toHaveBeenCalled();
    const keep = await screen.findByRole('button', { name: 'Keep a read-mode copy' });
    expect(document.activeElement).toBe(keep);
    expect(screen.getByRole('checkbox', { name: 'Include images' })).not.toBeNull();
  });

  test('a failed write says so and leaves the offer up', async () => {
    mockSetServerReadMode.mockRejectedValueOnce(new Error('No active account'));
    render(<ReaderPage />);

    const turnOn = await screen.findByRole('button', { name: 'Turn on server read mode' });
    await act(async () => {
      fireEvent.click(turnOn);
    });

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not turn on server read mode. Please try again.',
    );
    expect(screen.getByRole('button', { name: 'Turn on server read mode' })).not.toBeNull();
  });

  test('a free account is offered Plus, not the opt-in', async () => {
    mockKeptCopies = false;
    mockNeedsOptIn = false;
    render(<ReaderPage />);

    await screen.findByText('Keep a copy of this page');
    expect(screen.queryByRole('button', { name: 'Turn on server read mode' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep copies with Plus' })).not.toBeNull();
  });
});
