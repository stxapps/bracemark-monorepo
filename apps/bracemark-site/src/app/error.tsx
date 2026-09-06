'use client';

import { useEffect } from 'react';
import Link from 'next/link';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { ArrowGlyph } from '../components/glyphs';
import { MailLink } from '../components/mail-link';
import { PageShell } from '../components/page-shell';
import { SUPPORT_EMAIL } from '../lib/site';

// The apex's error boundary. On a site this static it should almost never render
// — every page here is prerendered HTML with no data fetching — which is exactly
// why it exists: the failures it can catch are the weird ones (a half-downloaded
// chunk on a flaky connection, a hydration mismatch after a deploy), and those are
// the ones where a blank page would look like the site is gone.
//
// It keeps PageShell, so the header and footer stay put and the reader is
// demonstrably still on Bracemark. Retry first, because a chunk that failed once
// usually loads the second time; the app itself is the second door, since a
// visitor whose real destination is their library shouldn't be stuck here.
//
// No metadata export — a client component can't have one, and the root layout's
// default title covers it.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageShell
      eyebrow="Error"
      title="This page didn’t finish loading."
      lede="Something went wrong on the way here. It is usually a network hiccup rather than anything you did — trying again is the fix more often than not."
    >
      <div className={cn('flex flex-wrap items-center gap-3')}>
        <Button size="lg" onClick={() => reset()}>
          Try again
          <ArrowGlyph data-icon="inline-end" className={cn('size-4')} />
        </Button>
        <Button asChild size="lg" variant="ghost">
          <Link href="/">Go to the home page</Link>
        </Button>
      </div>

      {/* The digest is the only part of a production error that identifies it in a
          log, and mono is this site's instrument voice — machine output is
          literally what it is for (globals.css). The message is deliberately NOT
          printed: on a static marketing site it is either a minified framework
          string or nothing, so it would be noise dressed as information. */}
      {error.digest && (
        <p className={cn('mt-10 font-mono text-xs text-muted-foreground')}>
          Reference {error.digest}
        </p>
      )}

      <p className={cn('mt-4 text-body text-muted-foreground')}>
        If it keeps happening, tell us what you were opening:{' '}
        <MailLink address={SUPPORT_EMAIL} variant="specimen" />.
      </p>
    </PageShell>
  );
}
