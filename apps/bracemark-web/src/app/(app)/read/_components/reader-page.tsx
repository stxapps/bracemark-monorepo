'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpRight, BookOpen, Image as ImageIcon, Trash2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

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
  useSettingMutations,
  useSettings,
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
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@stxapps/web-ui/components/ui/tabs';
import { cn } from '@stxapps/web-ui/lib/utils';

import { ReaderTopbar } from './reader-topbar';

import { LockPane } from '@/components/lock-pane';
import { usePaywall } from '@/contexts/paywall-provider';
import { recordReturnRow } from '@/lib/links-return';

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
// bracemark-extractor (useServerReadMode — offered only with the `serverReadMode`
// opt-in on, on a plan with `keptCopies`). Only ever on that button's press: the row
// menu's "Read" opens this page on a paid plan's link with no copy too, and a press
// that says "Read" is not an ask to have the server fetch the page.
//
// With the opt-in off, it is also where the opt-in is OFFERED — in place, not as a
// link to Settings the way the links page's previews banner does it. That banner's
// two reasons don't carry here: it has no room for the disclosure, and turning
// previews on barely moves the count it shows. This empty state has the room, so the
// sentence naming what is sent sits beside the button, and turning it on delivers
// exactly what was asked. It stays TWO presses — turn on, then keep — because the
// first is a standing choice and the second fetches this one page; one button doing
// both would blur what the switch is. Focus is handed from the first to the second,
// since the first unmounts. Once on, _Include images_ sits under the action it
// qualifies (the synced `keepReadModeImages`, the same field as Settings → Read mode).
//
// TWO WAYS OUT, both in the top bar and both hidden behind a lock (the host is the
// locked list's contents): _Open page_, the live page, and _Wayback Machine_, the
// Internet Archive's capture nearest the day the link was saved — for the page that
// has changed or gone, which is the moment a reader is opened at all. The second is
// an address built on this device (`waybackUrl`, @stxapps/shared url.ts); nothing
// is asked of the archive until the click, and nothing may be: a lookup would tell
// a third party which pages are in the library.

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
              It’s removed from all your devices. The link stays. A new copy is taken from the page
              as it is then, which may not match this one.
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
  text: 'Could not keep a read-mode copy. Please try again.',
  failure: true,
};

function outcomeNotice(outcome: ServerReadModeOutcome | 'error'): OutcomeNotice | null {
  if (outcome === 'error') return KEEP_FAILED;
  if (outcome.kind !== 'none') return null;
  switch (outcome.reason) {
    case READ_MODE_REASONS.notAnArticle:
      return {
        text: 'There’s no article on this page to keep in read mode.',
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

function KeepReadMode({ link, focusOnMount }: { link: LinkItem; focusOnMount: boolean }) {
  const { keep } = useServerReadMode();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OutcomeNotice | null>(null);

  // Mounted in place of _Turn on server read mode_, which a keyboard user just pressed
  // and which is gone now — so focus is moved here rather than dropped on <body>. Only
  // on that mount: arriving at the page must not take focus.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const focusOnMountRef = useRef(focusOnMount);
  useEffect(() => {
    if (focusOnMountRef.current) buttonRef.current?.focus();
  }, []);

  const run = () => {
    setBusy(true);
    setNotice(null);
    keep(link)
      .then((outcome) => setNotice(outcomeNotice(outcome)))
      .catch(() => setNotice(outcomeNotice('error')))
      .finally(() => setBusy(false));
  };

  // `contents`: the three are items of EmptyCopies' grid, which places them — the
  // button, _Include images_ directly under it, and the server's answer under both.
  // The checkbox qualifies THIS button, so nothing sits between the two at any width.
  return (
    <div className={cn('contents')}>
      <Button
        ref={buttonRef}
        size="sm"
        disabled={busy}
        onClick={run}
        className={cn('sm:col-start-1 sm:row-start-1')}
      >
        <BookOpen data-icon="inline-start" />
        {busy ? 'Keeping…' : 'Keep a read-mode copy'}
      </Button>
      <IncludeImages className={cn('sm:col-start-1 sm:row-start-2')} />
      {notice ? (
        <p
          role={notice.failure ? 'alert' : 'status'}
          className={cn('text-pretty sm:col-span-full sm:row-start-3')}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

// Turns the `serverReadMode` opt-in on from the empty state. The disclosure it rests on
// is the paragraph above it, in the same words as Settings → Read mode's switch.
function TurnOnServerReadMode({ onTurnedOn }: { onTurnedOn: () => void }) {
  const { setServerReadMode } = useSettingMutations();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = () => {
    setBusy(true);
    setFailed(false);
    setServerReadMode(true)
      .then(onTurnedOn, () => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Button size="sm" disabled={busy} onClick={run}>
        <BookOpen data-icon="inline-start" />
        {busy ? 'Turning on…' : 'Turn on server read mode'}
      </Button>
      {failed ? (
        <p role="alert" className={cn('text-pretty sm:col-span-full')}>
          Could not turn on server read mode. Please try again.
        </p>
      ) : null}
    </>
  );
}

// _Include images_ beside the action it qualifies. A failed write needs no message of
// its own: the box is bound to the stored value, so it simply doesn't change, and
// Settings → Read mode is the durable surface.
function IncludeImages({ className }: { className?: string }) {
  const { keepOnSave } = useSettings();
  const { setKeepOnSave } = useSettingMutations();
  return (
    <Label htmlFor="reader-include-images" className={cn('gap-2 text-muted-foreground', className)}>
      <Checkbox
        id="reader-include-images"
        checked={keepOnSave.readModeImages}
        onCheckedChange={(v) =>
          void setKeepOnSave({ readModeImages: v === true }).catch(() => undefined)
        }
      />
      Include images
    </Label>
  );
}

function EmptyCopies({
  link,
  title,
  href,
  waybackHref,
}: {
  link: LinkItem;
  title: string;
  href: string | undefined;
  waybackHref: string | undefined;
}) {
  const { entitlements } = useEntitlements();
  const { available, needsOptIn } = useServerReadMode();
  const paywall = usePaywall();
  const [justTurnedOn, setJustTurnedOn] = useState(false);

  // Left-aligned, in the article's own column: this is prose of several sentences,
  // and centred lines of that length have no edge to return to. The page's title
  // leads, as it does over a copy, so the screen says whose copy is missing.
  return (
    <div className={cn('flex flex-col gap-8')}>
      <h1
        className={cn(
          'text-2xl leading-tight font-semibold wrap-break-word text-foreground md:text-3xl',
        )}
      >
        {title}
      </h1>
      <section
        aria-labelledby="reader-keep-title"
        className={cn('flex flex-col items-start gap-4 text-sm leading-6 text-muted-foreground')}
      >
        <h2 id="reader-keep-title" className={cn('text-base font-semibold text-foreground')}>
          Keep a copy of this page
        </h2>
        <p className={cn('text-pretty')}>
          A copy is the page’s text in read mode — yours to read even if the page changes or
          disappears.
        </p>
        <p className={cn('text-pretty')}>
          {available
            ? 'Keep one from here: our link-extraction service fetches the page and sends its article back to this browser. Or open the page and save it with the Bracemark browser extension.'
            : needsOptIn
              ? 'Open the page and save it with the Bracemark browser extension. Or keep one from here, once you turn on server read mode.'
              : 'Open the page and save it with the Bracemark browser extension.'}
        </p>
        {/* The disclosure, before the switch it is the consent for — the Settings
            switch's words (read-mode-section.tsx says why each clause is there): the
            address, not the account, the IP held briefly. Boxed so it reads as the
            terms of the button beside it, not a third paragraph of the pitch. */}
        {needsOptIn ? (
          <p className={cn('rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-pretty')}>
            The web app can’t open other sites, so with server read mode on, our link-extraction
            service fetches the page for you — only when you ask for a read-mode copy, one link at a
            time. It receives the link’s address, not your account, and briefly holds your IP
            address so no single source can abuse it.
          </p>
        ) : null}
        {/* One grid, so the two widths are the same markup. Narrow, a column: the ask
            from here, _Include images_ directly under it, then the ways that leave this
            screen. Wide, the page's button goes to the right of the ask and the
            checkbox stays under it, in the ask's own column. The checkbox qualifies
            the ask alone, so it is never between the ask and anything else, and
            nothing but the ask sits above it. */}
        <div
          className={cn(
            'grid grid-cols-1 items-center justify-items-start gap-x-2 gap-y-3 sm:grid-cols-[repeat(3,max-content)]',
          )}
        >
          {available ? <KeepReadMode link={link} focusOnMount={justTurnedOn} /> : null}
          {needsOptIn ? <TurnOnServerReadMode onTurnedOn={() => setJustTurnedOn(true)} /> : null}
          {href ? (
            <Button
              asChild
              variant="outline"
              size="sm"
              className={cn(available && 'sm:col-start-2 sm:row-start-1')}
            >
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
      </section>
      {/* Only where the exit exists, and apart from the above: it is a different
          errand (the page is already gone), with no copy of our own the one place the
          page as it was might still be. Said in a sentence rather than left to a
          button's two words. "May": we have not asked, and must not. */}
      {waybackHref ? (
        <section
          className={cn(
            'flex flex-col items-start gap-3 border-t border-border pt-6 text-sm leading-6 text-muted-foreground',
          )}
        >
          <p className={cn('text-pretty')}>
            If the page has changed or gone, the Internet Archive’s Wayback Machine may have it.
          </p>
          <Button asChild variant="outline" size="sm">
            <a href={waybackHref} target="_blank" rel="noreferrer">
              Wayback Machine
              <ArrowUpRight data-icon="inline-end" />
            </a>
          </Button>
        </section>
      ) : null}
    </div>
  );
}

export function ReaderPage() {
  const searchParams = useSearchParams();
  const linkId = searchParams.get('link') ?? '';
  const { status: lockStatus, isListLocked, unlockList } = useLocks();

  // The row the links page restores when the ✕ — or Back — returns to it
  // (lib/links-return.ts). Recorded on opening rather than on the ✕, so the browser's
  // Back, which never touches the ✕, restores it too. A record is only ever read by
  // the links page that follows, and only in the view it names.
  useEffect(() => {
    if (linkId) recordReturnRow(linkId);
  }, [linkId]);

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
    body = <EmptyCopies link={link} title={title} href={href} waybackHref={waybackHref} />;
  }

  // A viewport-sized frame with its own scroller, like /settings (settings/layout.tsx
  // has the long form), and for the reason that matters most here: the delete
  // confirmation and the Plus dialog are modal, and a modal puts `overflow: hidden`
  // on <body>. When the DOCUMENT is what scrolls, that takes the scrollbar away and
  // `html`'s `scrollbar-gutter: stable` goes with it (measured: 985 -> 1000 wide), so
  // the whole page jumps ~8px sideways under the dialog. A document that never
  // scrolls has nothing to lose: `data-no-scrollbar-gutter` opts out of the blanket
  // gutter (dead space on a frame), and the scroller carries its own stable one.
  // The bar is sticky INSIDE the scroller, as Settings' is, so its right edge and the
  // article's column are measured against the same box; that is also what owes the
  // scroller a `scroll-pt` — the bar's 14 plus a step of air, as there.
  return (
    <div data-no-scrollbar-gutter="" className={cn('flex h-dvh flex-col bg-background safe-area')}>
      <div className={cn('min-h-0 flex-1 scroll-pt-18 scrollbar-gutter-stable overflow-y-auto')}>
        <ReaderTopbar host={host} href={href} waybackHref={waybackHref} locked={locked} />
        <main className={cn('mx-auto w-full max-w-2xl px-4 py-8 md:px-6')}>{body}</main>
      </div>
    </div>
  );
}
