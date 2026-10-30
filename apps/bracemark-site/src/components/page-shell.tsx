import { cn } from '@stxapps/web-ui/lib/utils';

// The single-column wrapper every non-landing page uses. The landing page and
// /pricing opt out — one is a full-width hero, the other a card grid that needs
// the wider measure — which is why this is a component rather than a nested
// layout under a route group.
//
// The parts are all optional and all do one job:
//   eyebrow  names the document in the mono instrument voice ("Legal", "Help")
//   lede     the one sentence that says what the page is for, set larger
//   meta     the "Last updated" line the two policies carry
//
// `width` is the reading measure. A long document read top to bottom — the two
// legal documents, a blog post — becomes a wall at the 3xl measure a support page
// uses, so it gets the narrower `document` column.
export function PageShell({
  eyebrow,
  title,
  lede,
  meta,
  width = 'default',
  children,
}: {
  eyebrow?: string;
  title: string;
  lede?: React.ReactNode;
  meta?: React.ReactNode;
  width?: 'default' | 'document';
  children: React.ReactNode;
}) {
  // The <article> takes the safe inset and the inner div the numeric gutter,
  // because `px-safe` and `px-4` are the same two longhands and would fight by
  // stylesheet order on one element (docs/safe-area.md). This is the shell every
  // long document uses, so it is also what keeps the first character of each line
  // in /terms and /privacy out from under a landscape notch.
  return (
    <article className={cn('pt-14 px-safe pb-4 md:pt-20')}>
      <div className={cn('mx-auto px-4 md:px-6 lg:px-8')}>
        <header className={cn('mx-auto', width === 'document' ? 'max-w-2xl' : 'max-w-3xl')}>
          {eyebrow && <p className={cn('eyebrow')}>{eyebrow}</p>}
          <h1
            className={cn(
              'mt-3 font-display text-4xl leading-[1.05] font-semibold tracking-tight text-balance md:text-5xl',
            )}
          >
            {title}
          </h1>
          {lede && (
            <p className={cn('mt-5 max-w-2xl text-lg leading-8 text-muted-foreground')}>{lede}</p>
          )}
          {meta && <p className={cn('mt-6 font-mono text-xs text-muted-foreground')}>{meta}</p>}
        </header>
        <div
          className={cn(
            'mx-auto mt-12 border-t border-border pt-10',
            width === 'document' ? 'max-w-2xl' : 'max-w-3xl',
          )}
        >
          {children}
        </div>
      </div>
    </article>
  );
}
