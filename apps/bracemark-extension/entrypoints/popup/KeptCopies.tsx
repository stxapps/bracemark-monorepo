import { useState } from 'react';
import { ArrowUpRight, BookOpen, Check, Image as ImageIcon, Loader2 } from 'lucide-react';

import { PLAN_LABELS } from '@stxapps/shared';
import { type ExtractionFacet, type ExtractionItem, useEntitlements } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { sendMessage } from '@/utils/messages';
import { openWebApp } from '@/utils/open-web-app';

// The saved screen's "keep a copy" row: the page's text in read mode, and a
// screenshot of what is on screen. Both are captured from THIS tab, which is why
// they live in the popup at all — the moment the user is standing on the page is
// the only moment the browser extension can take either (docs/link-extraction-keep.md,
// _when a copy is taken_).
//
// Read mode is usually already on its way: Editor asks for it on save when the plan
// has `keptCopies`, so after a fresh save this row opens on "Keeping…" and settles
// by itself. The screenshot is never automatic — ten times the bytes, and only some
// pages want one — so it is one tap here. On the revisit path (an already-saved tab)
// both are taps.
//
// What each button says comes from the link's extraction, read live by Complete, so
// it reflects what was actually stored — including by another popup or device —
// rather than what this one believes it asked for. The one piece of local state is
// WHEN this popup asked, so "Keeping…" holds until a facet newer than the request
// lands (`extractedAt` is stamped by the background after the capture).
//
// Free accounts see the same two buttons, each marked Plus, and a tap opens the web
// app's Subscription section: the popup has no paywall of its own, the same hand-off
// the link-cap banner makes (Editor). Reading a kept copy is never gated — "Read" on
// a kept copy works on every plan.

type CopyState = 'idle' | 'keeping' | 'kept' | 'failed' | 'noArticle';

function stateOf(
  facet: ExtractionItem['facets'][ExtractionFacet],
  fileId: string | undefined,
  requestedAt: number | undefined,
  refused: boolean,
): CopyState {
  // The background refused before capturing — most often the tab is no longer this
  // link's page (the stale-tab guard writes no facet, so the live read alone would
  // leave this on "Keeping…" for good).
  if (refused) return 'failed';
  // Asked for in this popup, and nothing newer than the ask has landed yet.
  if (requestedAt !== undefined && (facet?.extractedAt ?? 0) < requestedAt) return 'keeping';
  if (fileId && facet?.status === 'done') return 'kept';
  if (facet?.status === 'permanent' && facet.reason === 'not-an-article') return 'noArticle';
  if (facet?.status === 'failed' && requestedAt !== undefined) return 'failed';
  return 'idle';
}

function CopyButton({
  icon,
  label,
  state,
  entitled,
  onKeep,
  onRead,
}: {
  icon: React.ReactNode;
  label: string;
  state: CopyState;
  entitled: boolean;
  onKeep: () => void;
  onRead: () => void;
}) {
  if (state === 'kept') {
    return (
      <Button variant="outline" size="sm" onClick={onRead} aria-label={`${label} kept — read it`}>
        <Check data-icon="inline-start" />
        {label}
        <ArrowUpRight data-icon="inline-end" />
      </Button>
    );
  }
  if (state === 'keeping') {
    return (
      <Button variant="outline" size="sm" disabled>
        <Loader2 data-icon="inline-start" className={cn('motion-safe:animate-spin')} />
        Keeping…
      </Button>
    );
  }
  return (
    // "No article" is a settled answer for automatic captures, never for this
    // button: an explicit ask is always allowed (link-extraction-keep.md).
    <Button
      variant="outline"
      size="sm"
      onClick={onKeep}
      aria-label={entitled ? undefined : `${label} — a ${PLAN_LABELS.plus} feature`}
    >
      <span data-icon="inline-start" className={cn('contents')}>
        {icon}
      </span>
      {state === 'failed' ? 'Try again' : label}
      {!entitled ? (
        <span className={cn('ml-1 text-xs text-muted-foreground')}>{PLAN_LABELS.plus}</span>
      ) : null}
    </Button>
  );
}

export function KeptCopies({
  linkId,
  extraction,
  readModeRequested,
}: {
  linkId: string;
  extraction: ExtractionItem | undefined;
  // Editor asked for read mode as part of this popup's save.
  readModeRequested: boolean;
}) {
  const { entitlements } = useEntitlements();
  const entitled = entitlements.keptCopies;

  // When this popup asked for each facet. A fresh save's read mode counts from the
  // first render, which is after Editor sent the message.
  const [requestedAt, setRequestedAt] = useState<
    Partial<Record<'readMode' | 'screenshot', number>>
  >(() => (readModeRequested && entitled ? { readMode: Date.now() - 1 } : {}));

  const [refused, setRefused] = useState<Partial<Record<'readMode' | 'screenshot', boolean>>>({});

  const readMode = stateOf(
    extraction?.facets.readMode,
    extraction?.readModeId,
    requestedAt.readMode,
    refused.readMode === true,
  );
  const screenshot = stateOf(
    extraction?.facets.screenshot,
    extraction?.screenshotId,
    requestedAt.screenshot,
    refused.screenshot === true,
  );

  const keep = (facet: 'readMode' | 'screenshot') => {
    if (!entitled) {
      void openWebApp('/settings/subscription');
      return;
    }
    setRequestedAt((prev) => ({ ...prev, [facet]: Date.now() }));
    setRefused((prev) => ({ ...prev, [facet]: false }));
    // The background answers once the capture has settled. What it stored — or the
    // `failed` it recorded — reaches this row through the live read; a refusal that
    // recorded nothing only through this answer.
    const refuse = () => setRefused((prev) => ({ ...prev, [facet]: true }));
    void sendMessage({ type: 'EXTRACT', linkId, facet }).then((res) => {
      if (!res.ok) refuse();
    }, refuse);
  };
  const read = () => void openWebApp(`/read?link=${encodeURIComponent(linkId)}`);

  return (
    <section aria-labelledby="kept-copies" className={cn('flex flex-col gap-2')}>
      <h2 id="kept-copies" className={cn('text-xs font-medium text-muted-foreground')}>
        Keep a copy
      </h2>
      <div className={cn('grid grid-cols-2 gap-2')}>
        <CopyButton
          icon={<BookOpen />}
          label="Read mode"
          state={readMode}
          entitled={entitled}
          onKeep={() => keep('readMode')}
          onRead={read}
        />
        <CopyButton
          icon={<ImageIcon />}
          label="Screenshot"
          state={screenshot}
          entitled={entitled}
          onKeep={() => keep('screenshot')}
          onRead={read}
        />
      </div>
      {readMode === 'noArticle' ? (
        <p className={cn('text-xs leading-5 text-muted-foreground')}>
          No article on this page to keep as text — a screenshot keeps how it looks.
        </p>
      ) : null}
      {readMode === 'failed' || screenshot === 'failed' ? (
        <p role="alert" className={cn('text-xs leading-5 text-muted-foreground')}>
          Couldn’t keep a copy. Stay on this page and try again.
        </p>
      ) : null}
    </section>
  );
}
