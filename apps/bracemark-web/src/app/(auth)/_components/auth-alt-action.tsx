import Link from 'next/link';

import { CardFooter } from '@stxapps/web-ui/components/ui/card';
import { cn } from '@stxapps/web-ui/lib/utils';

// The door to the OTHER auth page, docked at the bottom of the card. Both pages
// carry one, pointing at each other, and it lives here rather than being typed
// twice because the styling below is six utilities deep — the kind that drifts by
// one class per edit until the two pages no longer match.
//
// THE RULE IS DOING WORK, not decorating. On /sign-in this line lands directly
// under the form's own "Forgot your password? Use a recovery code", and the two
// are the same size, the same muted colour and both underlined — a stack of two
// look-alike links where one stays on this page and the other leaves it. The
// hairline says which is which: everything above it acts on the form you're
// looking at, the line below it goes somewhere else. Full-bleed (`-mx-6 px-6`, on
// CardHeader/Content/Footer's shared 1.5rem inset) so it reads as the card's own
// division rather than a short stroke floating in the padding.
//
// The link is `text-foreground` + underline rather than a colour: bracemark-web has
// no accent token, and in the light theme `--primary` is very nearly the body
// colour, so a "link" set in it reads as plain bold text with no affordance. The
// underline carries the affordance and the decoration colour carries the hover —
// faint at rest so the sentence stays a sentence, solid under the pointer.
export function AuthAltAction({
  prompt,
  href,
  action,
}: {
  // The question, e.g. "New to Bracemark?".
  prompt: string;
  href: string;
  // The link text. Name it exactly as the page it opens is titled, so the
  // destination is never a surprise.
  action: string;
}) {
  return (
    <CardFooter className={cn('-mx-6 border-t px-6 pt-6')}>
      <p className={cn('text-sm text-muted-foreground')}>
        {prompt}{' '}
        <Link
          href={href}
          className={cn(
            'rounded-sm font-medium text-foreground underline decoration-foreground/40 underline-offset-2 transition-colors',
            'hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          {action}
        </Link>
      </p>
    </CardFooter>
  );
}
