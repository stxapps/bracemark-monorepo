import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { CardContent, CardFooter, CardHeader, CardTitle } from '@stxapps/web-ui/components/ui/card';
import { cn } from '@stxapps/web-ui/lib/utils';

import { CardEyebrow, DogEaredCard, FocusedPage } from '@/components/focused-page';
import { SUPPORT_URL } from '@/lib/site';

export const metadata: Metadata = { title: 'Page not found' };

// The 404 for app.bracemark.com. bracemark-web is a static export, so this renders
// once at build time into `404.html` and CloudFront serves it for every path that
// doesn't exist (docs/hosting.md) — which means it must make sense to BOTH a
// signed-in user who mistyped a route and a signed-out stranger who followed a
// stale link. Hence one destination, `/links`, and nothing that assumes a session:
// AuthGuard turns that into /sign-in for a visitor who has none.
//
// The heading is sized up from CardTitle's default (`text-base font-medium`, the
// SECTION step — right for a settings card sitting among five others) to
// bracemark-web's page step, the same `text-xl font-semibold tracking-tight` the
// sign-in and settings pages use, because this card IS the entire page.
//
// NO GIANT NUMERAL, no apology, no joke. The status code is an annotation above
// the sentence (CardEyebrow), because "404" tells a person nothing they can act on
// and the reassurance below it is the only content on this screen that does.
export default function NotFound() {
  return (
    <FocusedPage>
      <DogEaredCard>
        <CardHeader>
          <CardEyebrow>Error 404</CardEyebrow>
          <CardTitle className={cn('text-xl font-semibold tracking-tight')}>
            That page isn’t here
          </CardTitle>
        </CardHeader>

        <CardContent>
          <p className={cn('text-sm leading-6 text-muted-foreground')}>
            The address may be mistyped, or it may point at something that has since been deleted.
            Nothing has happened to your library — it lives on this device.
          </p>
        </CardContent>

        <CardFooter>
          <Button asChild className={cn('w-full')}>
            <Link href="/links">Go to my links</Link>
          </Button>
        </CardFooter>
      </DogEaredCard>

      {/* The counterpart to the auth pages' encryption note, in the same slot and
          the same quiet step: one line under the card that says the thing the card
          itself shouldn't spend a paragraph on. Support lives on the marketing
          site, a DIFFERENT ORIGIN from this app, so it's an absolute env-configured
          URL and a plain <a> — a relative `/support` would resolve here and 404
          from the 404 page (lib/site.ts).

          `px-6` matches the card's inset so this line sits on the same text axis
          as the wordmark and the card's own content — see `(auth)/layout.tsx` for
          the argument, and keep the three copies level. */}
      <p className={cn('px-6 text-xs leading-5 text-balance text-muted-foreground')}>
        If a link inside Bracemark brought you here, that’s our bug, not yours —{' '}
        <a
          className={cn(
            'rounded-sm underline decoration-muted-foreground/40 underline-offset-2 transition-colors',
            'hover:text-foreground hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
          href={SUPPORT_URL}
          target="_blank"
          rel="noreferrer"
        >
          tell us about it
        </a>
        .
      </p>
    </FocusedPage>
  );
}
