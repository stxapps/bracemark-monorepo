import type { Metadata, ResolvingMetadata } from 'next';
import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import { PageShell } from '../../components/page-shell';
import { publishedBlogPosts } from '../../content/blog';
import { blogDate } from '../../lib/blog/metadata';
import { pageMetadata } from '../../lib/metadata';

const DESCRIPTION =
  'Product announcements, releases, and notes from the people building Bracemark.';

export function generateMetadata(_: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  return pageMetadata(parent, { title: 'Blog', description: DESCRIPTION, path: '/blog' });
}

export default function Page() {
  return (
    <PageShell eyebrow="Blog" title="What we shipped and learned." lede={DESCRIPTION}>
      <div className={cn('flex justify-end')}>
        <a
          href="/feed.xml"
          type="application/rss+xml"
          className={cn(
            'rounded-sm text-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          Subscribe with RSS
        </a>
      </div>
      <ol className={cn('mt-8 space-y-4')}>
        {publishedBlogPosts().map((post) => (
          <li key={post.slug}>
            <Link
              href={`/blog/${post.slug}`}
              className={cn(
                'block rounded-lg border border-border p-6 transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              )}
            >
              <time
                dateTime={post.publishedAt}
                className={cn('font-mono text-xs text-muted-foreground')}
              >
                {blogDate(post.publishedAt)}
              </time>
              <h2 className={cn('mt-2 font-display text-2xl font-semibold tracking-tight')}>
                {post.title}
              </h2>
              <p className={cn('mt-2 text-sm leading-6 text-muted-foreground')}>
                {post.description}
              </p>
            </Link>
          </li>
        ))}
      </ol>
    </PageShell>
  );
}
