import { useRef, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { router } from 'expo-router';
import { BookOpen, Check, X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import {
  readExtraction,
  readLinkById,
  useEntitlements,
  useKeptCopyMutations,
  useLiveRead,
  useLocks,
} from '@stxapps/expo-react';
import { LOCK_COPY } from '@stxapps/react';
import { canonicalUrlKey, hostFromText, openableUrl } from '@stxapps/shared';

import { LockPane } from '../../components/lock-pane';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { usePaywall } from '../../contexts/paywall-provider';
import { READER_CAPTURE_SCRIPT } from './reader-capture-script.generated';

// The capture screen — the browser extension's popup, rebuilt around a WebView: the
// saved page, open, with "Keep read mode" under it. The one way this app takes a
// copy on its own (an iOS share from Safari is the other, and needs no screen —
// docs/link-extraction-keep.md, _expo_).
//
// A WebView, not an in-app browser: SFSafariViewController and Chrome Custom Tabs
// can't be scripted, and taking a copy means running the converter inside the page.
// The cost is that the WebView has its OWN cookie store — the user's Safari or Chrome
// sign-ins don't carry over — so the first visit to a site behind a sign-in is a
// sign-in here; the store persists, so it is the only one.
//
// The rules, each one the browser extension's or the reader's, and each silent if
// dropped:
//
//   - LOCKS FIRST: a link in a locked list doesn't load at all until it's unlocked —
//     loading the page is reading the list's contents.
//   - THE PLAN GATES THE CAPTURE, here, before the page is even loaded: a free
//     account gets the upgrade, not a page with a button that refuses.
//   - THE PAGE MUST STILL BE THE LINK'S. The user can follow links inside the
//     WebView; a copy taken then would be ANOTHER page's text filed under this link,
//     permanently (`expo:fg` is the top tier — nothing outranks it later). The
//     button is live only while the WebView's current URL has the link's canonical
//     identity (`canonicalUrlKey`, so http→https and a trailing slash still match),
//     the browser extension's stale-tab guard in another shape.
//   - A MESSAGE IS ACCEPTED ONLY WHILE ONE IS AWAITED. The page's own scripts can
//     call `window.ReactNativeWebView.postMessage` too; outside a capture this
//     screen ignores everything, and inside one it takes the first answer, which
//     `keepReadMode` validates against the ReaderDoc schema before storing.
//
// No screenshot yet: a WebView can't photograph itself, and the module that can
// (react-native-view-shot) is a second native dependency, not taken in this change.

const StyledSafeAreaView = withUniwind(SafeAreaView);

type Phase = 'idle' | 'capturing' | 'kept' | 'noArticle' | 'failed';

function close(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/links');
}

export function CaptureScreen({ linkId }: { linkId: string }) {
  const { status: lockStatus, isListLocked, unlockList } = useLocks();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const { keepReadMode } = useKeptCopyMutations();
  const link = useLiveRead(() => readLinkById(linkId).then((l) => l ?? null), [linkId], ['items']);
  const extraction = useLiveRead(
    () => readExtraction(linkId).then((e) => e ?? null),
    [linkId],
    ['items'],
  );

  const webview = useRef<WebView>(null);
  const awaiting = useRef(false);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');

  const settled = link !== undefined && extraction !== undefined && lockStatus === 'ready';
  const locked = settled && link !== null && isListLocked(link.listId);
  const href = link ? openableUrl(link.url) : undefined;
  const host = link ? hostFromText(link.url) : '';
  const onLinkPage =
    link !== null &&
    link !== undefined &&
    currentUrl !== null &&
    canonicalUrlKey(currentUrl) !== null &&
    canonicalUrlKey(currentUrl) === canonicalUrlKey(link.url);

  const capture = () => {
    if (!onLinkPage || awaiting.current) return;
    awaiting.current = true;
    setPhase('capturing');
    webview.current?.injectJavaScript(READER_CAPTURE_SCRIPT);
  };

  const onMessage = (event: WebViewMessageEvent) => {
    if (!awaiting.current || !link) return;
    awaiting.current = false;
    let message: unknown;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      setPhase('failed');
      return;
    }
    const { type, doc } = (message ?? {}) as { type?: unknown; doc?: unknown };
    if (type !== 'bracemark-read-mode') {
      setPhase('failed');
      return;
    }
    if (doc === null) {
      setPhase('noArticle');
      return;
    }
    void keepReadMode(link, doc).then(
      (stored) => setPhase(stored ? 'kept' : 'failed'),
      () => setPhase('failed'),
    );
  };

  let body: React.ReactNode = null;
  if (!settled) {
    body = null;
  } else if (link === null || !href) {
    body = (
      <View className="items-center px-6 py-16">
        <Text className="text-center text-base font-semibold">
          {link === null ? 'This link isn’t in your library' : 'This link can’t be opened'}
        </Text>
      </View>
    );
  } else if (locked) {
    body = (
      <LockPane
        testID="capture-lock-pane"
        title={LOCK_COPY.list.title}
        description={LOCK_COPY.list.description}
        onUnlock={(password) => unlockList(link.listId, password)}
      />
    );
  } else if (!entitlements.keptCopies) {
    body = (
      <View className="items-center gap-4 px-6 py-16">
        <Text className="text-center text-base font-semibold">Keep a copy of this page</Text>
        <Text className="text-center text-sm text-muted-foreground">
          Keeping the text of a page in read mode is a Plus feature. Copies you have already kept
          stay readable on every plan.
        </Text>
        <Button testID="capture-upgrade" onPress={() => paywall.show('keptCopies')}>
          <Text>Keep copies with Plus</Text>
        </Button>
      </View>
    );
  } else {
    body = (
      <>
        <WebView
          ref={webview}
          testID="capture-webview"
          source={{ uri: href }}
          // `style`, not `className`: WebView is a composite, not a core host, so
          // Uniwind's className doesn't reach it (the expo-image note in link-media).
          style={{ flex: 1 }}
          // The app's persistent cookie store (iOS) / third-party cookies (Android),
          // so a site signed in to here once stays signed in.
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          onNavigationStateChange={(nav) => {
            setCurrentUrl(nav.url);
            setLoading(nav.loading);
          }}
          onMessage={onMessage}
        />
        <View className="gap-2 border-t border-border px-4 py-3">
          {phase === 'kept' ? (
            <Button
              variant="outline"
              testID="capture-read"
              onPress={() => router.replace(`/read?link=${encodeURIComponent(linkId)}`)}
            >
              <Icon as={Check} className="size-4 text-foreground" />
              <Text>Kept — read it</Text>
            </Button>
          ) : (
            <Button
              testID="capture-keep-read-mode"
              disabled={!onLinkPage || loading || phase === 'capturing'}
              onPress={capture}
            >
              <Icon as={BookOpen} className="size-4 text-primary-foreground" />
              <Text>
                {phase === 'capturing'
                  ? 'Keeping…'
                  : extraction?.readModeId
                    ? 'Keep read mode again'
                    : 'Keep read mode'}
              </Text>
            </Button>
          )}
          <Text className="text-center text-xs text-muted-foreground" role="status">
            {phase === 'noArticle'
              ? 'No article on this page to keep as text.'
              : phase === 'failed'
                ? 'Couldn’t keep a copy. Try again.'
                : !onLinkPage && !loading
                  ? 'Go back to the saved page to keep its copy.'
                  : ''}
          </Text>
        </View>
      </>
    );
  }

  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      <View className="h-14 shrink-0 flex-row items-center gap-2 border-b border-border px-3">
        <Text
          className="min-w-0 flex-1 pl-1 text-sm font-medium text-muted-foreground"
          numberOfLines={1}
        >
          {host || 'Keep a copy'}
        </Text>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 size-9"
          aria-label="Close"
          testID="capture-close"
          onPress={close}
        >
          <Icon as={X} className="size-5 text-foreground" />
        </Button>
      </View>
      {body}
    </StyledSafeAreaView>
  );
}
