import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import { DOC_GROUPS } from '../content/docs';
import { ChevronGlyph } from './glyphs';

// The /docs sidebar: every page, grouped, in the manifest's order. The current
// page is marked with `aria-current` rather than by a client hook, because every
// page that renders this already knows its own slug — so the docs ship no
// JavaScript for navigation, the same stance as /faq's native <details>.
//
// Rendered twice and shown once: a sticky column on wide screens, and a native
// <details> above the page on narrow ones, where a sidebar would push the page
// itself below the fold. `display: none` takes the hidden copy out of the
// accessibility tree too, so a screen reader meets one list, not two.

function PageList({ current }: { current?: string }) {
  return (
    <div className={cn('space-y-6')}>
      {DOC_GROUPS.map((group) => (
        <div key={group.title}>
          <p className={cn('eyebrow')}>{group.title}</p>
          <ul className={cn('mt-3 space-y-1')}>
            {group.pages.map((page) => (
              <li key={page.slug}>
                <Link
                  href={`/docs/${page.slug}`}
                  aria-current={page.slug === current ? 'page' : undefined}
                  className={cn(
                    'inline-block rounded-sm py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none aria-[current=page]:font-medium aria-[current=page]:text-foreground',
                  )}
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function DocsNav({ current, className }: { current?: string; className?: string }) {
  return (
    <div className={className}>
      <details className={cn('group rounded-lg border border-border px-4 lg:hidden')}>
        <summary
          className={cn(
            'flex cursor-pointer list-none items-center justify-between gap-4 rounded-sm py-3 text-sm font-medium focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden',
          )}
        >
          All docs pages
          <ChevronGlyph
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180',
            )}
          />
        </summary>
        <div className={cn('pt-2 pb-4')}>
          <PageList current={current} />
        </div>
      </details>
      {/* Sticky on the <nav> itself: its parent is the grid item, stretched to the
          row's height, so it has room to stick. On a child of the <nav> it would
          stick inside a box exactly its own height, and scroll away with the page. */}
      <nav
        aria-label="Docs"
        className={cn(
          'hidden lg:sticky lg:top-28 lg:block lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:pr-3',
        )}
      >
        <Link
          href="/docs"
          className={cn(
            'inline-block rounded-sm text-sm font-medium focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          Docs
        </Link>
        <div className={cn('mt-6')}>
          <PageList current={current} />
        </div>
      </nav>
    </div>
  );
}
