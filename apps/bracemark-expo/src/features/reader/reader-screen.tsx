import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { router } from 'expo-router';
import { ArrowUpRight, Trash2, X } from 'lucide-react-native';
import { withUniwind } from 'uniwind';

import {
  type KeptCopyFacet,
  type LinkItem,
  readExtraction,
  readLinkById,
  useImageFileUri,
  useKeptCopyMutations,
  useLiveRead,
  useLocks,
  useReaderDoc,
} from '@stxapps/expo-react';
import { LOCK_COPY } from '@stxapps/react';
import { hostFromText } from '@stxapps/shared';

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
import { openLink } from '../links/shared';
import { ReaderArticle } from './reader-article';

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
// What it does NOT have yet that web's does: an empty-state upsell. A link reaches
// this screen only from the row menu's "Read", which appears only on a link with a
// copy, and this app can't take a copy yet (docs/link-extraction-keep.md, _expo_) —
// so an empty state here would offer something the device can't do. A copy deleted
// while the screen is open leaves the plain notice below instead.

const Image = withUniwind(ExpoImage);
const StyledSafeAreaView = withUniwind(SafeAreaView);

const SLOW_LOAD_MS = 4000;

function useSlow(active: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(timer);
  }, [active]);
  return slow;
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

function ReadModeCopy({ fileId, title, host }: { fileId: string; title: string; host: string }) {
  const state = useReaderDoc(fileId);
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
  const kept = new Date(doc.capturedAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  const meta = [doc.siteName ?? host, doc.byline, `Kept ${kept}`].filter(Boolean).join(' · ');
  return <ReaderArticle doc={doc} title={title || doc.title || host} meta={meta} />;
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
              It’s removed from all your devices. The link stays. To keep a new one, open the page
              and take it again — if the page still shows the same thing.
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

export function ReaderScreen({ linkId }: { linkId: string }) {
  const { status: lockStatus, isListLocked, unlockList } = useLocks();
  // `null` = settled and absent; `undefined` = still reading.
  const link = useLiveRead(() => readLinkById(linkId).then((l) => l ?? null), [linkId], ['items']);
  const extraction = useLiveRead(
    () => readExtraction(linkId).then((e) => e ?? null),
    [linkId],
    ['items'],
  );
  const [tab, setTab] = useState<'read' | 'screenshot'>('read');

  const settled = link !== undefined && extraction !== undefined && lockStatus === 'ready';
  const locked = settled && link !== null && isListLocked(link.listId);
  const host = link ? hostFromText(link.url) : '';
  const title = link ? (link.customTitle ?? extraction?.title ?? host) : '';
  const readModeId = locked ? undefined : (extraction?.readModeId ?? undefined);
  const screenshotId = locked ? undefined : (extraction?.screenshotId ?? undefined);

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
  } else if (readModeId && screenshotId) {
    body = (
      <Tabs value={tab} onValueChange={(v) => setTab(v === 'screenshot' ? 'screenshot' : 'read')}>
        <TabsList className="mb-6 self-start">
          <TabsTrigger value="read">
            <Text>Read mode</Text>
          </TabsTrigger>
          <TabsTrigger value="screenshot">
            <Text>Screenshot</Text>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="read">
          <ReadModeCopy fileId={readModeId} title={title} host={host} />
          <DeleteCopy link={link} facet="readMode" />
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
        <ReadModeCopy fileId={readModeId} title={title} host={host} />
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
      <View className="h-14 shrink-0 flex-row items-center gap-2 border-b border-border px-3">
        <Text
          className="min-w-0 flex-1 pl-1 text-sm font-medium text-muted-foreground"
          numberOfLines={1}
        >
          {host || 'Reader'}
        </Text>
        {link && !locked ? (
          <Button variant="ghost" size="sm" onPress={() => openLink(link.url)}>
            <Text>Open page</Text>
            <Icon as={ArrowUpRight} className="size-4 text-foreground" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 size-9"
          aria-label="Close reader"
          testID="reader-close"
          onPress={close}
        >
          <Icon as={X} className="size-5 text-foreground" />
        </Button>
      </View>
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
        {body}
      </ScrollView>
    </StyledSafeAreaView>
  );
}
