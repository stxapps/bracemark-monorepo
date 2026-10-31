import * as React from 'react';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ReaderScreen } from './reader-screen';

// The expo reader's decisions — the same rules web's reader-page.spec.tsx pins:
// a link in a locked list shows the unlock pane and none of the copy; reading and
// deleting are never gated; one tab per copy; deleting asks first.

let mockLink: object | null = null;
let mockExtraction: object | null = null;
let mockLocked = false;
const mockRemoveCopy = jest.fn(async (_link: unknown, _facet: string) => true);

jest.mock('expo-router', () => ({ router: { canGoBack: () => true, back: jest.fn() } }));
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
    useImageFileUri: (id: string | undefined) => (id ? `file:///${id}` : undefined),
    useKeptCopyMutations: () => ({ removeCopy: mockRemoveCopy }),
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
};

beforeEach(() => {
  mockLink = LINK;
  mockExtraction = null;
  mockLocked = false;
  mockRemoveCopy.mockClear();
});

test('a link in a locked list shows the unlock pane and none of the copy', async () => {
  mockExtraction = { readModeId: 'r1', facets: {} };
  mockLocked = true;

  render(<ReaderScreen linkId="l1" />);

  await waitFor(() => expect(screen.getByTestId('lock-pane')).toBeTruthy());
  expect(screen.queryByText('The kept words.')).toBeNull();
  expect(screen.queryByText('Open page')).toBeNull();
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
