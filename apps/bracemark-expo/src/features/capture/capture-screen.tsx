import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { router } from 'expo-router';
import { BookOpen, Check, History, RefreshCw } from 'lucide-react-native';
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
  useSettingMutations,
  useSettings,
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
import { Checkbox } from '../../components/ui/checkbox';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { usePaywall } from '../../contexts/paywall-provider';
import { openWayback } from '../../lib/open-url';
import { ReaderTopbar, type ReaderTopbarAction } from '../reader/topbar';
import { isCaptureNavigationAllowed } from './capture-navigation';
import { usePageCapture } from './use-page-capture';

// The capture screen — the browser extension's popup, rebuilt around a WebView: the
// saved page, open, with two actions under it. _Keep a copy_ keeps its article as a
// read-mode copy — with its images when _Include images_, under it, is ticked
// (IncludeImages, below); _Update preview_ re-reads the link's title and preview image
// from the page. "Keep a copy", not the reader's "Keep a read-mode copy": the two
// buttons share one row, at half a phone's width each, and the longer label wraps
// there. The short one is still exact — a read-mode copy is the only kind the phone
// takes — and it is the family its other states belong to (_Keep a new copy_, _Kept —
// read it_). docs/brand-assets.md, _terminology_, the read mode row. The one way this
// app takes either from a live page on its own (an iOS share
// from Safari is the other, for read mode, and needs no screen —
// docs/link-extraction-keep.md, _per client_, bracemark-expo).
//
// Reached from the row menu's "Read" on a link with no copy, and from the reader's
// _Update from the page_ on one that has one (docs/reader.md, _the way in_). Its top
// bar is the reader's (reader/topbar.tsx), and its ⋯ menu goes the other way —
// _Read_, while the link has a copy — and to the Wayback Machine, for the page that
// has changed or gone: the two exits the row menu no longer carries. Every move
// between this screen and the reader is a REPLACE, so the two trade places and never
// stack.
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
//   - WHAT IS KEPT IS THE PAGE ON SCREEN. Not necessarily the saved address: a
//     shortener, an `m.` or AMP host, a sign-in wall and the user's own taps all land
//     somewhere else, and a rule that the page be the link's own left both buttons off
//     on every link that redirects, with no page to "go back" to. Both actions are a
//     tap on the page the user is looking at — its host is in the top bar — so they
//     take that page, filed under this link at `expo:fg`; a tap on the wrong page is
//     seen and redone. What IS checked is that the page answering is the one shown at
//     the tap (`samePage`, `canonicalUrlKey`, so http→https and a trailing slash still
//     match): a page can navigate itself between the tap and the answer, and a copy
//     taken then would be one the user never saw. The page re-checks its own address
//     before every image fetch too (web-react lib/webview-capture.ts). Moving to
//     another page re-arms both buttons, so a page reached after one was kept can be
//     kept instead.
//   - THE CONVERSATION IS use-page-capture.ts's: one request at a time, an answer
//     counted only with its request's nonce, every request ending.
//
// No screenshot yet: a WebView can't photograph itself, and the module that can
// (react-native-view-shot) is a second native dependency, not taken in this change.

const StyledSafeAreaView = withUniwind(SafeAreaView);

// One page, as the screen tells pages apart: the same canonical identity.
function samePage(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = a ? canonicalUrlKey(a) : null;
  return key !== null && b != null && key === canonicalUrlKey(b);
}

// The footer's words, and why only these mount a line. A tap that WORKED says so on its
// own button — _Kept — read it_, _Preview updated_ — so the bar doesn't grow under the
// page for good news. A tap that failed or fell short MOUNTS a message, so it is
// ErrorText (role="alert" — docs/accessibility.md, _the one rule_), in the fixed error
// shape (docs/brand-assets.md, _errors have a fixed shape_): `error` for what didn't
// happen, `warning` for what happened only in part. The one quiet line left is
// STANDING state, not an outcome: why the buttons are off (REASON) — a disabled button
// must have its reason beside it (docs/accessibility.md, _a `disabled` button says
// nothing either_) — and it comes and goes with a navigation, when the page above is
// changing anyway.
const REASON = {
  loadFailed: 'This page didn’t load, so there’s nothing to update or keep from it.',
} as const;
const FAILURE = {
  keep: 'Could not keep a read-mode copy. Please try again.',
  preview: 'Could not update the preview. Please try again.',
  noArticle: 'No article on this page to keep as text.',
  noPreview: 'No title or image found on this page.',
} as const;

type Message = { text: string; tone: 'error' | 'warning' };

// What _Update preview_ did: the button's done label, and what it must add in words.
// Only what was had is written (expo-react data/store-page-preview.ts), so a missing
// image is reported, not hidden — and a title or image the user set by hand still wins
// over the page's, which the screen says rather than leaving the list looking
// unchanged. Labels stay as short as _Update preview_: the button is half a phone wide.
function previewOutcome(
  outcome: { title: boolean; image: boolean },
  link: LinkItem,
): { label: string | null; message: Message | null } {
  if (!outcome.title && !outcome.image) {
    return { label: null, message: { text: FAILURE.noPreview, tone: 'error' } };
  }
  const label =
    outcome.title && outcome.image
      ? 'Preview updated'
      : outcome.title
        ? 'Title updated'
        : 'Image updated';
  const notes: string[] = [];
  if (outcome.title && !outcome.image) {
    notes.push('No preview image could be fetched from this page.');
  }
  const ownTitle = outcome.title && Boolean(link.customTitle);
  const ownImage = outcome.image && Boolean(link.customImageId);
  if (ownTitle && ownImage) notes.push('The title and image you set still show.');
  else if (ownTitle) notes.push('The title you set still shows.');
  else if (ownImage) notes.push('The image you set still shows.');
  return {
    label,
    message: notes.length > 0 ? { text: notes.join(' '), tone: 'warning' } : null,
  };
}

// _Include images_ under _Keep a copy_, the box web's keep section has: the synced
// `keepReadModeImages`, the same value as Settings → Read mode's switch, so ticking it
// here changes it on every device — as web's does. Here because the default is off and
// this is the phone's one place to keep a copy: without it, copies come out
// text-only and the reason is in Settings. keepReadMode reads the setting from
// the store at the press, so the box needs no wiring of its own; it is off during a
// keep, which has already read it, and stays off under _Kept — read it_ once the keep
// is done — still there, so the footer keeps its height (taking the 44pt row away
// shrank the bar and jumped the WebView at the moment the user was looking at it), and
// still showing what the copy was asked for. Plus only. A failed write needs no
// message: the box is bound to the stored value, so it simply doesn't change.
//
// The ROW is the checkbox to a screen reader (account-section.tsx's delete
// confirmation has why the role and state are on the Pressable), and it takes the
// 44pt floor as height, not slop — slop would reach up over the button
// (docs/accessibility.md, _a 36dp box is not a 44pt target_).
function IncludeImages({ disabled }: { disabled: boolean }) {
  const { keepOnSave } = useSettings();
  const { setKeepOnSave } = useSettingMutations();
  const checked = keepOnSave.readModeImages;
  const set = (readModeImages: boolean) => {
    if (disabled) return;
    void setKeepOnSave({ readModeImages }).catch(() => undefined);
  };
  return (
    <Pressable
      role="checkbox"
      testID="capture-include-images"
      aria-checked={checked}
      disabled={disabled}
      className="min-h-11 flex-row items-center justify-center gap-2"
      onPress={() => set(!checked)}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        hitSlop={0}
        onCheckedChange={(v) => set(v === true)}
      />
      <Text className="text-sm text-muted-foreground">Include images</Text>
    </Pressable>
  );
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
  // _Update preview_'s done label (previewOutcome), and the button is off once it's set:
  // the label says why, and a second read of the same page would write the same thing.
  const [previewDone, setPreviewDone] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
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
  // The page's own host, not the saved one: after a redirect or a tap they differ, and
  // the top bar is how the user sees which page the buttons will take.
  const host = link ? hostFromText(currentUrl ?? link.url) : '';
  // Both exits hide behind a lock, as the reader's do: the host is the list's contents.
  const waybackHref = link && !locked ? waybackUrl(link.url, link.createdAt) : undefined;
  const hasCopy = Boolean(extraction?.readModeId || extraction?.screenshotId);
  const actions: ReaderTopbarAction[] = [];
  if (link && !locked && hasCopy) {
    actions.push({
      label: 'Read',
      icon: BookOpen,
      testID: 'capture-reader',
      onPress: () => router.replace(`/read?link=${encodeURIComponent(linkId)}`),
    });
  }
  if (waybackHref) {
    actions.push({
      label: 'Open in Wayback Machine',
      icon: History,
      testID: 'capture-wayback',
      onPress: () => openWayback(waybackHref),
    });
  }
  const ready = currentUrl !== null && !loading && !loadFailed && busy === null;
  const reason = loadFailed ? REASON.loadFailed : '';
  const fail = (text: string) => setMessage({ text, tone: 'error' });

  const keep = async () => {
    if (!entitled) {
      paywall.show('keptCopies');
      return;
    }
    if (!link || !ready) return;
    const shown = currentUrl;
    setBusy('readMode');
    setMessage(null);
    try {
      const answer = await page.readMode();
      if (!answer || !samePage(answer.href, shown)) {
        fail(FAILURE.keep);
        return;
      }
      if (answer.capture === null) {
        fail(FAILURE.noArticle);
        return;
      }
      // The images are asked of the page first (its session reaches what the native
      // fetch can't) and fetched natively where it couldn't — only when the account
      // keeps images, which keepReadMode decides.
      const stored = await keepReadMode(link, answer.capture, {
        fetchFromPage: (sources) => page.readerImages(sources, answer.href),
      });
      if (stored) setKept(true);
      else fail(FAILURE.keep);
    } catch {
      fail(FAILURE.keep);
    } finally {
      setBusy(null);
    }
  };

  const updatePreview = async () => {
    if (!entitled || !link || !ready || previewDone !== null) return;
    const shown = currentUrl;
    setBusy('preview');
    setMessage(null);
    try {
      const answer = await page.meta();
      if (!answer || !samePage(answer.href, shown)) {
        fail(FAILURE.preview);
        return;
      }
      const outcome = await updatePreviewFromPage(link, {
        href: answer.href,
        collected: answer.collected,
        fetchFromPage: (url) => page.previewImage(url, answer.href),
      });
      const result = previewOutcome(outcome, link);
      setPreviewDone(result.label);
      setMessage(result.message);
    } catch {
      fail(FAILURE.preview);
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
          // ⚠ Not covered by any of this: on Android a navigation the rule allows whose answer is
          // a FILE goes to the library's own DownloadListener → DownloadManager → the public
          // Downloads folder, and no prop turns that off. Left open on purpose
          // (docs/link-extraction-keep.md, _the capture WebView stays on the web_).
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) =>
            isCaptureNavigationAllowed(request.url, request.isTopFrame)
          }
          onNavigationStateChange={(nav) => {
            // Another page: what was done was done to the last one (header, _what is kept_).
            if (!samePage(nav.url, currentUrl)) {
              setKept(false);
              setPreviewDone(null);
            }
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
        {/* The bar spans the window; what is in it doesn't. On a wide window two
            buttons sharing the full width were each half a landscape iPad wide (~580),
            so the column stops at `max-w-xl` and centres — the in-app sheet's cap below
            768 (docs/safe-area.md, _wide windows on native_). Upright, a phone is under it
            and looks as before; on its side it gets the same centred column. */}
        <View className="border-t border-border px-4 py-3">
          <View className="w-full max-w-xl gap-2 self-center">
            {/* The keep first, _Include images_ directly under it in its own column, and
              _Update preview_ beside — web's keep section's order (reader-page.tsx,
              EmptyCopies): the box qualifies the keep alone, so nothing but the keep
              is above it, and a screen reader meets the two in a row. `items-start`
              keeps the two buttons level while the left column is taller. */}
            <View className="flex-row items-start gap-2">
              <View className="flex-1">
                {kept ? (
                  <>
                    <Button
                      variant="outline"
                      testID="capture-read"
                      onPress={() => router.replace(`/read?link=${encodeURIComponent(linkId)}`)}
                    >
                      <Icon as={Check} className="size-4 text-foreground" />
                      <Text>Kept — read it</Text>
                    </Button>
                    <IncludeImages disabled />
                  </>
                ) : (
                  <>
                    <Button
                      testID="capture-keep-read-mode"
                      // On free the button is the upgrade, so it is never disabled there —
                      // and its name says what it is (the browser extension's saved screen
                      // does the same).
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
                    {entitled ? <IncludeImages disabled={busy === 'readMode'} /> : null}
                  </>
                )}
              </View>
              {entitled ? (
                <Button
                  variant="outline"
                  className="flex-1"
                  testID="capture-update-preview"
                  disabled={!ready || previewDone !== null}
                  onPress={() => void updatePreview()}
                >
                  <Icon as={previewDone ? Check : RefreshCw} className="size-4 text-foreground" />
                  <Text>
                    {busy === 'preview' ? 'Updating…' : (previewDone ?? 'Update preview')}
                  </Text>
                </Button>
              ) : null}
            </View>
            {/* Mounted only with something to say: an empty Text still takes a line,
              and the column's gap-2 above it, as dead space under the buttons. */}
            {message ? (
              <ErrorText tone={message.tone} className="text-center text-xs">
                {message.text}
              </ErrorText>
            ) : reason ? (
              <Text className="text-center text-xs text-muted-foreground" role="status">
                {reason}
              </Text>
            ) : null}
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
        </View>
      </>
    );
  }

  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      <ReaderTopbar
        host={host}
        locked={locked}
        fallback="Keep a copy"
        actions={actions}
        closeLabel="Close"
        testIDPrefix="capture"
        onClose={close}
      />
      {body}
    </StyledSafeAreaView>
  );
}
