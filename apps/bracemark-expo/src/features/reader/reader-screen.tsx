import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { router } from 'expo-router';
import { ArrowUpRight, BookOpen, History, RefreshCw, Trash2 } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import {
  type KeptCopyFacet,
  type LinkItem,
  readExtraction,
  readLinkById,
  useEntitlements,
  useImageFileUri,
  useKeptCopyMutations,
  useLiveRead,
  useLocks,
  useReaderDoc,
  useReaderImages,
} from '@stxapps/expo-react';
import { LOCK_COPY, useSlow } from '@stxapps/react';
import { hostFromText, readerPublishedAt, waybackUrl } from '@stxapps/shared';

import { LockPane } from '../../components/lock-pane';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Text } from '../../components/ui/text';
import { openLink, openWayback } from '../../lib/open-url';
import { ReaderArticle } from './reader-article';
import { ReaderTopbar, type ReaderTopbarAction } from './topbar';

// The reader — one link's kept copies, on expo. The twin of bracemark-web's
// `(app)/read/_components/reader-page.tsx` (its header has the reasoning), with the
// same three rules, each one silent if dropped:
//
//   - LOCKS FIRST. A link in a locked list is that list's contents, so the unlock
//     pane comes before anything of the copy — and before "Open page", since the
//     host is contents too (docs/locks.md, _the two enforcement edges_).
//   - READING AND DELETING ARE NEVER GATED on the plan (iap/plans.ts, `keptCopies`).
//   - THE COPY IS TEXT — ReaderArticle turns strings into `<Text>`, nothing else.
//
// The top bar is ReaderTopbar (topbar.tsx), shared with the capture screen:
// the host, then a ⋯ menu, a divider and the ✕. In the menu, two ways out, as on
// web and for web's reasons: _Open page_, and the Wayback Machine — the Internet
// Archive's capture nearest the day the link was saved, an address built on this
// device and opened only by the press. The Wayback Machine is in no row menu — here
// and on the capture screen only, the two places a user goes when the page let them
// down (docs/link-extraction-keep.md, _when the page is gone_).
//
// And one way across, in the same menu: _Update from the page_, to the capture screen
// (`/capture?link=<id>`), where a fresh copy is kept and the preview re-read — for a
// page that has changed since the copy. Only on a plan with `keptCopies`, since both
// of that screen's actions are; a free account reading a copy it kept earlier has
// nothing there. A REPLACE, not a push, as the capture screen's own way back is: the
// two screens trade places, so going back and forth never stacks them.
//
// TABS follow web's rule — a tab per copy the link has, plus one for a copy this
// screen can send you to take. The phone takes read mode on the capture screen and
// never a screenshot, so a link with only a screenshot, on a plan with `keptCopies`,
// gets both tabs: the Read mode tab holds a notice and _Keep a read-mode copy_, which
// goes to the capture screen (a replace, as _Update from the page_ does). It opens on
// the Screenshot tab, the copy that exists. On a free plan that tab would lead only to
// a screen whose actions are Plus, so there the bare screenshot shows, as it does for
// a read-mode copy alone.
//
// What it does NOT have that web's does: an empty-state upsell. A link reaches this
// screen from the row menu's "Read" only when it has a copy — without one, "Read"
// goes to the capture screen (features/links/link-row-menu.tsx). A copy deleted while
// the screen is open leaves the plain notice below instead.

const Image = withUniwind(ExpoImage);
const StyledSafeAreaView = withUniwind(SafeAreaView);

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function close(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/links');
}

function Notice({ title, body }: { title: string; body?: string }) {
  return (
    <View className="items-center gap-2 px-6 py-16">
      <Text className="text-center text-base font-semibold">{title}</Text>
      {body ? <Text className="text-center text-sm text-muted-foreground">{body}</Text> : null}
    </View>
  );
}

function Loading({ what, slow }: { what: string; slow: boolean }) {
  return slow ? (
    <Notice
      title={`This ${what} hasn’t downloaded yet`}
      body="It downloads to this device the first time it’s opened online. Check your connection."
    />
  ) : (
    <Text role="status" className="py-16 text-center text-sm text-muted-foreground">
      Loading…
    </Text>
  );
}

function ReadModeCopy({
  fileId,
  imagesFileId,
  title,
  host,
}: {
  fileId: string;
  // The copy's image pack, when it kept any (`extraction.readModeImagesId`).
  imagesFileId: string | undefined;
  title: string;
  host: string;
}) {
  const state = useReaderDoc(fileId);
  const { images, settled: imagesSettled } = useReaderImages(imagesFileId);
  const slow = useSlow(state.status === 'loading');
  if (state.status === 'loading') return <Loading what="copy" slow={slow} />;
  if (state.status !== 'ready') {
    return (
      <Notice
        title="This copy can’t be read"
        body="Its file is damaged or from a newer version of Bracemark."
      />
    );
  }
  const { doc } = state;
  // Site, author, when the page says it was published, when this copy was taken —
  // web's line (reader-page.tsx).
  const published = readerPublishedAt(doc);
  const meta = [
    doc.siteName ?? host,
    doc.byline,
    published !== undefined ? `Published ${formatDay(published)}` : undefined,
    `Kept ${formatDay(doc.capturedAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <ReaderArticle
      doc={doc}
      title={title || doc.title || host}
      meta={meta}
      images={images}
      imagesSettled={imagesSettled}
    />
  );
}

function ScreenshotCopy({ fileId, title }: { fileId: string; title: string }) {
  const uri = useImageFileUri(fileId);
  const slow = useSlow(!uri);
  if (!uri) return <Loading what="screenshot" slow={slow} />;
  return (
    <Image
      source={{ uri }}
      contentFit="contain"
      // The capture is a viewport, wider than tall on a desktop; `aspect-[16/10]`
      // gives the box a height before the image's own size is known.
      className="aspect-[16/10] w-full rounded-lg border border-border"
      accessibilityLabel={`Screenshot of ${title}, as it looked when it was saved`}
    />
  );
}

const COPY_NAMES: Record<KeptCopyFacet, string> = {
  readMode: 'read-mode copy',
  screenshot: 'screenshot',
};

// Behind a confirmation, as on web: a copy can't be re-taken from a page that has
// changed. The confirm is a plain Button, not AlertDialogAction — the rn-primitives
// Action closes the root before its handler runs (link-destroy-confirm.tsx).
function DeleteCopy({ link, facet }: { link: LinkItem; facet: KeptCopyFacet }) {
  const { removeCopy } = useKeptCopyMutations();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = COPY_NAMES[facet];

  const remove = async () => {
    setBusy(true);
    try {
      await removeCopy(link, facet);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="mt-10 items-start border-t border-border pt-6">
      <Button
        variant="ghost"
        size="sm"
        onPress={() => setOpen(true)}
        testID={`reader-delete-${facet}`}
      >
        <Icon as={Trash2} className="size-4 text-destructive" />
        <Text className="text-destructive">Delete this {name}</Text>
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It’s removed from all your devices. The link stays. A new copy is taken from the page
              as it is then, which may not match this one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              <Text>Keep it</Text>
            </AlertDialogCancel>
            <Button variant="destructive" disabled={busy} onPress={() => void remove()}>
              <Text>{busy ? 'Deleting…' : 'Delete'}</Text>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </View>
  );
}

// The Read mode tab of a link that has only a screenshot: nothing to read, and the way
// to get a copy — the capture screen, the one place the phone takes read mode. A
// replace, so the reader and the capture screen trade places and never stack
// (docs/reader.md, _the way in_). Shown only on a plan with `keptCopies`, which that
// screen's actions need.
function KeepReadMode({ linkId }: { linkId: string }) {
  return (
    <View className="items-center gap-4 px-6 py-16">
      {/* The two texts are a group with a tighter gap than the one to the button: each
          line box has half-leading above and below its glyphs, so text-to-text reads
          as gap + both halves, while text-to-button stops at the button's edge
          (web's EmptyCopies, reader-page.tsx, has the numbers). */}
      <View className="items-center gap-2">
        <Text className="text-center text-base font-semibold">No read-mode copy yet</Text>
        <Text className="text-center text-sm text-muted-foreground">
          Open the page to keep its article as a read-mode copy — yours to read even if the page
          changes or disappears.
        </Text>
      </View>
      <Button
        size="sm"
        testID="reader-keep-read-mode"
        onPress={() => router.replace(`/capture?link=${encodeURIComponent(linkId)}`)}
      >
        <Icon as={BookOpen} className="size-4 text-primary-foreground" />
        <Text>Keep a read-mode copy</Text>
      </Button>
    </View>
  );
}

export function ReaderScreen({ linkId }: { linkId: string }) {
  const { status: lockStatus, isListLocked, unlockList } = useLocks();
  const { entitlements } = useEntitlements();
  // `null` = settled and absent; `undefined` = still reading.
  const link = useLiveRead(() => readLinkById(linkId).then((l) => l ?? null), [linkId], ['items']);
  const extraction = useLiveRead(
    () => readExtraction(linkId).then((e) => e ?? null),
    [linkId],
    ['items'],
  );
  // Set once the user picks a tab; until then derived, so a screenshot-only link opens
  // on the screenshot and not on the empty Read mode tab.
  const [pickedTab, setPickedTab] = useState<'read' | 'screenshot' | undefined>(undefined);

  const settled = link !== undefined && extraction !== undefined && lockStatus === 'ready';
  const locked = settled && link !== null && isListLocked(link.listId);
  const host = link ? hostFromText(link.url) : '';
  const title = link ? (link.customTitle ?? extraction?.title ?? host) : '';
  const waybackHref = link && !locked ? waybackUrl(link.url, link.createdAt) : undefined;
  const readModeId = locked ? undefined : (extraction?.readModeId ?? undefined);
  const readModeImagesId = locked ? undefined : (extraction?.readModeImagesId ?? undefined);
  const screenshotId = locked ? undefined : (extraction?.screenshotId ?? undefined);

  // The ⋯ menu's rows. ReaderTopbar drops them all behind a lock as well.
  const actions: ReaderTopbarAction[] = [];
  if (link && !locked) {
    actions.push({
      label: 'Open page',
      icon: ArrowUpRight,
      testID: 'reader-open-page',
      onPress: () => openLink(link.url),
    });
    if (entitlements.keptCopies) {
      actions.push({
        label: 'Update from the page',
        icon: RefreshCw,
        testID: 'reader-capture',
        onPress: () => router.replace(`/capture?link=${encodeURIComponent(linkId)}`),
      });
    }
  }
  if (waybackHref) {
    actions.push({
      label: 'Open in Wayback Machine',
      icon: History,
      testID: 'reader-wayback',
      onPress: () => openWayback(waybackHref),
    });
  }

  let body: React.ReactNode = null;
  if (!settled) {
    body = null;
  } else if (link === null) {
    body = (
      <Notice
        title="This link isn’t in your library"
        body="It may have been deleted, or the address is incomplete."
      />
    );
  } else if (locked) {
    body = (
      <LockPane
        testID="reader-lock-pane"
        title={LOCK_COPY.list.title}
        description={LOCK_COPY.list.description}
        onUnlock={(password) => unlockList(link.listId, password)}
      />
    );
  } else if (screenshotId && (readModeId || entitlements.keptCopies)) {
    body = (
      <Tabs
        value={pickedTab ?? (readModeId ? 'read' : 'screenshot')}
        onValueChange={(v) => setPickedTab(v === 'screenshot' ? 'screenshot' : 'read')}
      >
        {/* Full width on a phone, the two triggers splitting it into big targets; the
            fitted pill, at the article's left edge, from `sm` up (web's rule). */}
        <TabsList className="mb-6 w-full sm:w-auto sm:self-start">
          <TabsTrigger value="read" className="flex-1 sm:flex-none">
            <Text>Read mode</Text>
          </TabsTrigger>
          <TabsTrigger value="screenshot" className="flex-1 sm:flex-none">
            <Text>Screenshot</Text>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="read">
          {readModeId ? (
            <>
              <ReadModeCopy
                fileId={readModeId}
                imagesFileId={readModeImagesId}
                title={title}
                host={host}
              />
              <DeleteCopy link={link} facet="readMode" />
            </>
          ) : (
            <KeepReadMode linkId={linkId} />
          )}
        </TabsContent>
        <TabsContent value="screenshot">
          <ScreenshotCopy fileId={screenshotId} title={title} />
          <DeleteCopy link={link} facet="screenshot" />
        </TabsContent>
      </Tabs>
    );
  } else if (readModeId) {
    body = (
      <>
        <ReadModeCopy
          fileId={readModeId}
          imagesFileId={readModeImagesId}
          title={title}
          host={host}
        />
        <DeleteCopy link={link} facet="readMode" />
      </>
    );
  } else if (screenshotId) {
    body = (
      <>
        <ScreenshotCopy fileId={screenshotId} title={title} />
        <DeleteCopy link={link} facet="screenshot" />
      </>
    );
  } else {
    body = <Notice title="No copy of this page" body="Copies are taken from the page itself." />;
  }

  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      <ReaderTopbar
        host={host}
        locked={locked}
        fallback="Reader"
        actions={actions}
        closeLabel="Close reader"
        testIDPrefix="reader"
        onClose={close}
      />
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
        {body}
      </ScrollView>
    </StyledSafeAreaView>
  );
}
