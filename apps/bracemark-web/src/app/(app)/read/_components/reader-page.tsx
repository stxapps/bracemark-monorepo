'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpRight, BookOpen, History, Image as ImageIcon, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { LOCK_COPY } from '@stxapps/react';
import {
  hostFromText,
  openableUrl,
  READ_MODE_REASONS,
  readerPublishedAt,
  waybackUrl,
} from '@stxapps/shared';
import {
  type KeptCopyFacet,
  type LinkItem,
  readExtraction,
  readLinkById,
  type ServerReadModeOutcome,
  useEntitlements,
  useImageFileUrl,
  useKeptCopyMutations,
  useLocks,
  useReaderDoc,
  useReaderImages,
  useServerReadMode,
} from '@stxapps/web-react';
import { ReaderArticle } from '@stxapps/web-ui/components/reader/reader-article';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@stxapps/web-ui/components/ui/alert-dialog';
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
//
// The empty state is also where the web app TAKES a read-mode copy, through
// bracemark-extractor (useServerReadMode — offered only with the server-extraction
// opt-in on, on a plan with `keptCopies`). The row menu's _Keep read mode_ opens this
// page with `&keep=readMode`, which runs that once and is then dropped from the
// address, so a reload or a history entry can't fetch the page again on its own.
//
// TWO WAYS OUT, both in the top bar and both hidden behind a lock (the host is the
// locked list's contents): _Open page_, the live page, and _Wayback Machine_, the
// Internet Archive's capture nearest the day the link was saved — for the page that
// has changed or gone, which is the moment a reader is opened at all. The second is
// an address built on this device (`waybackUrl`, @stxapps/shared url.ts); nothing
// is asked of the archive until the click, and nothing may be: a lookup would tell
// a third party which pages are in the library.

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

function ReadModeTab({
  fileId,
  imagesFileId,
  title,
  host,
}: {
  fileId: string;
  // The copy's image pack, when it kept any (`extraction.readModeImagesId`). Asked for
  // beside the text, not after it: the figures hold their space either way, and the
  // pack is the slower of the two.
  imagesFileId: string | undefined;
  title: string;
  host: string;
}) {
  const state = useReaderDoc(fileId);
  const { images, settled: imagesSettled } = useReaderImages(imagesFileId);
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
  // Site, author, when the page says it was published, when this copy was taken.
  // The last is the one a kept copy exists for: it is the page AS IT WAS that day.
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

// "Delete this copy" — under each copy, behind a confirmation, because it can't be
// undone: the copy was taken from the page as it was, and keeping a new one means
// opening the page again (which may have changed, or be gone). Removal clears the
// copy on every device and marks it removed, so nothing automatic takes it again
// (removeKeptCopy). Never gated on the plan, like reading.
const COPY_NAMES: Record<KeptCopyFacet, string> = {
  readMode: 'read-mode copy',
  screenshot: 'screenshot',
};

function DeleteCopy({ link, facet }: { link: LinkItem; facet: KeptCopyFacet }) {
  const { removeCopy } = useKeptCopyMutations();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = COPY_NAMES[facet];

  const remove = () => {
    setError(null);
    void removeCopy(link, facet).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <div className={cn('mt-10 flex flex-col items-start gap-2 border-t border-border pt-6')}>
      <Button
        variant="ghost"
        size="sm"
        className={cn('text-destructive')}
        onClick={() => setOpen(true)}
      >
        <Trash2 data-icon="inline-start" />
        Delete this {name}
      </Button>
      {error ? (
        <p role="alert" className={cn('text-sm text-destructive')}>
          {error}
        </p>
      ) : null}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle>Delete this {name}?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              It’s removed from all your devices. The link stays. To keep a new one, open the page
              and take it again with the browser extension — if the page still shows the same thing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// What the server's answer means to the person who asked — the reasons are
// READ_MODE_REASONS (@stxapps/shared extract/endpoints.ts). A copy that landed needs no
// words: the page swaps the empty state for it. A FAILURE (nothing learned about the
// page) takes the fixed error shape and announces as an alert; a settled answer about
// the page is information, read politely (docs/brand-assets.md, _errors have a fixed
// shape_; docs/accessibility.md).
type OutcomeNotice = { text: string; failure: boolean };

const KEEP_FAILED: OutcomeNotice = {
  text: 'Could not keep read mode. Please try again.',
  failure: true,
};

function outcomeNotice(outcome: ServerReadModeOutcome | 'error'): OutcomeNotice | null {
  if (outcome === 'error') return KEEP_FAILED;
  if (outcome.kind !== 'none') return null;
  switch (outcome.reason) {
    case READ_MODE_REASONS.notAnArticle:
      return {
        text: 'There’s no article on this page to keep in read mode. To keep how it looks, take a screenshot with the browser extension.',
        failure: false,
      };
    case READ_MODE_REASONS.notHtml:
      return { text: 'This address isn’t a web page, so there’s no text to keep.', failure: false };
    case READ_MODE_REASONS.robotsDisallowed:
      return {
        text: 'This site asks services like ours not to copy its pages, so we don’t take one. You can still keep a copy from the page itself, with the browser extension.',
        failure: false,
      };
    default:
      return KEEP_FAILED;
  }
}

function KeepReadMode({ link, auto }: { link: LinkItem; auto: boolean }) {
  const { keep } = useServerReadMode();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OutcomeNotice | null>(null);

  const run = () => {
    setBusy(true);
    setNotice(null);
    keep(link)
      .then((outcome) => setNotice(outcomeNotice(outcome)))
      .catch(() => setNotice(outcomeNotice('error')))
      .finally(() => setBusy(false));
  };

  // The row menu's _Keep read mode_ arrives with `auto` — that click was the ask. Once
  // per mount; the parent has already dropped the parameter from the address.
  const started = useRef(false);
  useEffect(() => {
    if (!auto || started.current) return;
    started.current = true;
    run();
    // `run` is recreated per render; the ref is what makes this a once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  return (
    <>
      <Button size="sm" disabled={busy} onClick={run}>
        <BookOpen data-icon="inline-start" />
        {busy ? 'Keeping read mode…' : 'Keep read mode'}
      </Button>
      {notice ? (
        <p role={notice.failure ? 'alert' : 'status'} className={cn('text-pretty')}>
          {notice.text}
        </p>
      ) : null}
    </>
  );
}

function EmptyCopies({
  link,
  href,
  waybackHref,
  autoKeep,
}: {
  link: LinkItem;
  href: string | undefined;
  waybackHref: string | undefined;
  autoKeep: boolean;
}) {
  const { entitlements } = useEntitlements();
  const { available: serverAvailable } = useServerReadMode();
  const paywall = usePaywall();

  return (
    <Notice title="No copy of this page yet">
      <p>
        A kept copy is the page’s text in read mode, and a screenshot of what was on screen when you
        saved it — yours to read even if the page changes or disappears.{' '}
        {serverAvailable
          ? 'Keep its read mode now — the preview service you turned on in Settings fetches it for you. To keep a screenshot too, open the page and save it with the Bracemark browser extension.'
          : 'Copies are taken from the page itself: open it, then save it with the Bracemark browser extension.'}
      </p>
      {/* Only where the exit exists. With no copy of our own this is the one place
          the page as it was might still be, so it is said in a sentence rather than
          left to a button's two words. "May": we have not asked, and must not. */}
      {waybackHref ? (
        <p>
          If the page has changed or gone, the Internet Archive’s Wayback Machine may have it as it
          was around the day you saved it.
        </p>
      ) : null}
      <div className={cn('flex flex-wrap justify-center gap-2')}>
        {serverAvailable ? <KeepReadMode link={link} auto={autoKeep} /> : null}
        {href ? (
          <Button asChild variant="outline" size="sm">
            <a href={href} target="_blank" rel="noreferrer">
              Open the page
              <ArrowUpRight data-icon="inline-end" />
            </a>
          </Button>
        ) : null}
        {waybackHref ? (
          <Button asChild variant="outline" size="sm">
            <a href={waybackHref} target="_blank" rel="noreferrer">
              Wayback Machine
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
  const searchParams = useSearchParams();
  const linkId = searchParams.get('link') ?? '';
  // `&keep=readMode` — the row menu's _Keep read mode_. Read once into state and then
  // dropped from the address (a replace, not a push), so the ask runs for the click
  // that made it and never for a reload, a restored tab or a history entry.
  const router = useRouter();
  const pathname = usePathname();
  const [autoKeep] = useState(() => searchParams.get('keep') === 'readMode');
  useEffect(() => {
    if (searchParams.get('keep') === null) return;
    router.replace(`${pathname}?link=${encodeURIComponent(linkId)}`);
  }, [searchParams, router, pathname, linkId]);
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
  const waybackHref = link ? waybackUrl(link.url, link.createdAt) : undefined;
  const readModeId = locked ? undefined : (extraction?.readModeId ?? undefined);
  const readModeImagesId = locked ? undefined : (extraction?.readModeImagesId ?? undefined);
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
          <ReadModeTab
            fileId={readModeId}
            imagesFileId={readModeImagesId}
            title={title}
            host={host}
          />
          <DeleteCopy link={link} facet="readMode" />
        </TabsContent>
        <TabsContent value="screenshot">
          <ScreenshotTab fileId={screenshotId} title={title} />
          <DeleteCopy link={link} facet="screenshot" />
        </TabsContent>
      </Tabs>
    );
  } else if (readModeId) {
    body = (
      <>
        <ReadModeTab
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
        <ScreenshotTab fileId={screenshotId} title={title} />
        <DeleteCopy link={link} facet="screenshot" />
      </>
    );
  } else {
    body = <EmptyCopies link={link} href={href} waybackHref={waybackHref} autoKeep={autoKeep} />;
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
          {/* Icon-only below `sm`: with the host, _Open page_ and the ✕ there is no
              room for a second label on a phone, and the label is one tap away in
              the row menu and in the empty state. The accessible name is the full
              phrase at every width. */}
          {waybackHref && !locked ? (
            <Button asChild variant="ghost" size="sm">
              <a
                href={waybackHref}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in Wayback Machine"
                title="Open in Wayback Machine"
              >
                <History data-icon="inline-start" />
                <span className={cn('hidden sm:inline')}>Wayback Machine</span>
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
