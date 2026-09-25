import Link from 'next/link';
import { notFound } from 'next/navigation';

import { cn } from '@stxapps/web-ui/lib/utils';

import { DocsNav } from '../../../components/docs-nav';
import { MDX_COMPONENTS } from '../../../components/mdx-components';
import { DOC_PAGES, docNeighbours, findDoc } from '../../../content/docs';
import { docsMetadata } from '../../../lib/docs/metadata';
import { loadMdx } from '../../../lib/mdx/load';

// One /docs page. The page list, titles and descriptions are the manifest
// (content/docs/index.ts); the prose is `content/docs/<slug>.mdx`, compiled at
// build time by lib/mdx/load.ts. See docs/architecture.md, _the marketing site's
// `/docs`_.

// Every slug is known at build time and `output: 'export'` can't serve an unknown
// one anyway; this makes one a 404 in `next dev` too, instead of a read of a file
// that isn't there.
export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_PAGES.map((page) => ({ slug: page.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props) {
  const found = findDoc((await params).slug);
  if (!found) return {};
  const { title, description, slug } = found.page;
  return docsMetadata(title, description, `/docs/${slug}`);
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const found = findDoc(slug);
  if (!found) notFound();
  const { page, group } = found;
  const { Content, headings } = await loadMdx('docs', slug);
  const sections = headings.filter((heading) => heading.depth === 2);
  const { prev, next } = docNeighbours(slug);

  return (
    <div className={cn('pt-14 px-safe pb-4 md:pt-20')}>
      <div className={cn('mx-auto max-w-6xl px-4 md:px-6 lg:px-8')}>
        <div className={cn('grid gap-10 lg:grid-cols-12 lg:gap-16')}>
          <DocsNav current={slug} className={cn('lg:col-span-3')} />

          <article className={cn('min-w-0 lg:col-span-9 xl:col-span-7')}>
            <header>
              <p className={cn('eyebrow')}>{group.title}</p>
              <h1
                className={cn(
                  'mt-3 font-display text-4xl leading-[1.05] font-semibold tracking-tight text-balance md:text-5xl',
                )}
              >
                {page.title}
              </h1>
              {/* The meta description, printed. So it is copy a reader sees and a
                  review reads, never a sentence that exists only in <head>. */}
              <p className={cn('mt-5 text-lg leading-8 text-muted-foreground')}>
                {page.description}
              </p>
            </header>
            <div className={cn('mdx-prose mt-10 border-t border-border')}>
              <Content components={MDX_COMPONENTS} />
            </div>

            {(prev || next) && (
              <nav
                aria-label="Previous and next"
                className={cn('mt-16 grid gap-4 border-t border-border pt-8 sm:grid-cols-2')}
              >
                {prev && (
                  <Link
                    href={`/docs/${prev.slug}`}
                    className={cn(
                      'rounded-lg border border-border p-4 transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                    )}
                  >
                    <span className={cn('eyebrow block')}>Previous</span>
                    <span className={cn('mt-2 block font-medium')}>{prev.title}</span>
                  </Link>
                )}
                {next && (
                  <Link
                    href={`/docs/${next.slug}`}
                    className={cn(
                      'rounded-lg border border-border p-4 text-right transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:col-start-2',
                    )}
                  >
                    <span className={cn('eyebrow block')}>Next</span>
                    <span className={cn('mt-2 block font-medium')}>{next.title}</span>
                  </Link>
                )}
              </nav>
            )}
          </article>

          {/* "On this page" — the h2s, on screens wide enough for a third column.
              Narrower, the pages are short enough to scroll, and a list above the
              first paragraph would push the answer down to announce it. */}
          {sections.length > 1 && (
            <nav aria-label="On this page" className={cn('hidden xl:col-span-2 xl:block')}>
              <div className={cn('sticky top-28')}>
                <p className={cn('eyebrow')}>On this page</p>
                <ul className={cn('mt-3 space-y-1')}>
                  {sections.map((section) => (
                    <li key={section.id}>
                      <a
                        href={`#${section.id}`}
                        className={cn(
                          'inline-block rounded-sm py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                        )}
                      >
                        {section.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
