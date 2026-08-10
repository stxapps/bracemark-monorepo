'use client';

import { useEffect } from 'react';
import Link from 'next/link';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { CardContent, CardFooter, CardHeader, CardTitle } from '@stxapps/web-ui/components/ui/card';
import { cn } from '@stxapps/web-ui/lib/utils';

import { CardEyebrow, DogEaredCard, FocusedPage } from '@/components/focused-page';
import { SUPPORT_URL } from '@/lib/site';

// The root error boundary. It sits at `app/`, so it replaces EVERYTHING below the
// root layout — sidebar, gates and all — for any error thrown in a route that
// doesn't carry a boundary of its own. That's why it renders the same chrome-less
// surface as the 404 and the auth pages (components/focused-page.tsx) rather than
// an in-page alert: there is no page left around it to sit in.
//
// It is a client component by requirement (Next passes `reset`), which also means
// the providers above it in inner-layout.tsx are still mounted — including
// ThemeProvider, so this screen honours the user's theme instead of flashing a
// white page at someone whose app is dark.
//
// TONE. An error screen is read by someone already annoyed, so it says what
// happened, what to try, and what is safe — in that order — and never apologises
// twice. The reassurance is not decoration: bracemark-web is local-first, so a
// render that blew up genuinely cannot have cost anyone a link, and that is the
// first thing a person wants to know.
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
    <FocusedPage>
      <DogEaredCard>
        <CardHeader>
          <CardEyebrow>Error</CardEyebrow>
          <CardTitle className={cn('text-xl font-semibold tracking-tight')}>
            This page stopped short
          </CardTitle>
        </CardHeader>

        <CardContent>
          <p className={cn('text-sm leading-6 text-muted-foreground')}>
            Something broke while the page was rendering. It’s most often a network hiccup — wait a
            moment, check your connection, then try again.
          </p>

          {/* The technical detail, kept visible rather than hidden behind a
              disclosure: it is what support will ask for, and a support request
              that starts with a copied message beats one that starts with "it
              said something about an error". Subdued and monospaced so it reads as
              a machine artefact the reader is allowed to ignore.

              `line-clamp-3` because a message can be a whole stack trace and this
              card is 384px wide — the digest, the part that identifies the failure
              in a log, sits OUTSIDE the clamp so it can never be the line that
              gets cut. In a production build Next replaces server-side messages
              with a generic string and leaves only the digest, so both halves are
              conditional. */}
          {(error.message || error.digest) && (
            <div className={cn('mt-4 rounded-lg bg-muted px-3 py-2.5')}>
              {error.message && (
                <p className={cn('line-clamp-3 font-mono text-xs leading-5 wrap-break-word')}>
                  {error.message}
                </p>
              )}
              {error.digest && (
                <p
                  className={cn(
                    'font-mono text-[0.6875rem] leading-5 text-muted-foreground',
                    error.message && 'mt-1',
                  )}
                >
                  digest {error.digest}
                </p>
              )}
            </div>
          )}
        </CardContent>

        {/* Two ways out, because `reset()` only re-renders this subtree: if the
            route itself is what's broken, retrying it forever is a trap, and the
            second button leaves. Retry keeps the primary weight — it's the one
            that costs nothing and usually works. */}
        <CardFooter className={cn('gap-2')}>
          <Button className={cn('flex-1')} onClick={() => reset()}>
            Try again
          </Button>
          <Button asChild variant="ghost" className={cn('flex-1')}>
            <Link href="/links">Go to my links</Link>
          </Button>
        </CardFooter>
      </DogEaredCard>

      {/* Same slot and same quiet step as the auth pages' encryption note and the
          404's. Support is on the marketing site — a DIFFERENT ORIGIN — so the URL
          is absolute and env-configured (lib/site.ts). */}
      <p className={cn('text-xs leading-5 text-balance text-muted-foreground')}>
        Your links are stored on this device and sync encrypted, so an error here can’t lose them.
        If it keeps happening,{' '}
        <a
          className={cn(
            'rounded-sm underline decoration-muted-foreground/40 underline-offset-2 transition-colors',
            'hover:text-foreground hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
          href={SUPPORT_URL}
          target="_blank"
          rel="noreferrer"
        >
          contact support
        </a>
        .
      </p>
    </FocusedPage>
  );
}
