import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { CaptureScreen } from './capture-screen';
import { READER_CAPTURE_SCRIPT } from './reader-capture-script.generated';

// The capture screen's rules (its header has the reasoning), against a stand-in
// WebView that records what the screen injects and lets the spec play the page:
//   - free gets the upgrade, never a page; a locked list's page never loads;
//   - the button is live only on the link's own page — never another page the user
//     followed a link to;
//   - a message counts only while a capture awaits one, and only its first answer.

let mockLink: object | null = null;
let mockLocked = false;
let mockKeptCopies = true;
const mockKeepReadMode = jest.fn(async (_link: unknown, _doc: unknown) => true);
const mockShowPaywall = jest.fn();
const mockInject = jest.fn();
let webviewProps: {
  onNavigationStateChange: (nav: { url: string; loading: boolean }) => void;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
};

jest.mock('react-native-webview', () => {
  const react = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual('react-native') as typeof import('react-native');
  const WebView = react.forwardRef((props: typeof webviewProps, ref) => {
    webviewProps = props;
    react.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject }));
    return <View testID="capture-webview" />;
  });
  return { WebView };
});
jest.mock('expo-router', () => ({
  router: { canGoBack: () => true, back: jest.fn(), replace: jest.fn() },
}));
jest.mock('../../contexts/paywall-provider', () => ({
  usePaywall: () => ({ show: mockShowPaywall }),
}));
jest.mock('../../components/lock-pane', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return { LockPane: () => <Text testID="lock-pane">locked</Text> };
});
jest.mock('@stxapps/expo-react', () => {
  const react = jest.requireActual('react') as typeof import('react');
  return {
    readLinkById: async () => mockLink,
    readExtraction: async () => null,
    useLiveRead: (read: () => Promise<unknown>) => {
      const [value, setValue] = react.useState<unknown>(undefined);
      react.useEffect(() => {
        void read().then(setValue);
      }, []);
      return value;
    },
    useLocks: () => ({ status: 'ready', isListLocked: () => mockLocked, unlockList: jest.fn() }),
    useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
    useKeptCopyMutations: () => ({ keepReadMode: mockKeepReadMode }),
  };
});

const LINK = { path: 'links/l1.enc', url: 'https://example.com/post', listId: 'reading' };
const DOC = { version: 1, capturedAt: 1, blocks: [] };
const keep = () => screen.getByTestId('capture-keep-read-mode');

async function onPage(url = 'https://example.com/post') {
  render(<CaptureScreen linkId="l1" />);
  await screen.findByTestId('capture-webview');
  act(() => webviewProps.onNavigationStateChange({ url, loading: false }));
}

const post = (data: unknown) =>
  act(async () => webviewProps.onMessage({ nativeEvent: { data: JSON.stringify(data) } }));

beforeEach(() => {
  mockLink = LINK;
  mockLocked = false;
  mockKeptCopies = true;
  mockKeepReadMode.mockClear();
  mockInject.mockClear();
  mockShowPaywall.mockClear();
});

test('free: the upgrade, and no page loaded', async () => {
  mockKeptCopies = false;
  render(<CaptureScreen linkId="l1" />);
  fireEvent.press(await screen.findByTestId('capture-upgrade'));
  expect(mockShowPaywall).toHaveBeenCalledWith('keptCopies');
  expect(screen.queryByTestId('capture-webview')).toBeNull();
});

test('a link in a locked list: the unlock pane, and no page loaded', async () => {
  mockLocked = true;
  render(<CaptureScreen linkId="l1" />);
  await waitFor(() => expect(screen.getByTestId('lock-pane')).toBeTruthy());
  expect(screen.queryByTestId('capture-webview')).toBeNull();
});

test('on the link’s page, keeping injects the capture and stores what comes back', async () => {
  // http vs https and a trailing slash are still the same page.
  await onPage('http://example.com/post/');
  fireEvent.press(keep());
  expect(mockInject).toHaveBeenCalledWith(READER_CAPTURE_SCRIPT);

  await post({ type: 'bracemark-read-mode', doc: DOC });
  expect(mockKeepReadMode).toHaveBeenCalledWith(LINK, DOC);
  expect(await screen.findByText('Kept — read it')).toBeTruthy();
});

test('on another page the user followed a link to, the button is off', async () => {
  await onPage('https://elsewhere.example/other');
  expect(keep().props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(keep());
  expect(mockInject).not.toHaveBeenCalled();
  expect(screen.getByText('Go back to the saved page to keep its copy.')).toBeTruthy();
});

test('a message nobody asked for is ignored', async () => {
  await onPage();
  await post({ type: 'bracemark-read-mode', doc: DOC });
  expect(mockKeepReadMode).not.toHaveBeenCalled();
});

test('a page with no article says so and stores nothing', async () => {
  await onPage();
  fireEvent.press(keep());
  await post({ type: 'bracemark-read-mode', doc: null });
  expect(mockKeepReadMode).not.toHaveBeenCalled();
  expect(screen.getByText('No article on this page to keep as text.')).toBeTruthy();
});
