import { useRef, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { router } from 'expo-router';
import { BookOpen, Check, History, RefreshCw, X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import {
  type LinkItem,
  readExtraction,
  readLinkById,
  useEntitlements,
  useKeptCopyMutations,
  useLiveRead,
  useLocks,
  usePagePreview,
} from '@stxapps/expo-react';
import { LOCK_COPY } from '@stxapps/react';
import {
  canonicalUrlKey,
  hostFromText,
  httpsUpgradeOf,
  openableUrl,
  PLAN_LABELS,
  waybackUrl,
} from '@stxapps/shared';

import { ErrorText } from '../../components/error-text';
import { LockPane } from '../../components/lock-pane';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { usePaywall } from '../../contexts/paywall-provider';
import { openWayback } from '../links/shared';
import { isCaptureNavigationAllowed } from './capture-navigation';
import { usePageCapture } from './use-page-capture';

// The capture screen — the browser extension's popup, rebuilt around a WebView: the
// saved page, open, with two actions under it. _Update preview_ re-reads the link's
// title and preview image from the page; _Keep a copy_ keeps its article, with its
// images, as a read-mode copy. "Keep a copy", not the reader's "Keep a read-mode
// copy": the two buttons share one row, at half a phone's width each, and the longer
// label wraps there. The short one is still exact — a read-mode copy is the only kind
// the phone takes — and it is the family its other states belong to (_Keep a new
// copy_, _Kept — read it_). docs/brand-assets.md, _terminology_, the read mode row. The one way this app takes either from a live page on its own (an iOS share
// from Safari is the other, for read mode, and needs no screen —
// docs/link-extraction-keep.md, _per client_, bracemark-expo).
//
// Reached from the row menu's "Read" on a link with no copy, and from the reader's
// _Update from the page_ on one that has one (docs/reader.md, _the way in_). Its top
// bar goes the other way — _Read_, while the link has a copy — and to the Wayback
// Machine, for the page that has changed or gone: the two exits the row menu no longer
// carries. Every move between this screen and the reader is a REPLACE, so the two
// trade places and never stack.
//
// A WebView, not an in-app browser: SFSafariViewController and Chrome Custom Tabs
// can't be scripted, and both actions run code inside the page. The cost is that the
// WebView has its OWN cookie store — the user's Safari or Chrome sign-ins don't carry
// over — so the first visit to a site behind a sign-in is a sign-in here; the store
// persists, so it is the only one. That session is the point of the screen: the page's
// text, its preview and its pictures are read as the signed-in user sees them, which
// no fetch of the address alone can do.
//
// The rules, each one the browser extension's or the reader's, and each silent if
// dropped:
//
//   - LOCKS FIRST: a link in a locked list doesn't load at all until it's unlocked —
//     loading the page is reading the list's contents.
//   - BOTH ACTIONS ARE PLUS (`keptCopies`). No route brings a free account here — the
//     row menu's "Read" and the reader's way across are both paid-only without a copy
//     — so this is for one that arrives anyway: a plan lapsing while the screen is
//     open, an old address. There _Update preview_ is not offered at all (a free
//     account sets its own title and image in the editor instead), and _Keep read
//     mode_ is marked Plus and opens the upgrade instead of capturing (the browser
//     extension's saved screen does the same). The page itself still loads: it is
//     the user's own link, and the Wayback Machine is the same on every plan.
//   - THE PAGE MUST STILL BE THE LINK'S. The user can follow links inside the
//     WebView; a copy or a preview taken then would be ANOTHER page's, filed under this
//     link at `expo:fg` — the top tier, which nothing outranks later. The buttons are
//     live only while the WebView's current URL has the link's canonical identity
//     (`canonicalUrlKey`, so http→https and a trailing slash still match), and the
//     address the PAGE reports with its answer is checked again, for a navigation
//     between the tap and the answer. The page re-checks it before every image fetch
//     too (web-react lib/webview-capture.ts).
//   - THE CONVERSATION IS use-page-capture.ts's: one request at a time, an answer
//     counted only with its request's nonce, every request ending.
//
// No screenshot yet: a WebView can't photograph itself, and the module that can
// (react-native-view-shot) is a second native dependency, not taken in this change.

const StyledSafeAreaView = withUniwind(SafeAreaView);

// The outcome of a tap. A failure is an error that MOUNTS, so it goes to ErrorText
// (role="alert" — docs/accessibility.md, _the one rule_) in the fixed error shape
// (docs/brand-assets.md, _errors have a fixed shape_); every other outcome is a quiet
// status line.
const NOTICE = {
  noArticle: 'No article on this page to keep as text.',
  offPage: 'Go back to the saved page to update its preview or keep a copy.',
  loadFailed: 'This page didn’t load, so there’s nothing to update or keep from it.',
} as const;
const FAILURE = {
  keep: 'Could not keep a read-mode copy. Please try again.',
  preview: 'Could not update the preview. Please try again.',
} as const;

// What _Update preview_ says it did. Only what was had is written (expo-react
// data/store-page-preview.ts), so a missing image is reported, not hidden — and a title
// or image the user set by hand still wins over the page's, which the screen says
// rather than leaving the list looking unchanged.
function previewNotice(outcome: { title: boolean; image: boolean }, link: LinkItem): string {
  if (!outcome.title && !outcome.image) return 'No title or image found on this page.';
  const done =
    outcome.title && outcome.image
      ? 'Preview updated.'
      : outcome.title
        ? 'Title updated. No preview image could be fetched from this page.'
        : 'Image updated.';
  const ownTitle = outcome.title && Boolean(link.customTitle);
  const ownImage = outcome.image && Boolean(link.customImageId);
  if (ownTitle && ownImage) return `${done} The title and image you set still show.`;
  if (ownTitle) return `${done} The title you set still shows.`;
  if (ownImage) return `${done} The image you set still shows.`;
  return done;
}

function close(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/links');
}

export function CaptureScreen({ linkId }: { linkId: string }) {
  const { status: lockStatus, isListLocked, unlockList } = useLocks();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const { keepReadMode } = useKeptCopyMutations();
  const { updatePreviewFromPage } = usePagePreview();
  const link = useLiveRead(() => readLinkById(linkId).then((l) => l ?? null), [linkId], ['items']);
  const extraction = useLiveRead(
    () => readExtraction(linkId).then((e) => e ?? null),
    [linkId],
    ['items'],
  );

  const webview = useRef<WebView>(null);
  const page = usePageCapture(webview);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'readMode' | 'preview' | null>(null);
  const [kept, setKept] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  // Set when the https twin of a plain-HTTP link failed to load (see `source` below).
  const [secureFailed, setSecureFailed] = useState(false);
  // Set when the page itself failed to load — no https twin left to try. Both actions
  // read the page, and a WebView that failed shows its own error page instead: reading
  // that would answer "couldn't" at best, and a tap that can only fail is a dead end
  // ("Please try again" can't help a page this build can't open). So the buttons go off
  // and the status line says why (docs/accessibility.md, _a `disabled` button says
  // nothing either_). Any new load clears it.
  const [loadFailed, setLoadFailed] = useState(false);

  const settled = link !== undefined && extraction !== undefined && lockStatus === 'ready';
  const locked = settled && link !== null && isListLocked(link.listId);
  const entitled = entitlements.keptCopies;
  const href = link ? openableUrl(link.url) : undefined;
  // A plain-HTTP link loads over `https://` FIRST: this app's release builds can't load a
  // plain-HTTP page at all — Android forbids cleartext, iOS's App Transport Security
  // refuses it — and most such sites answer on https (docs/link-extraction.md,
  // _plain-HTTP links on a phone_). If that load fails, the saved address is tried, which
  // a debug build and a local host can still reach. `canonicalUrlKey` treats the two
  // schemes as one page, so the buttons stay live on either.
  const secureHref = href ? httpsUpgradeOf(href) : undefined;
  const sourceUri = secureHref && !secureFailed ? secureHref : href;
  const fallBackFromSecure = () => {
    if (sourceUri === secureHref) setSecureFailed(true);
  };
  const onLoadError = () => {
    if (sourceUri === secureHref) setSecureFailed(true);
    else setLoadFailed(true);
  };
  const host = link ? hostFromText(link.url) : '';
  // Both exits hide behind a lock, as the reader's do: the host is the list's contents.
  const waybackHref = link && !locked ? waybackUrl(link.url, link.createdAt) : undefined;
  const hasCopy = Boolean(extraction?.readModeId || extraction?.screenshotId);
  const isLinkPage = (url: string | null | undefined): boolean =>
    Boolean(link && url) &&
    canonicalUrlKey(url as string) !== null &&
    canonicalUrlKey(url as string) === canonicalUrlKey((link as LinkItem).url);
  const onLinkPage = isLinkPage(currentUrl);
  const ready = onLinkPage && !loading && !loadFailed && busy === null;

  const keep = async () => {
    if (!entitled) {
      paywall.show('keptCopies');
      return;
    }
    if (!link || !ready) return;
    setBusy('readMode');
    setNotice('');
    setFailure('');
    try {
      const answer = await page.readMode();
      if (!answer || !isLinkPage(answer.href)) {
        setFailure(FAILURE.keep);
        return;
      }
      if (answer.capture === null) {
        setNotice(NOTICE.noArticle);
        return;
      }
      // The images are asked of the page first (its session reaches what the native
      // fetch can't) and fetched natively where it couldn't — only when the account
      // keeps images, which keepReadMode decides.
      const stored = await keepReadMode(link, answer.capture, {
        fetchFromPage: (sources) => page.readerImages(sources, answer.href),
      });
      if (stored) setKept(true);
      else setFailure(FAILURE.keep);
    } catch {
      setFailure(FAILURE.keep);
    } finally {
      setBusy(null);
    }
  };

  const updatePreview = async () => {
    if (!entitled || !link || !ready) return;
    setBusy('preview');
    setNotice('');
    setFailure('');
    try {
      const answer = await page.meta();
      if (!answer || !isLinkPage(answer.href)) {
        setFailure(FAILURE.preview);
        return;
      }
      const outcome = await updatePreviewFromPage(link, {
        href: answer.href,
        collected: answer.collected,
        fetchFromPage: (url) => page.previewImage(url, answer.href),
      });
      setNotice(previewNotice(outcome, link));
    } catch {
      setFailure(FAILURE.preview);
    } finally {
      setBusy(null);
    }
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
  } else {
    const plus = PLAN_LABELS.plus;
    body = (
      <>
        <WebView
          ref={webview}
          testID="capture-webview"
          source={{ uri: sourceUri as string }}
          // `style`, not `className`: WebView is a composite, not a core host, so
          // Uniwind's className doesn't reach it (the expo-image note in link-media).
          style={{ flex: 1 }}
          // The app's persistent cookie store (iOS) / third-party cookies (Android),
          // so a site signed in to here once stays signed in.
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          // Every origin passes the library's own whitelist, because a URL that fails it is
          // handed to `Linking.openURL` (another app, from a page's redirect); the decision is
          // ours, below (capture-navigation.ts).
          originWhitelist={['*']}
          // Android: with the default (true), `window.open` and `target="_blank"` go to a
          // separate window's own client, which has no handler of ours — so a page could reach
          // an address the rule below refuses. False loads them in THIS WebView, where
          // `onShouldStartLoadWithRequest` sees them like any other navigation.
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) =>
            isCaptureNavigationAllowed(request.url, request.isTopFrame)
          }
          onNavigationStateChange={(nav) => {
            setCurrentUrl(nav.url);
            setLoading(nav.loading);
          }}
          onMessage={page.onMessage}
          onLoadStart={() => setLoadFailed(false)}
          onError={onLoadError}
          // The https twin answered, but not with the page (a default vhost's 404, a
          // certificate the server only half has): the saved address is the page.
          onHttpError={(event) => {
            if (event.nativeEvent.statusCode >= 400) fallBackFromSecure();
          }}
        />
        <View className="gap-2 border-t border-border px-4 py-3">
          <View className="flex-row gap-2">
            {entitled ? (
              <Button
                variant="outline"
                className="flex-1"
                testID="capture-update-preview"
                disabled={!ready}
                onPress={() => void updatePreview()}
              >
                <Icon as={RefreshCw} className="size-4 text-foreground" />
                <Text>{busy === 'preview' ? 'Updating…' : 'Update preview'}</Text>
              </Button>
            ) : null}
            {kept ? (
              <Button
                variant="outline"
                className="flex-1"
                testID="capture-read"
                onPress={() => router.replace(`/read?link=${encodeURIComponent(linkId)}`)}
              >
                <Icon as={Check} className="size-4 text-foreground" />
                <Text>Kept — read it</Text>
              </Button>
            ) : (
              <Button
                className="flex-1"
                testID="capture-keep-read-mode"
                // On free the button is the upgrade, so it is never disabled there — and
                // its name says what it is (the browser extension's saved screen does
                // the same).
                aria-label={entitled ? undefined : `Keep a copy — a ${plus} feature`}
                disabled={entitled && !ready}
                onPress={() => void keep()}
              >
                <Icon as={BookOpen} className="size-4 text-primary-foreground" />
                <Text>
                  {busy === 'readMode'
                    ? 'Keeping…'
                    : extraction?.readModeId
                      ? 'Keep a new copy'
                      : 'Keep a copy'}
                </Text>
                {entitled ? null : <Text className="text-xs opacity-80">{plus}</Text>}
              </Button>
            )}
          </View>
          {failure ? (
            <ErrorText className="text-center text-xs">{failure}</ErrorText>
          ) : (
            <Text className="text-center text-xs text-muted-foreground" role="status">
              {notice ||
                (loadFailed ? NOTICE.loadFailed : !onLinkPage && !loading ? NOTICE.offPage : '')}
            </Text>
          )}
          {/* A page that didn't load is the moment the Wayback Machine is for, so it is
              said in words here, not left to the top bar's icon. */}
          {loadFailed && waybackHref ? (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              testID="capture-wayback-load-failed"
              onPress={() => openWayback(waybackHref)}
            >
              <Icon as={History} className="size-4 text-foreground" />
              <Text>Open in Wayback Machine</Text>
            </Button>
          ) : null}
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
        {link && !locked && hasCopy ? (
          <Button
            variant="ghost"
            size="sm"
            testID="capture-reader"
            onPress={() => router.replace(`/read?link=${encodeURIComponent(linkId)}`)}
          >
            <Icon as={BookOpen} className="size-4 text-foreground" />
            <Text>Read</Text>
          </Button>
        ) : null}
        {waybackHref ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Open in Wayback Machine"
            testID="capture-wayback"
            onPress={() => openWayback(waybackHref)}
          >
            <Icon as={History} className="size-5 text-foreground" />
          </Button>
        ) : null}
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
