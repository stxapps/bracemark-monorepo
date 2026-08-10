import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { Card } from '@stxapps/web-ui/components/ui/card';
import { cn } from '@stxapps/web-ui/lib/utils';

// The chrome-less surface, and the card that sits on it. Four screens use it and
// they are exactly the four bracemark-web renders with no sidebar: /sign-in and
// /create-account (through `(auth)/layout.tsx`), plus `app/not-found.tsx` and
// `app/error.tsx`.
//
// It lives in a component rather than in the auth layout — where the shape started
// — because the other two callers CAN'T be given a layout. `error.tsx` is the root
// error boundary: it replaces everything below `app/layout.tsx`, sidebar included,
// so whatever it renders is the whole page. `not-found.tsx` is the same story from
// the other direction. Sharing a component is the only way those two can't drift
// from the auth pages by a token here and a gap there.
//
// No 'use client': this is markup with no state, so it server-renders for the two
// static pages and simply gets pulled into the client bundle by error.tsx.

// The outer box owns the background, the height and the insets — and no padding of
// its own. `safe-area` and `px-4` are both plain `padding` declarations, so sharing
// an element would make the winner a stylesheet-order detail that class order in
// JSX can't settle; the numeric padding stays one level in (docs/safe-area.md,
// _applying safe area_). Insets are THIS surface's job now that bracemark-web has no
// blanket `.safe-area` div (inner-layout.tsx), and a blanket is the right shape
// here, unlike on the app frames: a centred column on a flat background, with no
// chrome reaching an edge.
//
// `min-h-dvh`, not `min-h-screen`: `100vh` is the viewport with a mobile browser's
// URL bar retracted, so it overstates the height actually on screen. These pages
// scroll, so it would only centre the column slightly low rather than hide
// anything — but there is no reason for one surface to measure the viewport
// differently from the rest of the app.
//
// The background is `--muted`/`--background`, NOT `bg-gray-50 dark:bg-gray-900`.
// Those are raw palette values: gray-900 is blue-tinted (#111827) and the card on
// top of it is neutral (`--card`, chroma 0), so the dark theme showed a
// warm-neutral card floating on a navy page. The tokens can't disagree that way.
// They need the explicit dark half because `--muted` INVERTS relative to `--card`
// between themes: light muted (0.97) is darker than the card (1.0), dark muted
// (0.269) is LIGHTER than the card (0.205), so reusing it in dark would sink the
// card into the page. In dark the page drops to `--background` instead and the
// card lifts off it.
//
// THE LOCKUP IS HERE FOR THE SAME REASON THE BROWSER EXTENSION'S POPUP HAS ONE.
// With no sidebar, these are the only places the app never says its own name, and
// each of them is reached by someone dropped mid-flow — from the marketing site's
// Get started, from the browser extension's "Create an account", from a bookmarked
// or mistyped app.bracemark.com URL, or from a screen that just broke under them.
// The tab title is otherwise the only thing identifying where they are. Same mark
// size, same wordmark step and same gap as the browser extension's OptionsShell,
// so the two lockups are one lockup rendered twice rather than two that drift.
export function FocusedPage({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn('flex min-h-dvh flex-col bg-muted safe-area dark:bg-background')}>
      <div className={cn('flex flex-1 flex-col items-center justify-center px-4 py-12')}>
        {/* `px-4` has to keep sitting OUTSIDE the `max-w-sm` column — moving it
            inside would cap the card at 352px instead of 384. */}
        <div className={cn('flex w-full max-w-sm flex-col gap-6')}>
          <div className={cn('flex items-center gap-2.5')}>
            <BracemarkIcon className={cn('h-5 w-auto shrink-0')} aria-hidden="true" />
            <span className={cn('text-[0.9375rem] leading-none font-semibold tracking-tight')}>
              Bracemark
            </span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

// The card, with the top-right corner taken off at 45° — the brand mark's own
// gesture (a page corner turned down to keep a place; see web-ui's
// bracemark-icon.tsx) performed at page scale. It is the one memorable thing on
// these screens, which is why everything around it stays plain: a sign-in box that
// reaches for more than one idea reads as a phishing page rather than a designed
// one, and an error screen that reaches for more than one reads as a joke at the
// reader's expense.
//
// SIZE. The mark cuts 11 of its 38 units (29%) and the browser extension's page
// tile cuts 12 of 44 (27%), but both of those are ~40px objects where the ratio IS
// the silhouette. On a 384px card the same ratio would be a 110px bevel — a shape,
// not a fold. 1.5rem is set against the card's own details instead: a step above
// the 1rem corner radius it sits beside, so it can't be misread as a heavier
// rounding, and level with the 1.5rem padding it aligns to.
//
// TWO ELEMENTS, because `clip-path` clips the ring off with everything else, so
// the hairline has to be a real filled layer underneath: the outer div is a 1px
// sheet of the card's ring colour, the Card is inset into it by that 1px, and both
// carry the same clip. `rounded-tr-none` on both is load-bearing — a 1rem radius
// under a 1.5rem cut leaves part of the arc outside the cut line, which lands as a
// nub on the diagonal rather than a clean corner.
//
// The shadow is a `filter`, not `shadow-*`, for the same clipping reason: a box
// shadow is painted outside the border box, so the clip erases it. `drop-shadow`
// traces the CLIPPED silhouette instead — the fold gets a shadow along its
// diagonal, which is what makes it read as a turned corner rather than a chipped
// one. It also carries the light theme, where a white card on `--muted` is a 3%
// step and the cut would otherwise be a hairline against near-identical fills.
// Deliberately weak (6%): the metaphor is a sheet of paper lying on a surface,
// not a floating dialog. In dark it lands on near-black and simply doesn't show,
// which is correct — there the card already separates by lightness.
export function DogEaredCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn('rounded-2xl rounded-tr-none bg-foreground/10 p-px')}
      style={{ clipPath: DOG_EAR, filter: 'drop-shadow(0 2px 8px rgb(0 0 0 / 0.06))' }}
    >
      <Card className={cn('rounded-tr-none ring-0')} style={{ clipPath: DOG_EAR }}>
        {children}
      </Card>
    </div>
  );
}

const DOG_EAR = 'polygon(0 0, calc(100% - 1.5rem) 0, 100% 1.5rem, 100% 100%, 0 100%)';

// The small label above a card title — "Error 404", "Something went wrong". Set at
// the caption step with wide tracking so it reads as an annotation on the card
// rather than a second heading competing with the one under it.
//
// bracemark-web has no accent token and no second typeface (the marketing site's
// mono eyebrow is a bracemark-site thing — it loads IBM Plex Mono, this app loads
// Inter and nothing else), so the distinction is carried by size, weight and
// tracking alone. That is also why there is no giant "404" numeral anywhere here:
// the number is a status code, not a headline, and the sentence under it is the
// part the reader can act on.
export function CardEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p
      className={cn('text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase')}
      data-slot="card-eyebrow"
    >
      {children}
    </p>
  );
}
