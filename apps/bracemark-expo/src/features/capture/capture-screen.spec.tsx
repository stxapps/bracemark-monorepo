import * as React from 'react';
import { Linking, View } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { CaptureScreen } from './capture-screen';

// The capture screen's rules (its header and use-page-capture.ts's have the reasoning),
// against a stand-in WebView that records each request the screen injects and lets the
// spec play the page:
//   - free loads the page but has no Update preview, and Keep a copy is the
//     upgrade; a locked list's page never loads;
//   - the top bar's two exits, in its ⋯ menu (reader/topbar.tsx): Read while
//     the link has a copy (a replace — the reader and this screen trade places), the
//     Wayback Machine — said in words too when the page didn't load; behind a lock
//     the bar names no host and has no menu;
//   - the buttons are live only on the link's own page, and an answer from another
//     page is refused;
//   - a message counts only while a request awaits one, and only with its nonce.

let mockLink: Record<string, unknown> | null = null;
let mockLocked = false;
let mockKeptCopies = true;
let mockExtraction: Record<string, unknown> | null = null;
const mockReplace = jest.fn();
const mockKeepReadMode = jest.fn(async (_link: unknown, _doc: unknown, _options?: unknown) => true);
const mockUpdatePreview = jest.fn(async (_link: unknown, _input: unknown) => ({
  title: true,
  image: true,
}));
const mockShowPaywall = jest.fn();
const mockInject = jest.fn();
let webviewProps: {
  source: { uri: string };
  onNavigationStateChange: (nav: { url: string; loading: boolean }) => void;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  originWhitelist: string[];
  setSupportMultipleWindows?: boolean;
  onShouldStartLoadWithRequest: (request: { url: string; isTopFrame?: boolean }) => boolean;
  onLoadStart: () => void;
  onError: () => void;
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
// The injected script is the request itself here, so the spec can read what was asked
// and answer with its nonce. The real script is held by web-react's
// reader-capture-generated.spec.ts, which runs it in jsdom.
jest.mock('./page-capture-script.generated', () => ({
  pageCaptureScript: (request: unknown) => JSON.stringify(request),
}));
let mockNextId = 0;
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => `nonce-${++mockNextId}` }));
jest.mock('expo-router', () => ({
  router: { canGoBack: () => true, back: jest.fn(), replace: (href: string) => mockReplace(href) },
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
    readExtraction: async () => mockExtraction,
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
    usePagePreview: () => ({ updatePreviewFromPage: mockUpdatePreview }),
  };
});

const URL_ = 'https://example.com/post';
const LINK = {
  path: 'links/l1.enc',
  url: URL_,
  listId: 'reading',
  createdAt: Date.UTC(2026, 10, 9, 8, 7, 6),
};
const WAYBACK = 'https://web.archive.org/web/20261109080706/https://example.com/post';
const CAPTURE = { doc: { version: 1, capturedAt: 1, blocks: [] }, images: [] };
const keep = () => screen.getByTestId('capture-keep-read-mode');
const preview = () => screen.getByTestId('capture-update-preview');

async function onPage(url = URL_) {
  // The bar's menu portals out (reader-screen.spec.tsx has the same harness). A View,
  // not a fragment: pressing a disabled button walks up for a handler, and RNTL's walk
  // fails on a fragment root.
  render(
    <View>
      <CaptureScreen linkId="l1" />
      <PortalHost />
    </View>,
  );
  await screen.findByTestId('capture-webview');
  act(() => webviewProps.onNavigationStateChange({ url, loading: false }));
}

// The last request the screen injected.
function lastRequest(): { kind: string; nonce: string; capturedFrom?: string } {
  const calls = mockInject.mock.calls;
  return JSON.parse(calls[calls.length - 1][0] as string);
}

const post = (data: unknown) =>
  act(async () => webviewProps.onMessage({ nativeEvent: { data: JSON.stringify(data) } }));

const openMenu = () => fireEvent.press(screen.getByTestId('capture-more-options'));

afterEach(() => jest.restoreAllMocks());

beforeEach(() => {
  // The menu is placed only once its trigger is measured; the jest View never calls back.
  jest
    .spyOn(View.prototype, 'measure')
    .mockImplementation((callback) => callback(0, 0, 36, 36, 300, 10));
  mockLink = LINK;
  mockLocked = false;
  mockKeptCopies = true;
  mockExtraction = null;
  mockReplace.mockClear();
  mockKeepReadMode.mockClear();
  mockUpdatePreview.mockClear();
  mockInject.mockClear();
  mockShowPaywall.mockClear();
});

test('free: the page loads, no Update preview, and Keep a copy is the upgrade', async () => {
  mockKeptCopies = false;
  await onPage();
  // Both actions are Plus. A free account sets its own title and image in the editor.
  expect(screen.queryByTestId('capture-update-preview')).toBeNull();
  fireEvent.press(keep());
  expect(mockShowPaywall).toHaveBeenCalledWith('keptCopies');
  expect(mockInject).not.toHaveBeenCalled();
});

test('a link in a locked list: the unlock pane, and no page loaded', async () => {
  mockLocked = true;
  mockExtraction = { readModeId: 'r1', facets: {} };
  render(<CaptureScreen linkId="l1" />);
  await waitFor(() => expect(screen.getByTestId('lock-pane')).toBeTruthy());
  expect(screen.queryByTestId('capture-webview')).toBeNull();
  // The host is the list's contents; the exits name it too, so they hide with it.
  expect(screen.getByTestId('capture-title')).toHaveTextContent('Keep a copy');
  expect(screen.queryByText('example.com')).toBeNull();
  expect(screen.queryByTestId('capture-more-options')).toBeNull();
});

test('Read is there only while the link has a copy, and takes this screen’s place', async () => {
  await onPage();
  openMenu();
  // The positive control: the menu is open, without Read.
  expect(screen.getByTestId('capture-wayback')).toBeTruthy();
  expect(screen.queryByTestId('capture-reader')).toBeNull();

  mockExtraction = { readModeId: 'r1', facets: {} };
  screen.unmount();
  await onPage();
  openMenu();
  fireEvent.press(await screen.findByTestId('capture-reader'));
  expect(mockReplace).toHaveBeenCalledWith('/read?link=l1');
});

test('the Wayback Machine opens the capture nearest the day the link was saved', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  await onPage();
  // Built on the device; nothing is opened, or asked, before the press.
  expect(openURL).not.toHaveBeenCalled();
  openMenu();
  fireEvent.press(screen.getByTestId('capture-wayback'));
  expect(openURL).toHaveBeenCalledWith(WAYBACK);
});

test('on the link’s page, keeping asks the page and stores what comes back', async () => {
  // http vs https and a trailing slash are still the same page.
  await onPage('http://example.com/post/');
  fireEvent.press(keep());
  const request = lastRequest();
  expect(request.kind).toBe('readMode');

  await post({ type: 'bracemark-read-mode', nonce: request.nonce, href: URL_, doc: CAPTURE });
  expect(mockKeepReadMode).toHaveBeenCalledWith(LINK, CAPTURE, {
    fetchFromPage: expect.any(Function),
  });
  expect(await screen.findByText('Kept — read it')).toBeTruthy();
});

test('the copy’s images are asked of the page that was captured', async () => {
  // keepReadMode calls the fetch it is handed only when the account keeps images;
  // here it does, so the spec plays the page's image answers.
  let images: Promise<Map<string, Uint8Array>> | undefined;
  mockKeepReadMode.mockImplementationOnce(async (_link, _doc, options) => {
    const { fetchFromPage } = options as {
      fetchFromPage: (sources: { key: string; url: string }[]) => Promise<Map<string, Uint8Array>>;
    };
    images = fetchFromPage([{ key: 'i0', url: 'https://cdn.example/a.jpg' }]);
    await images;
    return true;
  });
  await onPage();
  fireEvent.press(keep());
  await post({ type: 'bracemark-read-mode', nonce: lastRequest().nonce, href: URL_, doc: CAPTURE });

  const request = lastRequest();
  expect(request).toMatchObject({ kind: 'readerImages', capturedFrom: URL_ });
  await post({ type: 'bracemark-page-image', nonce: request.nonce, key: 'i0', base64: 'AQID' });
  // A key the request didn't ask for is not taken.
  await post({ type: 'bracemark-page-image', nonce: request.nonce, key: 'i9', base64: 'AQID' });
  await post({ type: 'bracemark-page-images-done', nonce: request.nonce });

  await expect(images).resolves.toEqual(new Map([['i0', new Uint8Array([1, 2, 3])]]));
});

test('on another page the user followed a link to, both buttons are off', async () => {
  await onPage('https://elsewhere.example/other');
  expect(keep().props.accessibilityState?.disabled).toBe(true);
  expect(preview().props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(keep());
  fireEvent.press(preview());
  expect(mockInject).not.toHaveBeenCalled();
  expect(
    screen.getByText('Go back to the saved page to update its preview or keep a copy.'),
  ).toBeTruthy();
});

// ⚠ The WebView can navigate between the tap and the page's answer; a copy taken then
// is another page's, filed under this link at the tier nothing outranks.
test('an answer from a page that is no longer the link’s is refused', async () => {
  await onPage();
  fireEvent.press(keep());
  await post({
    type: 'bracemark-read-mode',
    nonce: lastRequest().nonce,
    href: 'https://elsewhere.example/other',
    doc: CAPTURE,
  });
  expect(mockKeepReadMode).not.toHaveBeenCalled();
  // A failure that mounts after a tap is an alert (docs/accessibility.md, _the one
  // rule_), never the quiet status line the screen's other outcomes use.
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Could not keep a read-mode copy. Please try again.',
  );
});

test('a message nobody asked for is ignored', async () => {
  await onPage();
  await post({ type: 'bracemark-read-mode', nonce: 'nonce-1', href: URL_, doc: CAPTURE });
  expect(mockKeepReadMode).not.toHaveBeenCalled();
});

test('while a request waits, only a message with its nonce counts', async () => {
  await onPage();
  fireEvent.press(keep());
  const { nonce } = lastRequest();
  await post({ type: 'bracemark-read-mode', nonce: 'someone-else', href: URL_, doc: CAPTURE });
  expect(mockKeepReadMode).not.toHaveBeenCalled();
  // The positive control: the same message with the request's nonce is the answer.
  await post({ type: 'bracemark-read-mode', nonce, href: URL_, doc: CAPTURE });
  expect(mockKeepReadMode).toHaveBeenCalledTimes(1);
});

test('a message longer than any honest capture sends is dropped unread, even with the right nonce', async () => {
  // The page can send anything, at any length, as often as it likes. An honest document is held to
  // 3M characters by the page's own script and an image message is the base64 of one image of at
  // most 8 MB, so a string past ~11M characters is not one of ours and is not even parsed.
  await onPage();
  fireEvent.press(keep());
  const { nonce } = lastRequest();
  const parse = jest.spyOn(JSON, 'parse');

  await act(async () =>
    webviewProps.onMessage({
      nativeEvent: {
        data: JSON.stringify({
          type: 'bracemark-read-mode',
          nonce,
          href: URL_,
          pad: 'x'.repeat(12_000_000),
        }),
      },
    }),
  );

  expect(parse).not.toHaveBeenCalled();
  expect(mockKeepReadMode).not.toHaveBeenCalled();
  parse.mockRestore();
  // The positive control: the honest message with the same nonce is still the answer.
  await post({ type: 'bracemark-read-mode', nonce, href: URL_, doc: CAPTURE });
  expect(mockKeepReadMode).toHaveBeenCalledTimes(1);
});

test('the page cannot send the user to another app: every origin passes the library, the screen decides', async () => {
  // react-native-webview hands a URL outside `originWhitelist` to Linking.openURL. Whitelisting
  // everything keeps a page's redirect from ever reaching it, and the handler refuses what is not
  // the web (capture-navigation.spec.ts has the table).
  await onPage();

  expect(webviewProps.originWhitelist).toEqual(['*']);
  // Android opens `window.open` / `target="_blank"` in a separate window whose client has no
  // handler of ours; false keeps those navigations in this WebView, under the handler below.
  expect(webviewProps.setSupportMultipleWindows).toBe(false);
  const decide = webviewProps.onShouldStartLoadWithRequest;
  expect(decide({ url: 'https://example.com/next', isTopFrame: true })).toBe(true);
  expect(decide({ url: 'intent://scan/#Intent;scheme=zxing;end', isTopFrame: true })).toBe(false);
  expect(decide({ url: 'mailto:someone@example.com', isTopFrame: true })).toBe(false);
  expect(decide({ url: 'file:///etc/passwd', isTopFrame: true })).toBe(false);
});

test('a page with no article says so and stores nothing', async () => {
  await onPage();
  fireEvent.press(keep());
  await post({ type: 'bracemark-read-mode', nonce: lastRequest().nonce, href: URL_, doc: null });
  expect(mockKeepReadMode).not.toHaveBeenCalled();
  expect(screen.getByText('No article on this page to keep as text.')).toBeTruthy();
});

test('Update preview reads the page’s candidates and hands over only their strings', async () => {
  await onPage();
  fireEvent.press(preview());
  const request = lastRequest();
  expect(request.kind).toBe('meta');

  await post({
    type: 'bracemark-page-meta',
    nonce: request.nonce,
    href: URL_,
    // A page's scripts can post anything in these fields.
    collected: { ogTitle: 'The OG title', ogImage: { toString: 'x' }, docTitle: 7 },
  });
  expect(mockUpdatePreview).toHaveBeenCalledWith(LINK, {
    href: URL_,
    collected: { ogTitle: 'The OG title' },
    fetchFromPage: expect.any(Function),
  });
  expect(await screen.findByText('Preview updated.')).toBeTruthy();
});

test('Update preview says when the title the user set still wins', async () => {
  mockLink = { ...LINK, customTitle: 'Mine' };
  await onPage();
  fireEvent.press(preview());
  await post({
    type: 'bracemark-page-meta',
    nonce: lastRequest().nonce,
    href: URL_,
    collected: {},
  });
  expect(await screen.findByText('Preview updated. The title you set still shows.')).toBeTruthy();
});

// A link saved as plain HTTP. Release builds can't load one at all — Android forbids
// cleartext, iOS's App Transport Security refuses it — so the https twin loads first
// (docs/link-extraction.md, _plain-HTTP links on a phone_).
test('loads a plain-HTTP link over https first, and the saved address after a load error', async () => {
  mockLink = { ...LINK, url: 'http://example.com/post' };
  render(<CaptureScreen linkId="l1" />);
  await screen.findByTestId('capture-webview');
  expect(webviewProps.source.uri).toBe('https://example.com/post');

  act(() => webviewProps.onError());
  expect(webviewProps.source.uri).toBe('http://example.com/post');
});

// ⚠ The WebView then shows its own error page. Reading it can only fail, and the
// failure's "try again" can't help — measured on an Android release build, where a
// plain-HTTP-only site answered both taps with an alert.
test('a page that didn’t load: both buttons off, and the line says why', async () => {
  await onPage();
  act(() => webviewProps.onError());
  expect(keep().props.accessibilityState?.disabled).toBe(true);
  expect(preview().props.accessibilityState?.disabled).toBe(true);
  expect(
    screen.getByText('This page didn’t load, so there’s nothing to update or keep from it.'),
  ).toBeTruthy();
  fireEvent.press(preview());
  expect(mockInject).not.toHaveBeenCalled();
  // The moment the Wayback Machine is for, so it is offered in words.
  expect(screen.getByTestId('capture-wayback-load-failed')).toBeTruthy();

  // A new load clears it — the positive control.
  act(() => webviewProps.onLoadStart());
  expect(preview().props.accessibilityState?.disabled).toBeFalsy();
  expect(screen.queryByTestId('capture-wayback-load-failed')).toBeNull();
});
