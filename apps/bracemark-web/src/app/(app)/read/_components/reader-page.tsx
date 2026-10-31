'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpRight, BookOpen, Image as ImageIcon, X } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { LOCK_COPY } from '@stxapps/react';
import { hostFromText, openableUrl } from '@stxapps/shared';
import {
  readExtraction,
  readLinkById,
  useEntitlements,
  useImageFileUrl,
  useLocks,
  useReaderDoc,
} from '@stxapps/web-react';
import { ReaderArticle } from '@stxapps/web-ui/components/reader/reader-article';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@stxapps/web-ui/components/ui/tabs';
import { cn } from '@stxapps/web-ui/lib/utils';

import { LockPane } from '@/components/lock-pane';
import { usePaywall } from '@/contexts/paywall-provider';
import { readLinksReturn } from '@/lib/links-return';

// The reader screen — one link's kept copies. A tab per copy it has (Read mode,
// Screenshot), no tabs when it has one, and an empty state that says how to get one
// when it has none. docs/reader.md is the design; link-extraction-keep.md is what a
// copy is and how it got here.
//
// Three rules shape it, each from a doc that would not report breaking it:
//
//   - LOCKS. A link in a locked list is the list's contents, so the reader swaps in
//     the unlock pane before reading anything of the copy — the same swap the links
//     page makes for a locked selection (docs/locks.md, _the two enforcement
//     edges_). Without it, a `/read?link=` URL in the history would be a way round
//     the lock.
//   - READING IS NEVER GATED. `keptCopies` decides whether a copy can be TAKEN; a
//     copy that exists is shown on every plan (iap/plans.ts, the `keptCopies` note).
//     Only the empty state looks at the entitlement, to say what would fill it.
//   - THE COPY IS TEXT. Rendering is web-ui's ReaderArticle, which turns strings
//     into text nodes and nothing else (link-extraction-keep.md, the format
//     tripwire). This file never touches the document's contents.

// The ✕'s target: where the links page was, read after mount because
// sessionStorage isn't there during the static render (settings' topbar does the
// same).
function useCloseHref(): string {
  const [href, setHref] = useState('/links');
  useEffect(() => setHref(readLinksReturn()), []);
  return href;
}

// How long a copy may stay "loading" before the screen says why. Long enough that
// a normal fetch never shows it; the usual cause past it is a copy this device
// never downloaded, opened offline.
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

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className={cn('mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center')}>
      <p className={cn('text-base font-semibold text-foreground')}>{title}</p>
      {children ? (
        <div
          className={cn('flex flex-col items-center gap-4 text-sm leading-6 text-muted-foreground')}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function ReadModeTab({ fileId, title, host }: { fileId: string; title: string; host: string }) {
  const state = useReaderDoc(fileId);
  const slow = useSlow(state.status === 'loading');

  if (state.status === 'loading') {
    return slow ? (
      <Notice title="This copy hasn’t downloaded yet">
        <p>It downloads to this device the first time it’s opened online. Check your connection.</p>
      </Notice>
    ) : (
      <p role="status" className={cn('py-16 text-center text-sm text-muted-foreground')}>
        Loading…
      </p>
    );
  }
  if (state.status !== 'ready') {
    return (
      <Notice title="This copy can’t be read">
        <p>Its file is damaged or from a newer version of Bracemark.</p>
      </Notice>
    );
  }

  const { doc } = state;
  const meta = [doc.siteName ?? host, doc.byline, `Kept ${formatDay(doc.capturedAt)}`]
    .filter(Boolean)
    .join(' · ');
  return <ReaderArticle doc={doc} title={title || doc.title || host} meta={meta} />;
}

function ScreenshotTab({ fileId, title }: { fileId: string; title: string }) {
  const url = useImageFileUrl(fileId);
  const slow = useSlow(url === undefined);

  if (!url) {
    return slow ? (
      <Notice title="This screenshot hasn’t downloaded yet">
        <p>It downloads to this device the first time it’s opened online. Check your connection.</p>
      </Notice>
    ) : (
      <p role="status" className={cn('py-16 text-center text-sm text-muted-foreground')}>
        Loading…
      </p>
    );
  }
  return (
    <img
      src={url}
      alt={`Screenshot of ${title}, as it looked when it was saved`}
      className={cn('mx-auto h-auto w-full rounded-lg border border-border')}
    />
  );
}

function EmptyCopies({ href }: { href: string | undefined }) {
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();

  return (
    <Notice title="No copy of this page yet">
      <p>
        A kept copy is the page’s text in read mode, and a screenshot of how it looked — yours to
        read even if the page changes or disappears. Copies are taken from the page itself: open it,
        then save it with the Bracemark browser extension.
      </p>
      <div className={cn('flex flex-wrap justify-center gap-2')}>
        {href ? (
          <Button asChild variant="outline" size="sm">
            <a href={href} target="_blank" rel="noreferrer">
              Open the page
              <ArrowUpRight data-icon="inline-end" />
            </a>
          </Button>
        ) : null}
        {!entitlements.keptCopies ? (
          <Button size="sm" onClick={() => paywall.show('keptCopies')}>
            Keep copies with Plus
          </Button>
        ) : null}
      </div>
    </Notice>
  );
}

export function ReaderPage() {
  const linkId = useSearchParams().get('link') ?? '';
  const closeHref = useCloseHref();
  const { status: lockStatus, isListLocked, unlockList } = useLocks();

  // `null` = settled and absent; `undefined` = still reading. The split keeps the
  // not-found notice from flashing before the store answers.
  const link = useLiveQuery(
    () => (linkId ? readLinkById(linkId) : Promise.resolve(undefined)).then((l) => l ?? null),
    [linkId],
  );
  const extraction = useLiveQuery(
    () => (linkId ? readExtraction(linkId) : Promise.resolve(undefined)).then((e) => e ?? null),
    [linkId],
  );

  const settled = link !== undefined && extraction !== undefined && lockStatus === 'ready';
  const locked = settled && link !== null && isListLocked(link.listId);

  const host = link ? hostFromText(link.url) : '';
  const title = link ? (link.customTitle ?? extraction?.title ?? host) : '';
  const href = link ? openableUrl(link.url) : undefined;
  const readModeId = locked ? undefined : (extraction?.readModeId ?? undefined);
  const screenshotId = locked ? undefined : (extraction?.screenshotId ?? undefined);

  let body: React.ReactNode;
  if (!settled) {
    body = null;
  } else if (link === null) {
    body = (
      <Notice title="This link isn’t in your library">
        <p>It may have been deleted, or the address is incomplete.</p>
      </Notice>
    );
  } else if (locked) {
    body = (
      <LockPane
        className={cn('py-16')}
        title={LOCK_COPY.list.title}
        description={LOCK_COPY.list.description}
        onUnlock={(password) => unlockList(link.listId, password)}
      />
    );
  } else if (readModeId && screenshotId) {
    body = (
      <Tabs defaultValue="read">
        <TabsList className={cn('mb-6')}>
          <TabsTrigger value="read">
            <BookOpen />
            Read mode
          </TabsTrigger>
          <TabsTrigger value="screenshot">
            <ImageIcon />
            Screenshot
          </TabsTrigger>
        </TabsList>
        <TabsContent value="read">
          <ReadModeTab fileId={readModeId} title={title} host={host} />
        </TabsContent>
        <TabsContent value="screenshot">
          <ScreenshotTab fileId={screenshotId} title={title} />
        </TabsContent>
      </Tabs>
    );
  } else if (readModeId) {
    body = <ReadModeTab fileId={readModeId} title={title} host={host} />;
  } else if (screenshotId) {
    body = <ScreenshotTab fileId={screenshotId} title={title} />;
  } else {
    body = <EmptyCopies href={href} />;
  }

  return (
    <div className={cn('flex min-h-dvh flex-col bg-background safe-area')}>
      <header className={cn('sticky top-0 z-10 h-14 border-b border-border bg-background')}>
        {/* Same shape as settings' topbar: the bar's text rides the content column,
            the ✕ is a window control in the pane's own corner. */}
        <div
          className={cn(
            'mx-auto flex h-full w-full max-w-2xl items-center gap-2 pr-14 pl-4 md:pl-6',
          )}
        >
          <span className={cn('min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground')}>
            {host || 'Reader'}
          </span>
          {href && !locked ? (
            <Button asChild variant="ghost" size="sm">
              <a href={href} target="_blank" rel="noreferrer">
                Open page
                <ArrowUpRight data-icon="inline-end" />
              </a>
            </Button>
          ) : null}
        </div>
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className={cn('absolute top-3 right-3')}
          aria-label="Close reader"
        >
          <Link href={closeHref}>
            <X className={cn('size-5')} />
          </Link>
        </Button>
      </header>
      <main className={cn('mx-auto w-full max-w-2xl flex-1 px-4 py-8 md:px-6')}>{body}</main>
    </div>
  );
}
