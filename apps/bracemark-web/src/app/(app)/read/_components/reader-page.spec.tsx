import { useEffect, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

import { ReaderPage } from './reader-page';

// The reader screen's decisions, each one a rule a doc states and nothing else
// checks (reader-page.tsx's header):
//
//   - a link in a LOCKED list shows the unlock pane and none of the copy — a
//     `/read?link=` URL in the history must not be a way round the lock;
//   - reading is NEVER gated: a free account sees a copy it has. Only the empty
//     state looks at the plan, to say what would fill it;
//   - one tab per copy the link has, and no tabs for one.
//
// The store, the locks and the copy's bytes are seams (`@stxapps/web-react` is
// mocked at the barrel); the copy's rendering is web-ui's ReaderArticle, real.

let mockLink: object | undefined;
let mockExtraction: object | undefined;
let mockLocked = false;
let mockKeptCopies = false;
const mockShowPaywall = jest.fn();

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('link=l1'),
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
  useLocks: () => ({
    status: 'ready',
    isListLocked: () => mockLocked,
    unlockList: jest.fn(),
  }),
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

const LINK = { url: 'https://example.com/post', listId: 'reading', customTitle: 'A post' };

beforeEach(() => {
  mockLink = LINK;
  mockExtraction = undefined;
  mockLocked = false;
  mockKeptCopies = false;
  mockShowPaywall.mockClear();
});

test('a link in a locked list shows the unlock pane and none of the copy', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  mockLocked = true;

  render(<ReaderPage />);

  await waitFor(() => expect(screen.getByRole('form')).not.toBeNull());
  expect(screen.queryByText('The kept words.')).toBeNull();
  // Not even the way out to the page itself: the host is the list's contents too.
  expect(screen.queryByRole('link', { name: /open page/i })).toBeNull();
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

test('a screenshot alone is shown as the image of the page', async () => {
  mockExtraction = { screenshotId: 's1', facets: {} };

  render(<ReaderPage />);

  const img = await screen.findByRole('img');
  expect(img.getAttribute('src')).toBe('blob:s1');
});

test('no copy, free: says how to get one and offers Plus', async () => {
  mockExtraction = { facets: {} };

  render(<ReaderPage />);

  await screen.findByText('No copy of this page yet');
  screen.getByRole('button', { name: /plus/i }).click();
  expect(mockShowPaywall).toHaveBeenCalledWith('keptCopies');
});

test('no copy, Plus: no upsell — the browser extension is the way', async () => {
  mockExtraction = { facets: {} };
  mockKeptCopies = true;

  render(<ReaderPage />);

  await screen.findByText('No copy of this page yet');
  expect(screen.queryByRole('button', { name: /plus/i })).toBeNull();
});

test('a link that is not in the library says so', async () => {
  mockLink = undefined;

  render(<ReaderPage />);

  expect(await screen.findByText(/isn’t in your library/)).not.toBeNull();
});
