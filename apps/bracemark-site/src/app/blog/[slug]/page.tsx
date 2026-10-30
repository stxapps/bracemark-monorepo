import type { Metadata, ResolvingMetadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { cn } from '@stxapps/web-ui/lib/utils';

import { JsonLd } from '../../../components/json-ld';
import { MDX_COMPONENTS } from '../../../components/mdx-components';
import { PageShell } from '../../../components/page-shell';
import { BLOG_POSTS, findBlogPost } from '../../../content/blog';
import { blogDate, blogPostMetadata } from '../../../lib/blog/metadata';
import { loadMdx } from '../../../lib/mdx/load';
import { blogPosting } from '../../../lib/structured-data';

export const dynamicParams = false;

export function generateStaticParams() {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata(
  { params }: Props,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const post = findBlogPost((await params).slug);
  return post ? blogPostMetadata(parent, post) : {};
}

export default async function Page({ params }: Props) {
  const post = findBlogPost((await params).slug);
  if (!post) notFound();
  const { Content } = await loadMdx('blog', post.slug);

  return (
    <>
      <JsonLd data={blogPosting(post)} />
      <PageShell
        eyebrow="Blog"
        title={post.title}
        lede={post.description}
        width="document"
        meta={
          <>
            {'By Bracemark · '}
            <time dateTime={post.publishedAt}>{blogDate(post.publishedAt)}</time>
            {post.updatedAt && (
              <>
                {' · Updated '}
                <time dateTime={post.updatedAt}>{blogDate(post.updatedAt)}</time>
              </>
            )}
          </>
        }
      >
        <div className={cn('mdx-prose blog-prose [&>h2:first-child]:mt-0')}>
          <Content components={MDX_COMPONENTS} />
        </div>
        <Link
          href="/blog"
          className={cn(
            'mt-14 inline-block rounded-sm text-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          All posts
        </Link>
      </PageShell>
    </>
  );
}
