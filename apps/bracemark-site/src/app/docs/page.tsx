import type { Metadata, ResolvingMetadata } from 'next';
import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import { PageShell } from '../../components/page-shell';
import { DOC_GROUPS } from '../../content/docs';
import { pageMetadata } from '../../lib/metadata';

export function generateMetadata(_: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  return pageMetadata(parent, {
    title: 'Docs',
    description:
      'Guides to using Bracemark, with the labels you’ll see on screen and the details that affect your links and account.',
    path: '/docs',
  });
}

// The /docs landing: the manifest's groups, each page with its description.
// The FAQ gives short answers; a docs page has room for the full explanation.

const link = cn(
  'rounded-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
);

export default function Page() {
  return (
    <PageShell
      eyebrow="Docs"
      title="Guides and answers."
      lede={
        <>
          Find the steps to use Bracemark and the details that affect your links and account. For a
          short answer to a common question, start with the{' '}
          <Link className={link} href="/faq">
            FAQ
          </Link>
          .
        </>
      }
    >
      <div className={cn('space-y-14')}>
        {DOC_GROUPS.map((group) => (
          <section key={group.title}>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              {group.title}
            </h2>
            <ul className={cn('mt-6 grid gap-4 sm:grid-cols-2')}>
              {group.pages.map((page) => (
                <li key={page.slug}>
                  <Link
                    href={`/docs/${page.slug}`}
                    className={cn(
                      'block h-full rounded-lg border border-border p-5 transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                    )}
                  >
                    <span className={cn('block font-medium')}>{page.title}</span>
                    <span className={cn('mt-2 block text-sm leading-6 text-muted-foreground')}>
                      {page.description}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
