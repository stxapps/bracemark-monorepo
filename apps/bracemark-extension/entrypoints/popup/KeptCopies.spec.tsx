import { act, fireEvent, render, screen } from '@testing-library/react';

import type { ExtractionItem } from '@stxapps/web-react';

import { KeptCopies } from './KeptCopies';

// The saved screen's "keep a copy" row. What it shows is derived from the stored
// extraction, and the rules that derivation encodes are invisible when broken:
//
//   - "Keeping…" holds until a facet NEWER than this popup's ask lands, so an old
//     `done` from another day doesn't read as this capture finishing;
//   - a refusal the background answered without writing anything (the tab moved on)
//     still ends "Keeping…" — the live read alone would spin forever;
//   - "not an article" settles the automatic capture, never the button: an explicit
//     ask is always allowed;
//   - a free account's taps go to the web app's Subscription section and capture
//     nothing; reading a kept copy works on every plan.

let mockKeptCopies = true;
const mockSendMessage = jest.fn(async (_m: unknown) => ({ ok: true }) as { ok: boolean });
const mockOpenWebApp = jest.fn(async (_path: string) => undefined);

jest.mock('@stxapps/web-react', () => ({
  useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
}));
jest.mock('@/utils/messages', () => ({
  sendMessage: (m: unknown) => mockSendMessage(m),
}));
jest.mock('@/utils/open-web-app', () => ({
  openWebApp: (path: string) => mockOpenWebApp(path),
}));

const extraction = (patch: Partial<ExtractionItem> = {}): ExtractionItem =>
  ({
    id: 'l1',
    path: 'extractions/l1.enc',
    facets: {},
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }) as ExtractionItem;

const mount = (ex: ExtractionItem | undefined, readModeRequested = false) =>
  render(<KeptCopies linkId="l1" extraction={ex} readModeRequested={readModeRequested} />);

beforeEach(() => {
  mockKeptCopies = true;
  mockSendMessage.mockReset().mockResolvedValue({ ok: true });
  mockOpenWebApp.mockClear();
});

test('a fresh save opens on “Keeping…” for read mode, and settles when the copy lands', () => {
  const { rerender } = mount(extraction(), true);
  expect(screen.getByRole('button', { name: /keeping/i })).toHaveProperty('disabled', true);

  rerender(
    <KeptCopies
      linkId="l1"
      readModeRequested
      extraction={extraction({
        readModeId: 'r1',
        facets: {
          readMode: {
            status: 'done',
            extractedBy: 'extension:fg',
            extractedAt: Date.now() + 1,
            attempts: 0,
          },
        },
      })}
    />,
  );
  expect(screen.getByRole('button', { name: /read mode kept/i })).not.toBeNull();
});

test('a kept copy opens the reader in the web app', () => {
  mount(
    extraction({
      screenshotId: 's1',
      facets: { screenshot: { status: 'done', extractedAt: 1, attempts: 0 } },
    }),
  );

  fireEvent.click(screen.getByRole('button', { name: /screenshot kept/i }));
  expect(mockOpenWebApp).toHaveBeenCalledWith('/read?link=l1');
});

test('the screenshot is one tap, and asks the background for this link', async () => {
  mount(extraction());

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
  });

  expect(mockSendMessage).toHaveBeenCalledWith({
    type: 'EXTRACT',
    linkId: 'l1',
    facet: 'screenshot',
  });
  expect(screen.getByRole('button', { name: /keeping/i })).not.toBeNull();
});

test('a refusal that wrote nothing still ends “Keeping…”', async () => {
  mockSendMessage.mockResolvedValue({ ok: false });
  mount(extraction());

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
  });

  expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
  expect(screen.getByRole('alert')).not.toBeNull();
});

test('“not an article” explains itself and still lets the user ask', () => {
  mount(
    extraction({
      facets: {
        readMode: { status: 'permanent', extractedAt: 1, attempts: 0, reason: 'not-an-article' },
      },
    }),
  );

  expect(screen.getByText(/no article on this page/i)).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Read mode' })).toHaveProperty('disabled', false);
});

test('free: a tap opens Subscription in the web app and captures nothing', () => {
  mockKeptCopies = false;
  mount(extraction(), true);

  // Not "Keeping…" — Editor sends nothing on free, so neither does this row assume it did.
  fireEvent.click(screen.getByRole('button', { name: /read mode — a plus feature/i }));
  expect(mockOpenWebApp).toHaveBeenCalledWith('/settings/subscription');
  expect(mockSendMessage).not.toHaveBeenCalled();
});
