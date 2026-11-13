import * as React from 'react';
import { Linking, View } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ReaderScreen } from './reader-screen';

// The expo reader's decisions — the same rules web's reader-page.spec.tsx pins:
// a link in a locked list shows the unlock pane and none of the copy; reading and
// deleting are never gated; one tab per copy, and one for the copy the phone can take; deleting asks first. And the way
// across to the capture screen: a paid plan's only, and a replace, not a push. The top
// bar's actions are in its ⋯ menu (topbar.tsx), and behind a lock the bar names
// no host and has no menu.

let mockLink: object | null = null;
let mockExtraction: object | null = null;
let mockLocked = false;
let mockKeptCopies = true;
const mockReplace = jest.fn();
const mockRemoveCopy = jest.fn(async (_link: unknown, _facet: string) => true);

jest.mock('expo-router', () => ({
  router: {
    canGoBack: () => true,
    back: jest.fn(),
    replace: (href: string) => mockReplace(href),
  },
}));
jest.mock('@stxapps/expo-react', () => {
  const react = jest.requireActual('react') as typeof import('react');
  return {
    readLinkById: async () => mockLink,
    readExtraction: async () => mockExtraction,
    // Run the read once, as the real hook does on mount.
    useLiveRead: (read: () => Promise<unknown>) => {
      const [value, setValue] = react.useState<unknown>(undefined);
      react.useEffect(() => {
        void read().then(setValue);
      }, []);
      return value;
    },
    useLocks: () => ({
      status: 'ready',
      isListLocked: () => mockLocked,
      unlockList: jest.fn(),
    }),
    useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
    useImageFileUri: (id: string | undefined) => (id ? `file:///${id}` : undefined),
    useKeptCopyMutations: () => ({ removeCopy: mockRemoveCopy }),
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
  };
});
jest.mock('../../components/lock-pane', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return { LockPane: ({ title }: { title: string }) => <Text testID="lock-pane">{title}</Text> };
});

const LINK = {
  path: 'links/l1.enc',
  url: 'https://example.com/post',
  listId: 'reading',
  customTitle: 'A post',
  createdAt: Date.UTC(2026, 10, 9, 8, 7, 6),
};

// The menu portals out, and is placed only once its trigger is measured — the jest
// View never calls `measure` back (dropdown-menu.spec.tsx has the same stand-in).
function renderReader() {
  return render(
    <>
      <ReaderScreen linkId="l1" />
      <PortalHost />
    </>,
  );
}
const openMenu = () => fireEvent.press(screen.getByTestId('reader-more-options'));

afterEach(() => jest.restoreAllMocks());

beforeEach(() => {
  jest
    .spyOn(View.prototype, 'measure')
    .mockImplementation((callback) => callback(0, 0, 36, 36, 300, 10));
  mockLink = LINK;
  mockExtraction = null;
  mockLocked = false;
  mockKeptCopies = true;
  mockReplace.mockClear();
  mockRemoveCopy.mockClear();
});

test('a link in a locked list shows the unlock pane and none of the copy', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  mockLocked = true;

  render(<ReaderScreen linkId="l1" />);

  await waitFor(() => expect(screen.getByTestId('lock-pane')).toBeTruthy());
  expect(screen.queryByText('The kept words.')).toBeNull();
  // The host is the list's contents too: the bar says "Reader" and offers nothing.
  expect(screen.getByTestId('reader-title')).toHaveTextContent('Reader');
  expect(screen.queryByText('example.com')).toBeNull();
  expect(screen.queryByTestId('reader-more-options')).toBeNull();
});

test('the bar names the host, and its menu holds the ways out and the way across', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  renderReader();
  await screen.findByText('The kept words.');
  expect(screen.getByTestId('reader-title')).toHaveTextContent('example.com');

  openMenu();
  expect(screen.getByText('Open page')).toBeTruthy();
  expect(screen.getByText('Update from the page')).toBeTruthy();
  expect(screen.getByText('Open in Wayback Machine')).toBeTruthy();
});

test('a paid plan crosses to the capture screen in place of the reader', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  renderReader();
  await screen.findByText('The kept words.');

  openMenu();
  fireEvent.press(screen.getByTestId('reader-capture'));
  expect(mockReplace).toHaveBeenCalledWith('/capture?link=l1');
});

test('free: the copy reads, and there is no way to take another', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  mockKeptCopies = false;
  renderReader();
  // Reading is never gated — a copy kept on an earlier plan stays the user's.
  expect(await screen.findByText('The kept words.')).toBeTruthy();
  openMenu();
  // The positive control: the menu is open, without the way across.
  expect(screen.getByTestId('reader-open-page')).toBeTruthy();
  expect(screen.queryByTestId('reader-capture')).toBeNull();
});

test('the Wayback Machine opens the capture nearest the day the link was saved', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

  renderReader();
  await screen.findByText('The kept words.');
  // Built on the device; nothing is opened, or asked, before the press.
  expect(openURL).not.toHaveBeenCalled();

  openMenu();
  fireEvent.press(screen.getByTestId('reader-wayback'));
  expect(openURL).toHaveBeenCalledWith(
    'https://web.archive.org/web/20261109080706/https://example.com/post',
  );
});

test('reads a copy the link has', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  render(<ReaderScreen linkId="l1" />);
  expect(await screen.findByText('The kept words.')).toBeTruthy();
  expect(screen.getByText('A post')).toBeTruthy();
});

test('a tab per copy when the link has both', async () => {
  mockExtraction = { readModeId: 'r1', screenshotId: 's1', facets: {} };
  render(<ReaderScreen linkId="l1" />);
  expect(await screen.findByText('Read mode')).toBeTruthy();
  expect(screen.getByText('Screenshot')).toBeTruthy();
});

test('a screenshot alone, on a paid plan: both tabs, opening on the screenshot', async () => {
  mockExtraction = { screenshotId: 's1', facets: {} };
  render(<ReaderScreen linkId="l1" />);
  expect(await screen.findByText('Read mode')).toBeTruthy();
  expect(screen.getByText('Screenshot')).toBeTruthy();
  // Opens on the copy that exists, not on the empty tab.
  expect(screen.getByLabelText(/Screenshot of A post/)).toBeTruthy();
  expect(screen.queryByTestId('reader-keep-read-mode')).toBeNull();
});

test('its Read mode tab sends the phone to the capture screen, in place of the reader', async () => {
  mockExtraction = { screenshotId: 's1', facets: {} };
  render(<ReaderScreen linkId="l1" />);
  fireEvent.press(await screen.findByText('Read mode'));

  expect(screen.getByText('No read-mode copy yet')).toBeTruthy();
  fireEvent.press(screen.getByTestId('reader-keep-read-mode'));
  expect(mockReplace).toHaveBeenCalledWith('/capture?link=l1');
});

test('a screenshot alone, free: the bare screenshot — that tab would lead only to Plus', async () => {
  mockExtraction = { screenshotId: 's1', facets: {} };
  mockKeptCopies = false;
  render(<ReaderScreen linkId="l1" />);
  expect(await screen.findByLabelText(/Screenshot of A post/)).toBeTruthy();
  expect(screen.queryByText('Read mode')).toBeNull();
});

test('a read-mode copy alone has no tabs — the phone takes no screenshot', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  render(<ReaderScreen linkId="l1" />);
  await screen.findByText('The kept words.');
  expect(screen.queryByText('Screenshot')).toBeNull();
});

test('deleting a copy asks first, then removes that copy of this link', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  // The dialog portals out; the app root mounts this host, the spec has to.
  render(
    <>
      <ReaderScreen linkId="l1" />
      <PortalHost />
    </>,
  );

  fireEvent.press(await screen.findByTestId('reader-delete-readMode'));
  expect(mockRemoveCopy).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.press(screen.getByText('Delete'));
  });
  expect(mockRemoveCopy).toHaveBeenCalledWith(LINK, 'readMode');
});

test('a link that is not in the library says so', async () => {
  mockLink = null;
  render(<ReaderScreen linkId="gone" />);
  expect(await screen.findByText(/isn’t in your library/)).toBeTruthy();
});
